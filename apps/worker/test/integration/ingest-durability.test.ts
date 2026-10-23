import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { commitIngest, stageEmail, type IngestJob } from "../../src/mail/ingest";
import {
  drainDeletionJobs,
  requestAliasPurge,
  requestMessageDeletion,
} from "../../src/db/deletions";
import { listInboundStagingCleanup } from "../../src/db/ingest";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
let DB: D1Database;
let BUCKET: R2Bucket;

beforeAll(async () => {
  bindings = await getTestBindings();
  DB = bindings.db;
  BUCKET = bindings.bucket;
});

afterAll(async () => {
  await bindings?.dispose();
});

beforeEach(async () => {
  await DB.prepare(`DROP TRIGGER IF EXISTS ingest_fail_message`).run();
  await DB.prepare(`DROP TRIGGER IF EXISTS ingest_fail_attachment`).run();
  await DB.prepare(`DROP TRIGGER IF EXISTS ingest_fail_core_final`).run();
  await DB.prepare(`DROP TRIGGER IF EXISTS ingest_fail_rule`).run();
  await DB.prepare(`DELETE FROM deletion_jobs`).run();
  await DB.prepare(`DELETE FROM inbound_staging_objects`).run();
  await DB.prepare(`DELETE FROM inbound_staging`).run();
  await DB.prepare(`DELETE FROM attachments`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  await DB.prepare(`DELETE FROM rules WHERE id LIKE 'ingest-test-%'`).run();
});

async function seedAlias(address: string): Promise<void> {
  const domainId = crypto.randomUUID();
  const [local, domain] = address.split("@");
  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
  )
    .bind(domainId, `zone-${domain}-${domainId.slice(0, 6)}`, domain)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status) VALUES (?1, ?2, ?3, ?4, 'ACTIVE')`,
  )
    .bind(crypto.randomUUID(), domainId, local, address)
    .run();
}

function message(
  to: string,
  date = "Fri, 19 Sep 2026 12:00:00 +0000",
  files: Array<{ name: string; body: string }> = [{ name: "proof.txt", body: "cHJvb2Y=" }],
): Parameters<typeof stageEmail>[0] {
  const parts = [
    `From: sender@example.net`,
    `To: ${to}`,
    "Subject: staged attachment",
    "Message-ID: <partial@example.net>",
    `Date: ${date}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="stage-boundary"',
    "",
    "--stage-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body to index after retry",
  ];
  for (const file of files) {
    parts.push(
      "--stage-boundary",
      `Content-Type: text/plain; name="${file.name}"`,
      `Content-Disposition: attachment; filename="${file.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      file.body,
    );
  }
  parts.push("--stage-boundary--", "");
  const bytes = new TextEncoder().encode(parts.join("\r\n"));
  return {
    from: "sender@example.net",
    to,
    headers: new Headers(),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
    setReject() {},
  };
}

async function stage(to: string, date?: string, files?: Array<{ name: string; body: string }>) {
  const result = await stageEmail(message(to, date, files), bindings.env, DB, BUCKET);
  if (result.status !== "staged") throw new Error("expected staged message");
  return result;
}

async function storedRow(job: IngestJob) {
  return DB.prepare(
    `SELECT id, received_at, header_date, raw_r2_key, parsed_r2_key, attachment_count, ingest_status
     FROM messages WHERE dedupe_key = ?1`,
  )
    .bind(job.dedupeKey)
    .first<{
      id: string;
      received_at: string;
      header_date: string | null;
      raw_r2_key: string;
      parsed_r2_key: string;
      attachment_count: number;
      ingest_status: string | null;
    }>();
}

async function expectComplete(
  job: IngestJob,
  status: "RULES_PENDING" | "SEMANTIC_PENDING" | "COMMITTED" = "COMMITTED",
  attachmentCount = 1,
) {
  const row = await storedRow(job);
  expect(row).toMatchObject({
    id: job.messageId,
    attachment_count: attachmentCount,
    ingest_status: status,
  });
  const parsedObject = await BUCKET.get(job.parsedKey);
  expect(parsedObject).not.toBeNull();
  const parsed = await parsedObject!.json<{ attachments: Array<{ id: string; r2Key: string }> }>();
  const attachments = await DB.prepare(`SELECT id, r2_key FROM attachments WHERE message_id = ?1`)
    .bind(job.messageId)
    .all<{ id: string; r2_key: string }>();
  expect(attachments.results).toEqual(
    parsed.attachments.map(({ id, r2Key }) => ({ id, r2_key: r2Key })),
  );
  expect(
    await DB.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`)
      .bind(job.messageId)
      .first<{ count: number }>(),
  ).toMatchObject({ count: 1 });
  expect(await BUCKET.get(row!.raw_r2_key)).not.toBeNull();
  expect(await BUCKET.get(row!.parsed_r2_key)).not.toBeNull();
  for (const attachment of parsed.attachments)
    expect(await BUCKET.get(attachment.r2Key)).not.toBeNull();
}

async function cleanup(job: IngestJob, keys: string[]): Promise<void> {
  await DB.prepare(`DELETE FROM attachments WHERE message_id = ?1`).bind(job.messageId).run();
  await DB.prepare(`DELETE FROM messages WHERE id = ?1`).bind(job.messageId).run();
  await DB.prepare(`DELETE FROM inbound_staging WHERE message_id = ?1`).bind(job.messageId).run();
  if (keys.length) await BUCKET.delete(keys);
}

function failBeforeFtsInsert(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) =>
          /INSERT\s+INTO\s+messages_fts/i.test(query)
            ? target.prepare(
                `INSERT INTO ingest_test_missing_fts (message_id, subject, preview, sender)
                 VALUES (?1,?2,?3,?4)`,
              )
            : target.prepare(query);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

describe("ingest durability on real Miniflare D1/R2", () => {
  it("settles a staging writer fenced before its first R2 PUT", async () => {
    const to = "fenced-before-put@durability.example";
    await seedAlias(to);
    const aliasId = await DB.prepare(`SELECT id FROM aliases WHERE address = ?1`)
      .bind(to)
      .first<string>("id");
    let puts = 0;
    let fenced = false;
    const db = new Proxy(DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            if (!fenced) {
              fenced = true;
              await requestAliasPurge(DB, aliasId!);
            }
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(BUCKET, {
      get(target, property) {
        if (property === "put")
          return async () => {
            puts += 1;
            throw new Error("unexpected_put");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await stageEmail(message(to), bindings.env, db, bucket)).toMatchObject({
      status: "duplicate",
    });
    expect(puts).toBe(0);
    expect(
      await DB.prepare(`SELECT writes_settled FROM inbound_staging WHERE alias_id = ?1`)
        .bind(aliasId)
        .first("writes_settled"),
    ).toBe(1);
    await drainDeletionJobs(bindings.env);
    expect(
      await DB.prepare(`SELECT state FROM deletion_jobs WHERE alias_id = ?1`)
        .bind(aliasId)
        .first("state"),
    ).toBe("DONE");
  });

  it("records every inbound object intent in D1 before the first R2 write", async () => {
    const to = "intent-before-r2@durability.example";
    await seedAlias(to);
    const expectedObjectCount = 4;
    let firstWriteHadIntent = false;
    let checked = false;
    const observedBucket = new Proxy(BUCKET, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (!checked) {
              checked = true;
              const intent = await DB.prepare(
                `SELECT s.message_id, s.state,
                        (SELECT COUNT(*) FROM inbound_staging_objects o WHERE o.message_id = s.message_id) AS object_count
                 FROM inbound_staging s
                 JOIN inbound_staging_objects o ON o.message_id = s.message_id
                 WHERE o.r2_key = ?1`,
              )
                .bind(args[0])
                .first<{ message_id: string; state: string; object_count: number }>();
              firstWriteHadIntent =
                intent?.state === "WRITING" && Number(intent.object_count) === expectedObjectCount;
            }
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const staged = await stageEmail(
      message(to, undefined, [
        { name: "one.txt", body: "b25l" },
        { name: "two.txt", body: "dHdv" },
      ]),
      bindings.env,
      DB,
      observedBucket,
    );
    try {
      expect(staged.status).toBe("staged");
      expect(firstWriteHadIntent).toBe(true);
      if (staged.status === "staged") {
        expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
        expect(
          await DB.prepare(`SELECT state FROM inbound_staging WHERE message_id = ?1`)
            .bind(staged.job.messageId)
            .first<{ state: string }>(),
        ).toMatchObject({ state: "COMMITTED" });
      }
    } finally {
      if (staged.status === "staged") await cleanup(staged.job, staged.keys);
    }
  });

  it("fences an expired writer and removes a put that lands after its first cleanup", async () => {
    const to = "late-r2-put@durability.example";
    await seedAlias(to);
    let enteredAttachment!: () => void;
    let releaseAttachment!: () => void;
    const attachmentEntered = new Promise<void>((resolve) => (enteredAttachment = resolve));
    const attachmentGate = new Promise<void>((resolve) => (releaseAttachment = resolve));
    const writtenKeys: string[] = [];
    let paused = false;
    const delayedBucket = new Proxy(BUCKET, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const key = args[0];
            writtenKeys.push(key);
            if (!paused && key.startsWith("attachments/")) {
              paused = true;
              enteredAttachment();
              await attachmentGate;
            }
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const pending = stageEmail(message(to), bindings.env, DB, delayedBucket);
    let manifestId: string | null = null;
    let manifestKeys: string[] = [];
    try {
      await attachmentEntered;
      const intent = await DB.prepare(
        `SELECT s.message_id FROM inbound_staging s
         JOIN inbound_staging_objects o ON o.message_id = s.message_id
         WHERE o.r2_key = ?1`,
      )
        .bind(writtenKeys.at(-1))
        .first<{ message_id: string }>();
      manifestId = intent?.message_id ?? null;
      if (manifestId) {
        await DB.prepare(
          `UPDATE inbound_staging SET lease_expires_at = ?2
           WHERE message_id = ?1`,
        )
          .bind(manifestId, new Date(Date.now() - 60_000).toISOString())
          .run();
        await DB.prepare(
          `UPDATE inbound_staging SET state = 'TOMBSTONED'
           WHERE message_id = ?1 AND state = 'WRITING' AND lease_expires_at <= ?2`,
        )
          .bind(manifestId, new Date().toISOString())
          .run();
        manifestKeys =
          (await listInboundStagingCleanup(DB, new Date().toISOString())).find(
            ({ messageId }) => messageId === manifestId,
          )?.objectKeys ?? [];
        await BUCKET.delete(manifestKeys);
      }
    } finally {
      releaseAttachment();
    }

    const staged = await pending;
    try {
      expect(manifestId).not.toBeNull();
      expect(staged.status).toBe("duplicate");
      expect(manifestKeys).toContain(writtenKeys.at(-1));
      for (const key of manifestKeys) expect(await BUCKET.get(key)).toBeNull();
      if (manifestId) {
        expect(
          await DB.prepare(`SELECT state FROM inbound_staging WHERE message_id = ?1`)
            .bind(manifestId)
            .first<{ state: string }>(),
        ).toMatchObject({ state: "TOMBSTONED" });
      }
    } finally {
      if (staged.status === "staged") await cleanup(staged.job, staged.keys);
      else if (manifestId) {
        await DB.prepare(`DELETE FROM inbound_staging WHERE message_id = ?1`)
          .bind(manifestId)
          .run();
        await BUCKET.delete(manifestKeys);
      }
      await BUCKET.delete(writtenKeys);
    }
  });

  it.each(["MESSAGE", "ALIAS_PURGE"])(
    "turns a %s tombstone into a fence and retains all in-flight keys for sweeping",
    async (kind) => {
      const to = "delete-during-r2@durability.example";
      await seedAlias(to);
      let enteredAttachment!: () => void;
      let releaseAttachment!: () => void;
      const attachmentEntered = new Promise<void>((resolve) => (enteredAttachment = resolve));
      const attachmentGate = new Promise<void>((resolve) => (releaseAttachment = resolve));
      const writtenKeys: string[] = [];
      let paused = false;
      const delayedBucket = new Proxy(BUCKET, {
        get(target, property) {
          if (property === "put") {
            return async (...args: Parameters<R2Bucket["put"]>) => {
              const key = args[0];
              writtenKeys.push(key);
              if (!paused && key.startsWith("attachments/")) {
                paused = true;
                enteredAttachment();
                await attachmentGate;
              }
              return target.put(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const pending = stageEmail(message(to), bindings.env, DB, delayedBucket);
      let intent: { message_id: string; dedupe_key: string } | null = null;
      let keys: string[] = [];
      try {
        await attachmentEntered;
        intent = await DB.prepare(
          `SELECT s.message_id, s.dedupe_key FROM inbound_staging s
         JOIN inbound_staging_objects o ON o.message_id = s.message_id
         WHERE o.r2_key = ?1`,
        )
          .bind(writtenKeys.at(-1))
          .first<{ message_id: string; dedupe_key: string }>();
        if (intent) {
          const stamp = new Date().toISOString();
          const aliasId = await DB.prepare(
            `SELECT alias_id FROM inbound_staging WHERE message_id = ?1`,
          )
            .bind(intent.message_id)
            .first<string>("alias_id");
          if (kind === "ALIAS_PURGE") await requestAliasPurge(DB, aliasId!);
          else
            await DB.prepare(
              `INSERT INTO deletion_jobs
             (id, job_type, message_id, dedupe_key, r2_keys_json, state, next_attempt_at, created_at, updated_at)
           VALUES (?1, 'MESSAGE', ?2, ?3, '[]', 'PENDING', ?4, ?4, ?4)`,
            )
              .bind(crypto.randomUUID(), intent.message_id, intent.dedupe_key, stamp)
              .run();
          await drainDeletionJobs(bindings.env);
          if (kind === "ALIAS_PURGE") {
            expect(
              await DB.prepare(`SELECT state FROM deletion_jobs WHERE alias_id = ?1`)
                .bind(aliasId)
                .first("state"),
            ).not.toBe("DONE");
          }
          const held = await DB.prepare(
            `SELECT COUNT(*) AS count FROM inbound_staging_objects WHERE message_id = ?1`,
          )
            .bind(intent.message_id)
            .first<{ count: number }>();
          expect(held?.count).toBeGreaterThan(0);
          expect(
            await listInboundStagingCleanup(DB).then((rows) =>
              rows.some(({ messageId }) => messageId === intent!.message_id),
            ),
          ).toBe(false);
        }
      } finally {
        releaseAttachment();
      }

      const staged = await pending;
      try {
        expect(intent).not.toBeNull();
        expect(staged.status).toBe("duplicate");
        if (intent) {
          expect(
            await DB.prepare(
              `SELECT state, writes_settled FROM inbound_staging WHERE message_id = ?1`,
            )
              .bind(intent.message_id)
              .first<{ state: string; writes_settled: number }>(),
          ).toMatchObject({ state: "TOMBSTONED", writes_settled: 1 });
          keys =
            (await listInboundStagingCleanup(DB)).find(
              ({ messageId }) => messageId === intent!.message_id,
            )?.objectKeys ?? [];
          expect(keys).toContain(writtenKeys.at(-1));
          await DB.prepare(`UPDATE inbound_staging SET next_sweep_at = ?1`)
            .bind("1970-01-01T00:00:00.000Z")
            .run();
          await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?1`)
            .bind("1970-01-01T00:00:00.000Z")
            .run();
          await drainDeletionJobs(bindings.env);
          for (const key of keys) expect(await BUCKET.get(key)).toBeNull();
          if (kind === "ALIAS_PURGE") {
            expect(
              await DB.prepare(
                `SELECT state FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'`,
              ).first("state"),
            ).toBe("DONE");
            expect(
              await commitIngest(
                {
                  v: 1,
                  messageId: intent.message_id,
                  dedupeKey: intent.dedupe_key,
                  domainId: "unused",
                  aliasId: (await DB.prepare(
                    `SELECT alias_id FROM inbound_staging WHERE message_id = ?1`,
                  )
                    .bind(intent.message_id)
                    .first<string>("alias_id"))!,
                  rawKey: "unused",
                  parsedKey: "unused",
                  envelopeFrom: "fixture@example.net",
                  envelopeTo: to,
                },
                DB,
                BUCKET,
              ),
            ).toEqual({ status: "duplicate" });
          }
        }
      } finally {
        if (staged.status === "staged") await cleanup(staged.job, staged.keys);
        if (intent)
          await DB.prepare(`DELETE FROM inbound_staging WHERE message_id = ?1`)
            .bind(intent.message_id)
            .run();
        await BUCKET.delete([...keys, ...writtenKeys]);
      }
    },
  );

  it.each([false, true])(
    "re-sweeps a retained tombstone after writer exit (delete failure: %s)",
    async (deleteFailure) => {
      const to = "crashed-writer-late-put@durability.example";
      await seedAlias(to);
      let releaseLatePut!: () => void;
      const latePutGate = new Promise<void>((resolve) => (releaseLatePut = resolve));
      let latePut: Promise<void> | undefined;
      let lateKey: string | undefined;
      const crashedBucket = new Proxy(BUCKET, {
        get(target, property) {
          if (property === "put") {
            return async (...args: Parameters<R2Bucket["put"]>) => {
              const key = args[0];
              if (key.startsWith("attachments/")) {
                lateKey = key;
                const remoteWrite = latePutGate.then(async () => {
                  await target.put(...args);
                });
                latePut = remoteWrite;
                void remoteWrite.catch(() => {});
                throw new Error("simulated_writer_exit_after_remote_put");
              }
              return target.put(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      let manifestId: string | undefined;
      let objectKeys: string[] = [];
      try {
        await expect(stageEmail(message(to), bindings.env, DB, crashedBucket)).rejects.toThrow(
          "simulated_writer_exit_after_remote_put",
        );
        const intent = await DB.prepare(
          `SELECT message_id FROM inbound_staging_objects WHERE r2_key = ?1`,
        )
          .bind(lateKey)
          .first<{ message_id: string }>();
        manifestId = intent?.message_id;
        expect(manifestId).toBeDefined();
        if (!manifestId) return;

        await DB.prepare(`UPDATE inbound_staging SET lease_expires_at = ?2 WHERE message_id = ?1`)
          .bind(manifestId, new Date(Date.now() - 60_000).toISOString())
          .run();
        const expired = (await listInboundStagingCleanup(DB)).find(
          ({ messageId }) => messageId === manifestId,
        );
        objectKeys = expired?.objectKeys ?? [];
        expect(objectKeys).toContain(lateKey);
        const aliasId = await DB.prepare(
          `SELECT alias_id FROM inbound_staging WHERE message_id = ?1`,
        )
          .bind(manifestId)
          .first<string>("alias_id");
        await requestAliasPurge(DB, aliasId!);
        const cleanupEnv = {
          ...bindings.env,
          MAIL_BUCKET: new Proxy(BUCKET, {
            get(target, property) {
              if (property === "delete" && deleteFailure)
                return async () => {
                  throw new Error("temporary_delete_failure");
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
        await drainDeletionJobs(cleanupEnv);

        releaseLatePut();
        await latePut;
        expect(await BUCKET.get(lateKey!)).not.toBeNull();
        const retry = (
          await listInboundStagingCleanup(
            DB,
            new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          )
        ).find(({ messageId }) => messageId === manifestId);
        expect(retry?.objectKeys).toContain(lateKey);
        await DB.prepare(`UPDATE inbound_staging SET next_sweep_at = ?2 WHERE message_id = ?1`)
          .bind(manifestId, "1970-01-01T00:00:00.000Z")
          .run();
        await drainDeletionJobs(bindings.env);
        expect(await BUCKET.get(lateKey!)).toBeNull();
        expect(
          await DB.prepare(
            `SELECT state FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE' AND alias_id = ?1`,
          )
            .bind(aliasId)
            .first("state"),
        ).not.toBe("DONE");
        expect(
          await DB.prepare(`SELECT cleanup_confirmed FROM inbound_staging WHERE message_id = ?1`)
            .bind(manifestId)
            .first("cleanup_confirmed"),
        ).toBe(0);
      } finally {
        releaseLatePut();
        await latePut?.catch(() => {});
        if (manifestId)
          await DB.prepare(`DELETE FROM inbound_staging WHERE message_id = ?1`)
            .bind(manifestId)
            .run();
        await BUCKET.delete(objectKeys);
        if (lateKey) await BUCKET.delete(lateKey);
      }
    },
  );

  it("retries a failure before message insertion with no durable row or lost staged objects", async () => {
    const to = "before@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_message BEFORE INSERT ON messages
       BEGIN SELECT RAISE(FAIL, 'injected_before_message_insert'); END`,
    ).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(
        "injected_before_message_insert",
      );
      expect(await storedRow(staged.job)).toBeNull();
      expect(await BUCKET.get(staged.job.rawKey)).not.toBeNull();
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_message`).run();
    }
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("recovers after message insert when an attachment statement fails inside the D1 batch", async () => {
    const to = "attachment@durability.example";
    await seedAlias(to);
    const staged = await stage(to, undefined, [
      { name: "proof1.txt", body: "b25l" },
      { name: "proof2.txt", body: "dHdv" },
    ]);
    const parsed = await (await BUCKET.get(staged.job.parsedKey))!.json<{
      attachments: Array<{ r2Key: string }>;
    }>();
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_attachment BEFORE INSERT ON attachments
       WHEN NEW.filename = 'proof2.txt'
       BEGIN SELECT RAISE(FAIL, 'injected_attachment_write'); END`,
    ).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(
        "injected_attachment_write",
      );
      expect(await storedRow(staged.job)).toMatchObject({
        id: staged.job.messageId,
        ingest_status: null,
      });
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(await BUCKET.get(staged.job.rawKey)).not.toBeNull();
      for (const attachment of parsed.attachments)
        expect(await BUCKET.get(attachment.r2Key)).not.toBeNull();
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_attachment`).run();
    }
    // Migration 0013 marks pre-existing rows committed; replay must still repair
    // a legacy partial row rather than trusting its lifecycle marker.
    await DB.prepare(`UPDATE messages SET ingest_status = 'COMMITTED' WHERE id = ?1`)
      .bind(staged.job.messageId)
      .run();
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job, "COMMITTED", 2);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("rolls back attachments and FTS when the final core-state write fails", async () => {
    const to = "fts@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_core_final BEFORE UPDATE OF ingest_status ON messages
       BEGIN SELECT RAISE(FAIL, 'injected_after_fts_before_rules'); END`,
    ).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(
        "injected_after_fts_before_rules",
      );
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(await BUCKET.get(staged.job.rawKey)).not.toBeNull();
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_core_final`).run();
    }
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("rolls back attachment rows when the real D1 batch fails at the FTS insert", async () => {
    const to = "fts-insert@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    try {
      await expect(commitIngest(staged.job, failBeforeFtsInsert(DB), BUCKET)).rejects.toThrow(
        "ingest_test_missing_fts",
      );
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`)
          .bind(staged.job.messageId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
      expect(await BUCKET.get(staged.job.rawKey)).not.toBeNull();
      expect(await storedRow(staged.job)).toMatchObject({
        id: staged.job.messageId,
        ingest_status: null,
      });

      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("acks a redelivery after durable deletion without reading R2 or recreating the row", async () => {
    const to = "deleted-retry@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      expect(await requestMessageDeletion(DB, staged.job.messageId)).toMatchObject({
        found: true,
        state: "PENDING",
      });

      const noCloudflareCredentials = {
        ...bindings.env,
        CLOUDFLARE_API_TOKEN: undefined,
        MAIL_WORKER_NAME: undefined,
      } as Env;
      await worker.scheduled(
        { cron: "* * * * *" } as never,
        noCloudflareCredentials,
        {} as ExecutionContext,
      );

      const deletion = await DB.prepare(
        `SELECT state FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1`,
      )
        .bind(staged.job.messageId)
        .first<{ state: string }>();
      expect(deletion).toEqual({ state: "DONE" });
      expect(await storedRow(staged.job)).toBeNull();
      for (const key of staged.keys) expect(await BUCKET.get(key)).toBeNull();

      let r2Reads = 0;
      const noReadBucket = new Proxy(BUCKET, {
        get(target, property) {
          if (property === "get") {
            return (key: string) => {
              r2Reads += 1;
              return target.get(key);
            };
          }
          if (property === "head") {
            return (key: string) => {
              r2Reads += 1;
              return target.head(key);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as R2Bucket;
      expect(await commitIngest(staged.job, DB, noReadBucket, noCloudflareCredentials)).toEqual({
        status: "duplicate",
      });
      expect(r2Reads).toBe(0);
      expect(await storedRow(staged.job)).toBeNull();

      await expect(
        DB.prepare(
          `INSERT INTO messages (id, domain_id, alias_id, dedupe_key, received_at, raw_r2_key)
           VALUES (?1,?2,?3,?4,?5,?6)`,
        )
          .bind(
            staged.job.messageId,
            staged.job.domainId,
            staged.job.aliasId,
            staged.job.dedupeKey,
            new Date().toISOString(),
            staged.job.rawKey,
          )
          .run(),
      ).rejects.toThrow("message_deletion_tombstoned");
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("retries after the core transaction commits but rule lookup fails", async () => {
    const to = "rules@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    await DB.prepare(`ALTER TABLE rules RENAME TO rules_hidden`).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(/rules/);
      await expectComplete(staged.job, "RULES_PENDING");
    } finally {
      await DB.prepare(`ALTER TABLE rules_hidden RENAME TO rules`).run();
    }
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("applies a matching rule and increments its hit once across a failed rule transaction", async () => {
    const to = "rulefail@durability.example";
    await seedAlias(to);
    const ruleId = "ingest-test-rule-failure";
    await DB.prepare(
      `INSERT INTO rules (id, enabled, match_json, action_json, hits, created_at)
       VALUES (?1, 1, '{"subjectContains":"staged"}', '{"archive":true}', 0, ?2)`,
    )
      .bind(ruleId, new Date().toISOString())
      .run();
    const staged = await stage(to);
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_rule BEFORE UPDATE OF hits ON rules
       BEGIN SELECT RAISE(FAIL, 'injected_rule_failure'); END`,
    ).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow("injected_rule_failure");
      await expectComplete(staged.job, "RULES_PENDING");
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_rule`).run();
    }
    try {
      expect((await commitIngest(staged.job, DB, BUCKET)).status).toBe("stored");
      expect(
        await DB.prepare(`SELECT hits FROM rules WHERE id = ?1`)
          .bind(ruleId)
          .first<{ hits: number }>(),
      ).toMatchObject({ hits: 1 });
      expect(
        await DB.prepare(`SELECT archived FROM messages WHERE id = ?1`)
          .bind(staged.job.messageId)
          .first<{ archived: number }>(),
      ).toMatchObject({ archived: 1 });
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("retries enabled semantic indexing without repeating core or rule effects", async () => {
    const to = "semantic@durability.example";
    await seedAlias(to);
    const ruleId = "ingest-test-semantic-rule";
    await DB.prepare(
      `INSERT INTO rules (id, enabled, match_json, action_json, hits, created_at)
       VALUES (?1, 1, '{"subjectContains":"staged"}', '{"archive":true}', 0, ?2)`,
    )
      .bind(ruleId, new Date().toISOString())
      .run();
    await DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('semanticSearch', 'on', ?1)`,
    )
      .bind(new Date().toISOString())
      .run();
    const staged = await stage(to);
    let fail = true;
    let vectorWrites = 0;
    const env = {
      ...bindings.env,
      AI: { run: async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] }) },
      VECTORIZE: {
        upsert: async () => {
          if (fail) throw new Error("injected_vectorize_failure");
          vectorWrites += 1;
          return { count: 1 };
        },
      },
    } as unknown as Env;
    try {
      await expect(commitIngest(staged.job, DB, BUCKET, env)).rejects.toThrow(
        "semantic_index_incomplete",
      );
      await expectComplete(staged.job, "SEMANTIC_PENDING");
      expect(
        await DB.prepare(`SELECT hits FROM rules WHERE id = ?1`)
          .bind(ruleId)
          .first<{ hits: number }>(),
      ).toMatchObject({ hits: 1 });
      fail = false;
      expect((await commitIngest(staged.job, DB, BUCKET, env)).status).toBe("stored");
      expect(vectorWrites).toBe(1);
      expect(
        await DB.prepare(`SELECT hits FROM rules WHERE id = ?1`)
          .bind(ruleId)
          .first<{ hits: number }>(),
      ).toMatchObject({ hits: 1 });
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
      await DB.prepare(`DELETE FROM app_settings WHERE key = 'semanticSearch'`).run();
    }
  });

  it("reconciles concurrent redelivery of the same canonical job", async () => {
    const to = "race@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    try {
      const results = await Promise.all([
        commitIngest(staged.job, DB, BUCKET),
        commitIngest(staged.job, DB, BUCKET),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["stored", "stored"]);
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE dedupe_key = ?1`)
          .bind(staged.job.dedupeKey)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 1 });
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("reuses canonical staged objects when the original queue job is redelivered", async () => {
    const to = "restage@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_attachment BEFORE INSERT ON attachments
       BEGIN SELECT RAISE(FAIL, 'injected_restaging_failure'); END`,
    ).run();
    try {
      await expect(commitIngest(staged.job, DB, BUCKET)).rejects.toThrow(
        "injected_restaging_failure",
      );
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_attachment`).run();
    }
    const redelivered = await stageEmail(message(to), bindings.env, DB, BUCKET);
    expect(redelivered.status).toBe("staged");
    if (redelivered.status !== "staged") return;
    try {
      expect(redelivered.job.messageId).toBe(staged.job.messageId);
      expect(redelivered.keys).toEqual([]);
      expect((await commitIngest(redelivered.job, DB, BUCKET)).status).toBe("stored");
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it("serializes two separately staged copies of a concurrent true duplicate", async () => {
    const to = "duplicate-race@durability.example";
    await seedAlias(to);
    const [first, second] = await Promise.all([
      stageEmail(message(to), bindings.env, DB, BUCKET),
      stageEmail(message(to), bindings.env, DB, BUCKET),
    ]);
    if (first.status !== "staged" || second.status !== "staged")
      throw new Error("expected two staged attempts");
    const stagedById = new Map([
      [first.job.messageId, first],
      [second.job.messageId, second],
    ]);
    try {
      const attempts = await Promise.allSettled([
        commitIngest(first.job, DB, BUCKET),
        commitIngest(second.job, DB, BUCKET),
      ]);
      const row = await storedRow(first.job);
      expect(row).not.toBeNull();
      expect(row?.ingest_status).toBe("COMMITTED");
      const canonical = stagedById.get(row!.id)!;
      const duplicate = canonical.job.messageId === first.job.messageId ? second : first;
      await expectComplete(canonical.job);
      const retried = await commitIngest(duplicate.job, DB, BUCKET);
      expect(retried.status).toBe("duplicate");
      expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
      for (const key of duplicate.keys) expect(await BUCKET.get(key)).toBeNull();
      expect(
        await DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE dedupe_key = ?1`)
          .bind(first.job.dedupeKey)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 1 });
    } finally {
      await cleanup(first.job, first.keys);
      await cleanup(second.job, second.keys);
    }
  });

  it("does not delete canonical objects on same-job replay and only cleans a completed true duplicate", async () => {
    const to = "duplicate@durability.example";
    await seedAlias(to);
    const raw = message(to);
    const [first, second] = await Promise.all([
      stageEmail(message(to), bindings.env, DB, BUCKET),
      stageEmail(raw, bindings.env, DB, BUCKET),
    ]);
    if (first.status !== "staged" || second.status !== "staged")
      throw new Error("expected both jobs staged");
    try {
      expect((await commitIngest(first.job, DB, BUCKET)).status).toBe("stored");
      expect((await commitIngest(first.job, DB, BUCKET)).status).toBe("duplicate");
      expect((await commitIngest(second.job, DB, BUCKET)).status).toBe("duplicate");
      await expectComplete(first.job);
      if (second.job.messageId !== first.job.messageId) {
        expect(await BUCKET.get(second.job.rawKey)).toBeNull();
      }
    } finally {
      await cleanup(first.job, first.keys);
      if (second.job.messageId !== first.job.messageId) await BUCKET.delete(second.keys);
    }
  });

  it("requeues a partially committed same job through the actual queue consumer", async () => {
    const to = "queue@durability.example";
    await seedAlias(to);
    const staged = await stage(to);
    await DB.prepare(
      `CREATE TRIGGER ingest_fail_attachment BEFORE INSERT ON attachments
       BEGIN SELECT RAISE(FAIL, 'injected_queue_attachment_failure'); END`,
    ).run();
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const makeBatch = () => {
      const decisions: string[] = [];
      const batch = {
        queue: "mail-ingest",
        messages: [
          {
            id: "ingest-test",
            timestamp: new Date(),
            attempts: 1,
            ackTimeoutMs: 30_000,
            body: staged.job,
            ack: () => void decisions.push("ack"),
            retry: () => void decisions.push("retry"),
            respond: async () => undefined,
          },
        ],
        decisions,
        ackAll: () => undefined,
        retryAll: () => undefined,
      };
      return batch;
    };
    try {
      const first = makeBatch();
      await worker.queue(first as never, bindings.env, ctx);
      expect(first.decisions).toEqual(["retry"]);
      expect(await storedRow(staged.job)).toMatchObject({
        id: staged.job.messageId,
        ingest_status: null,
      });
      expect(await BUCKET.get(staged.job.rawKey)).not.toBeNull();
    } finally {
      await DB.prepare(`DROP TRIGGER ingest_fail_attachment`).run();
    }
    try {
      const retry = makeBatch();
      await worker.queue(retry as never, bindings.env, ctx);
      expect(retry.decisions).toEqual(["ack"]);
      await expectComplete(staged.job);
    } finally {
      await cleanup(staged.job, staged.keys);
    }
  });

  it.each([
    ["1970", "Thu, 01 Jan 1970 00:00:00 +0000", "1970-01-01T00:00:00.000Z"],
    ["2099", "Fri, 31 Dec 2099 23:59:59 +0000", "2099-12-31T23:59:59.000Z"],
    ["invalid", "not a real date", null],
    ["timezone extremes", "Fri, 01 Jan 2021 00:00:00 -1200", "2021-01-01T12:00:00.000Z"],
    ["timezone extremes", "Fri, 01 Jan 2021 23:59:59 +1400", "2021-01-01T09:59:59.000Z"],
  ])(
    "keeps %s sender dates out of receiver ordering and raw-key partitions",
    async (_name, date, headerDate) => {
      const to = "clock@durability.example";
      await seedAlias(to);
      const arrivedBefore = Date.now();
      const staged = await stage(to, date);
      try {
        await commitIngest(staged.job, DB, BUCKET);
        const row = await storedRow(staged.job);
        const receivedAt = Date.parse(row?.received_at ?? "");
        expect(receivedAt).toBeGreaterThanOrEqual(arrivedBefore - 1000);
        expect(receivedAt).toBeLessThanOrEqual(Date.now() + 1000);
        expect(row?.header_date ?? null).toBe(headerDate);
        const [, , , year, month] = staged.job.rawKey.split("/");
        const received = new Date(row!.received_at);
        expect(year).toBe(String(received.getUTCFullYear()).padStart(4, "0"));
        expect(month).toBe(String(received.getUTCMonth() + 1).padStart(2, "0"));
      } finally {
        await cleanup(staged.job, staged.keys);
      }
    },
  );
});
