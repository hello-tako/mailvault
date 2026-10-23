import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendOutbound, type OutboundRequest } from "../../src/mail/send";
import {
  drainDeletionJobs,
  requestAliasPurge,
  requestMessageDeletion,
} from "../../src/db/deletions";
import { getTestBindings, type TestBindings } from "./_mf";

let b: TestBindings;
let sends: number;
const request = (key = crypto.randomUUID()): OutboundRequest & { idempotencyKey: string } => ({
  idempotencyKey: key,
  fromAddress: "owner@durability.example",
  to: ["recipient@example.net"],
  subject: "Durability fixture",
  text: "Synthetic test content",
  attachments: [{ filename: "fixture.txt", type: "text/plain", content: btoa("fixture") }],
});
const provider = () =>
  ({
    send: async () => {
      sends++;
      return { messageId: "accepted@example.net" };
    },
  }) as unknown as SendEmail;

beforeAll(async () => {
  b = await getTestBindings();
});
afterAll(async () => {
  await b.dispose();
});
beforeEach(async () => {
  sends = 0;
  await b.db.prepare("DELETE FROM deletion_jobs").run();
  if (await b.db.prepare("SELECT 1 FROM sqlite_master WHERE name='outbound_jobs'").first()) {
    await b.db.prepare("DELETE FROM outbound_jobs").run();
  }
  await b.db.prepare("DELETE FROM outbound_staging").run();
  await b.db.prepare("DELETE FROM messages").run();
  await b.db.prepare("DELETE FROM messages_fts").run();
  await b.db.prepare("DELETE FROM aliases").run();
  await b.db.prepare("DELETE FROM domains").run();
  const objects = await b.bucket.list();
  if (objects.objects.length) await b.bucket.delete(objects.objects.map((o) => o.key));
  await b.db
    .prepare(
      "INSERT INTO domains(id,cloudflare_zone_id,name,zone_status,zone_type,mail_status,sending_status) VALUES('durability','zone','durability.example','active','full','READY','ENABLED')",
    )
    .run();
  await b.db
    .prepare(
      "INSERT INTO aliases(id,domain_id,local_part,address) VALUES('durability-alias','durability','owner','owner@durability.example')",
    )
    .run();
  b.env.EMAIL = provider();
  b.env.MAX_SENDS_PER_DAY = "1000";
});

function failBatchOnce(pattern: RegExp): D1Database {
  let fail = true;
  const sqlByStatement = new WeakMap<object, string>();
  return new Proxy(b.db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          sqlByStatement.set(statement, sql);
          return new Proxy(statement, {
            get(stmt, name) {
              if (name === "bind")
                return (...values: unknown[]) => {
                  const bound = stmt.bind(...values);
                  sqlByStatement.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(stmt, name);
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        };
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (fail && statements.some((s) => pattern.test(sqlByStatement.get(s) ?? ""))) {
            fail = false;
            throw new Error("injected D1 boundary failure");
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function assertComplete() {
  const { results } = await b.db
    .prepare("SELECT * FROM messages WHERE direction='OUT'")
    .all<{ id: string; raw_r2_key: string; parsed_r2_key: string }>();
  expect(results).toHaveLength(1);
  const row = results![0]!;
  expect(await b.bucket.head(row.raw_r2_key)).not.toBeNull();
  expect(await b.bucket.head(row.parsed_r2_key)).not.toBeNull();
  const attachments = await b.db
    .prepare("SELECT r2_key FROM attachments WHERE message_id=?1")
    .bind(row.id)
    .all<{ r2_key: string }>();
  expect(attachments.results).toHaveLength(1);
  expect(await b.bucket.head(attachments.results![0]!.r2_key)).not.toBeNull();
  expect((await b.bucket.list()).objects).toHaveLength(3);
  expect(
    await b.db
      .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id=?1")
      .bind(row.id)
      .first("n"),
  ).toBe(1);
  expect(
    await b.db
      .prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE message_id=?1")
      .bind(row.id)
      .first("n"),
  ).toBe(1);
}

async function drainAliasPurge(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await b.db
      .prepare(
        "UPDATE deletion_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE state='PENDING'",
      )
      .run();
    await drainDeletionJobs(b.env);
    const state = await b.db
      .prepare("SELECT state FROM deletion_jobs WHERE job_type='ALIAS_PURGE'")
      .first<string>("state");
    if (state === "DONE") return;
  }
  throw new Error("Alias purge did not finish");
}

describe("outbound durable idempotency", () => {
  it("does not dispatch when alias purge starts before the staging row exists", async () => {
    let intercepted = false;
    const bucket = new Proxy(b.bucket, {
      get(target, prop) {
        if (prop === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (!intercepted) {
              intercepted = true;
              await requestAliasPurge(b.db, "durability-alias");
            }
            return target.put(...args);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await sendOutbound(request(), b.env, b.db, bucket).catch(() => undefined);
    expect(intercepted).toBe(true);
    expect(sends).toBe(0);
    await drainAliasPurge();
    expect((await b.bucket.list()).objects).toHaveLength(0);
  });

  it.each(["message", "alias"])(
    "does not dispatch mail during %s deletion while staging",
    async (kind) => {
      const sqls = new WeakMap<D1PreparedStatement, string>();
      let intercepted = false;
      const db = new Proxy(b.db, {
        get(target, prop) {
          if (prop === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              return new Proxy(statement, {
                get(stmt, name) {
                  if (name === "bind")
                    return (...values: unknown[]) => {
                      const bound = stmt.bind(...values);
                      sqls.set(bound, sql);
                      return bound;
                    };
                  const value = Reflect.get(stmt, name);
                  return typeof value === "function" ? value.bind(stmt) : value;
                },
              });
            };
          if (prop === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (statements.some((s) => /state='DISPATCHING'/.test(sqls.get(s) ?? ""))) {
                intercepted = true;
                if (kind === "alias") await requestAliasPurge(target, "durability-alias");
                else {
                  const id = await target
                    .prepare("SELECT id FROM messages WHERE direction='OUT'")
                    .first<string>("id");
                  await requestMessageDeletion(target, id!);
                }
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await sendOutbound(request(), b.env, db, b.bucket).catch(() => undefined);
      expect(intercepted).toBe(true);
      expect(await b.db.prepare("SELECT COUNT(*) AS n FROM deletion_jobs").first("n")).toBe(1);
      expect(sends).toBe(0);
    },
  );

  it("replays the same accepted request without sending a second message", async () => {
    const req = request();
    const first = await sendOutbound(req, b.env, b.db, b.bucket);
    const second = await sendOutbound(req, b.env, b.db, b.bucket);
    expect(second).toEqual(first);
    expect(sends).toBe(1);
    await assertComplete();
  });

  it("repairs partial R2 staging with no orphaned attempt", async () => {
    const req = request();
    let puts = 0;
    const bucket = new Proxy(b.bucket, {
      get(target, prop) {
        if (prop === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (++puts === 2) throw new Error("injected attachment storage failure");
            return target.put(...args);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(sendOutbound(req, b.env, b.db, bucket)).rejects.toThrow("injected");
    expect(sends).toBe(0);
    expect((await sendOutbound(req, b.env, b.db, b.bucket)).ok).toBe(true);
    await assertComplete();
  });

  it("deletes every staged object after a metadata batch fails under a deletion request", async () => {
    const req = request();
    const sqlByStatement = new WeakMap<object, string>();
    let reachedAttachmentBatch!: () => void;
    let resumeAttachmentBatch!: () => void;
    const atAttachmentBatch = new Promise<void>((resolve) => (reachedAttachmentBatch = resolve));
    const resume = new Promise<void>((resolve) => (resumeAttachmentBatch = resolve));
    let intercepted = false;
    const db = new Proxy(b.db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            sqlByStatement.set(statement, sql);
            return new Proxy(statement, {
              get(inner, name) {
                if (name === "bind")
                  return (...values: unknown[]) => {
                    const bound = inner.bind(...values);
                    sqlByStatement.set(bound, sql);
                    return bound;
                  };
                const value = Reflect.get(inner, name, inner);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (
              !intercepted &&
              statements.some((statement) =>
                /INSERT INTO attachments/.test(sqlByStatement.get(statement) ?? ""),
              )
            ) {
              intercepted = true;
              reachedAttachmentBatch();
              await resume;
              throw new Error("injected attachment metadata failure");
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const sending = sendOutbound(req, b.env, db, b.bucket);
    await atAttachmentBatch;
    const messageId = await b.db
      .prepare("SELECT id FROM messages WHERE direction='OUT'")
      .first<string>("id");
    expect(messageId).toBeTruthy();
    expect(await requestMessageDeletion(b.db, messageId!)).toMatchObject({ found: true });
    const firstDrain = await drainDeletionJobs(b.env);
    const stagedBeforeResume = (await b.bucket.list()).objects;
    resumeAttachmentBatch();
    await expect(sending).rejects.toThrow("injected attachment metadata failure");
    expect(firstDrain).toMatchObject({ deferred: 1 });
    expect(stagedBeforeResume).toHaveLength(3);
    await b.db
      .prepare(
        "UPDATE deletion_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE state='PENDING'",
      )
      .run();
    expect(await drainDeletionJobs(b.env)).toMatchObject({ completed: 1 });
    expect((await b.bucket.list()).objects).toHaveLength(0);
    expect(
      await b.db.prepare("SELECT 1 FROM messages WHERE id=?1").bind(messageId).first(),
    ).toBeNull();
    expect(
      await b.db
        .prepare("SELECT 1 FROM outbound_staging WHERE message_id=?1")
        .bind(messageId)
        .first(),
    ).toBeNull();
  });

  it("does not mark a message deleted while an expired R2 put is still unconfirmed", async () => {
    const req = request();
    await expect(
      sendOutbound(req, b.env, failBatchOnce(/INSERT INTO attachments/), b.bucket),
    ).rejects.toThrow("injected D1 boundary failure");
    const messageId = await b.db
      .prepare("SELECT id FROM messages WHERE direction='OUT'")
      .first<string>("id");
    await b.db
      .prepare("UPDATE outbound_staging SET writes_settled=0, uncertain=1 WHERE message_id=?1")
      .bind(messageId)
      .run();
    await requestMessageDeletion(b.db, messageId!);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await b.db
        .prepare(
          "UPDATE deletion_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE state='PENDING'",
        )
        .run();
      await drainDeletionJobs(b.env);
    }
    const job = await b.db
      .prepare("SELECT state, error_code FROM deletion_jobs WHERE message_id=?1")
      .bind(messageId)
      .first<{ state: string; error_code: string }>();
    expect(job).toEqual({ state: "FAILED", error_code: "OUTBOUND_STAGE_UNCERTAIN" });
    expect((await b.bucket.list()).objects).toHaveLength(3);
    expect(
      await b.db.prepare("SELECT 1 FROM messages WHERE id=?1").bind(messageId).first(),
    ).not.toBeNull();
  });

  it.each([
    /INSERT INTO attachments/,
    /INSERT INTO messages_fts/,
    /INSERT INTO message_recipients/,
  ])("reconciles a D1 failure at %s before provider send", async (pattern) => {
    const req = request();
    await expect(sendOutbound(req, b.env, failBatchOnce(pattern), b.bucket)).rejects.toThrow(
      "injected",
    );
    expect(sends).toBe(0);
    expect((await sendOutbound(req, b.env, b.db, b.bucket)).ok).toBe(true);
    expect(sends).toBe(1);
    await assertComplete();
  });

  it("never redispatches after provider acceptance and a failed local receipt update", async () => {
    const req = request();
    let failed = false;
    const db = new Proxy(b.db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (/UPDATE messages SET provider_message_id/.test(sql) && !failed) {
              return {
                bind: () => ({
                  run: async () => {
                    failed = true;
                    throw new Error("injected receipt failure");
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await sendOutbound(req, b.env, db, b.bucket).catch(() => undefined);
    await sendOutbound(req, b.env, b.db, b.bucket);
    expect(sends).toBe(1);
    await assertComplete();
  });

  it("serializes concurrent requests with the same key", async () => {
    const req = request();
    await Promise.all([
      sendOutbound(req, b.env, b.db, b.bucket),
      sendOutbound(req, b.env, b.db, b.bucket),
    ]);
    expect(sends).toBe(1);
    await assertComplete();
  });

  it("does not charge known provider rejections against the accepted-send quota", async () => {
    b.env.MAX_SENDS_PER_DAY = "1";
    b.env.EMAIL = {
      send: async () => ({
        error: Object.assign(new Error("Synthetic provider refusal"), {
          code: "E_RECIPIENT_SUPPRESSED",
        }),
      }),
    } as unknown as SendEmail;
    expect((await sendOutbound(request(), b.env, b.db, b.bucket)).ok).toBe(false);
    b.env.EMAIL = provider();
    expect((await sendOutbound(request(), b.env, b.db, b.bucket)).ok).toBe(true);
  });
  it("does not restore the daily budget by deleting accepted mail", async () => {
    b.env.MAX_SENDS_PER_DAY = "1";
    expect((await sendOutbound(request(), b.env, b.db, b.bucket)).ok).toBe(true);
    await b.db.prepare("DELETE FROM messages").run();
    await b.db.prepare("UPDATE outbound_jobs SET state='DELETED',provider_message_id=NULL").run();
    const second = await sendOutbound(request(), b.env, b.db, b.bucket);
    expect(second).toMatchObject({ ok: false, code: "DAILY_LIMIT" });
    expect(sends).toBe(1);
  });
});
