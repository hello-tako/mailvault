import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import {
  drainDeletionJobs,
  isMessageDeletionTombstoned,
  requestAliasPurge,
  requestMessageDeletion,
  requestMessagesDeletion,
} from "../../src/db/deletions";
import worker from "../../src/index";
import { commitIngest, type IngestJob } from "../../src/mail/ingest";
import { newGrant } from "../../src/db/security";
import { nowIso } from "../../src/lib/util";
import { getTestBindings, type TestBindings } from "./_mf";

let bindings: TestBindings;
let TEST_ENV: Env;
let DB: D1Database;
let BUCKET: R2Bucket;

const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const mutationHeaders = {
  origin: "http://localhost",
  "x-mailvault": "1",
  "content-type": "application/json",
};

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers({
    origin: "http://localhost",
    ...(init.headers as Record<string, string> | undefined),
  });
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function grantHeader(): Promise<Record<string, string>> {
  const grant = await newGrant(DB, 60_000);
  return { "x-mailvault-stepup": grant.token };
}

async function seedMail() {
  const domainId = crypto.randomUUID();
  const zoneId = `zone-${domainId}`;
  const aliasId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const dedupeKey = `dedupe-${messageId}`;
  const attachmentId = crypto.randomUUID();
  const extraAttachmentId = crypto.randomUUID();
  const indexedAt = new Date().toISOString();
  const keys = {
    raw: `raw/lifecycle/${messageId}.eml`,
    parsed: `parsed/${messageId}.json`,
    attachment: `attachments/${messageId}/${attachmentId}-evidence.txt`,
    extraAttachment: `attachments/${messageId}/${extraAttachmentId}-second.txt`,
  };

  await DB.prepare(
    `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
     VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
  )
    .bind(domainId, zoneId, `${domainId}.example`)
    .run();
  await DB.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, address, status)
     VALUES (?1, ?2, 'history', ?3, 'ACTIVE')`,
  )
    .bind(aliasId, domainId, `history@${domainId}.example`)
    .run();
  await DB.prepare(
    `INSERT INTO messages (
       id, domain_id, alias_id, dedupe_key, envelope_to, header_from, subject, preview,
       received_at, raw_size, raw_r2_key, parsed_r2_key, has_attachments, attachment_count, embedded_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 1, ?13)`,
  )
    .bind(
      messageId,
      domainId,
      aliasId,
      dedupeKey,
      `history@${domainId}.example`,
      "sender@example.net",
      "Preserved evidence",
      "historic lifecycle body",
      indexedAt,
      22,
      keys.raw,
      keys.parsed,
      indexedAt,
    )
    .run();
  await DB.prepare(
    `INSERT INTO attachments (id, message_id, filename, safe_filename, content_type, size, r2_key)
     VALUES (?1, ?2, 'evidence.txt', 'evidence.txt', 'text/plain', 8, ?3)`,
  )
    .bind(attachmentId, messageId, keys.attachment)
    .run();
  await DB.prepare(
    `INSERT INTO attachments (id, message_id, filename, safe_filename, content_type, size, r2_key)
     VALUES (?1, ?2, 'second.txt', 'second.txt', 'text/plain', 6, ?3)`,
  )
    .bind(extraAttachmentId, messageId, keys.extraAttachment)
    .run();
  await DB.prepare(
    `INSERT INTO messages_fts (message_id, subject, preview, sender) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(messageId, "Preserved evidence", "historic lifecycle body", "sender@example.net")
    .run();
  await BUCKET.put(keys.raw, "raw message bytes");
  await BUCKET.put(keys.parsed, JSON.stringify({ text: "historic lifecycle body", html: null }));
  await BUCKET.put(keys.attachment, "evidence");
  await BUCKET.put(keys.extraAttachment, "second");

  return {
    domainId,
    zoneId,
    aliasId,
    messageId,
    dedupeKey,
    attachmentId,
    extraAttachmentId,
    indexedAt,
    keys,
  };
}

function bucketWithDeleteFailures(
  failedKeys: string[],
  shouldFail: () => boolean = () => true,
): R2Bucket {
  const failed = new Set(failedKeys);
  return new Proxy(BUCKET, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "delete") {
        return async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          if (shouldFail() && list.some((key) => failed.has(key)))
            throw new Error("temporary R2 failure");
          return (value as (keys: string | string[]) => Promise<void>).call(target, keys);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function dbWithBindLimit(db: D1Database, limit: number, observed: number[]): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  observed.push(values.length);
                  if (values.length > limit) throw new Error("D1 bind limit exceeded");
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name, inner) as unknown;
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function readDeletionJob(messageId: string) {
  const table = await DB.prepare(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'deletion_jobs'`,
  ).first<{ present: number }>();
  if (!table) return null;
  return DB.prepare(
    `SELECT id, message_id, dedupe_key, r2_keys_json, vector_id, state, attempts, error_code
     FROM deletion_jobs WHERE message_id = ?1`,
  )
    .bind(messageId)
    .first<{
      id: string;
      message_id: string;
      dedupe_key: string;
      r2_keys_json: string;
      vector_id: string | null;
      state: string;
      attempts: number;
      error_code: string | null;
    }>();
}

beforeAll(async () => {
  bindings = await getTestBindings();
  TEST_ENV = bindings.env as unknown as Env;
  DB = bindings.db;
  BUCKET = bindings.bucket;
});

afterAll(async () => {
  await bindings?.dispose();
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM semantic_index_leases`).run();
  const hasDeletionJobs = await DB.prepare(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'deletion_jobs'`,
  ).first<{ present: number }>();
  if (hasDeletionJobs) await DB.prepare(`DELETE FROM deletion_jobs`).run();
  await DB.prepare(`DELETE FROM messages_fts`).run();
  await DB.prepare(`DELETE FROM attachments`).run();
  await DB.prepare(`DELETE FROM messages`).run();
  await DB.prepare(`DELETE FROM aliases`).run();
  await DB.prepare(`DELETE FROM provisioning_events`).run();
  await DB.prepare(`DELETE FROM domains`).run();
  await DB.prepare(`DELETE FROM step_up_grants`).run();
});

describe("mail lifecycle durability", () => {
  it("keeps bulk deletion queries below D1's bind-variable ceiling", async () => {
    const mail = await seedMail();
    const ids = [mail.messageId];
    for (let start = 0; start < 199; start += 25) {
      const batch = Array.from({ length: Math.min(25, 199 - start) }, () => crypto.randomUUID());
      ids.push(...batch);
      await DB.batch(
        batch.map((id) =>
          DB.prepare(
            `INSERT INTO messages (id, domain_id, alias_id, dedupe_key, envelope_to, received_at, raw_r2_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          ).bind(
            id,
            mail.domainId,
            mail.aliasId,
            `bulk-${id}`,
            `history@${mail.domainId}.example`,
            mail.indexedAt,
            `raw/bulk/${id}`,
          ),
        ),
      );
    }

    const observed: number[] = [];
    const affected = await requestMessagesDeletion(dbWithBindLimit(DB, 100, observed), ids);
    expect(affected).toBe(200);
    expect(observed.length).toBeGreaterThan(0);
    expect(Math.max(...observed)).toBeLessThanOrEqual(100);
  });

  it("waits for an outbound staging lease and refreshes R2 pointers before cleanup", async () => {
    const mail = await seedMail();
    const outboundKey = `staging-${mail.messageId}`;
    await DB.prepare(
      `INSERT INTO outbound_jobs
         (idempotency_key, request_hash, message_id, state, lease_token, lease_expires_at, created_at, updated_at)
       VALUES (?1, 'digest', ?2, 'STAGING', 'stage-token', ?3, ?4, ?4)`,
    )
      .bind(
        outboundKey,
        mail.messageId,
        new Date(Date.now() + 60_000).toISOString(),
        mail.indexedAt,
      )
      .run();
    await requestMessageDeletion(DB, mail.messageId);

    const lateAttachment = `attachments/${mail.messageId}/late.txt`;
    await BUCKET.put(lateAttachment, "late staged bytes");
    await DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, safe_filename, content_type, size, r2_key)
       VALUES (?1, ?2, 'late.txt', 'late.txt', 'text/plain', 17, ?3)`,
    )
      .bind(crypto.randomUUID(), mail.messageId, lateAttachment)
      .run();

    const env = {
      ...TEST_ENV,
      VECTORIZE: { deleteByIds: async () => {} } as unknown as Env["VECTORIZE"],
    } as unknown as Env;
    const waiting = await drainDeletionJobs(env);
    expect(waiting.deferred).toBe(1);
    expect(await BUCKET.get(lateAttachment)).not.toBeNull();

    await DB.prepare(
      `UPDATE outbound_jobs SET lease_token = NULL, lease_expires_at = NULL WHERE idempotency_key = ?1`,
    )
      .bind(outboundKey)
      .run();
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
      .bind(mail.messageId, new Date(0).toISOString())
      .run();
    const completed = await drainDeletionJobs(env);
    expect(completed.completed).toBe(1);
    expect(await BUCKET.get(lateAttachment)).toBeNull();
  });

  it("defers alias purge while outbound staging has not created its message row", async () => {
    const domainId = crypto.randomUUID();
    const aliasId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const rawKey = `raw/staging/${messageId}`;
    await DB.prepare(
      `INSERT INTO domains (id, cloudflare_zone_id, name, zone_status, zone_type, mail_status)
       VALUES (?1, ?2, ?3, 'active', 'full', 'READY')`,
    )
      .bind(domainId, `zone-${domainId.slice(0, 8)}`, `${domainId}.example`)
      .run();
    await DB.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, address, status)
       VALUES (?1, ?2, 'stage', ?3, 'ACTIVE')`,
    )
      .bind(aliasId, domainId, `stage@${domainId}.example`)
      .run();
    const outboundKey = `unlinked-${messageId}`;
    await DB.prepare(
      `INSERT INTO outbound_jobs
         (idempotency_key, request_hash, message_id, state, lease_token, lease_expires_at, created_at, updated_at)
       VALUES (?1, 'digest', ?2, 'STAGING', 'stage-token', ?3, ?4, ?4)`,
    )
      .bind(outboundKey, messageId, new Date(Date.now() + 60_000).toISOString(), nowIso())
      .run();
    await requestAliasPurge(DB, aliasId);

    expect((await drainDeletionJobs(TEST_ENV)).deferred).toBe(1);
    expect(
      await DB.prepare(`SELECT id FROM aliases WHERE id = ?1`).bind(aliasId).first(),
    ).not.toBeNull();

    await BUCKET.put(rawKey, "staged mail");
    await expect(
      DB.prepare(
        `INSERT INTO messages (id, domain_id, alias_id, dedupe_key, envelope_to, received_at, raw_r2_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(
          messageId,
          domainId,
          aliasId,
          `out-${messageId}`,
          `stage@${domainId}.example`,
          nowIso(),
          rawKey,
        )
        .run(),
    ).rejects.toThrow("alias_purge_tombstoned");
    await DB.prepare(
      `INSERT INTO outbound_staging
        (message_id, alias_id, r2_keys_json, lease_token, lease_expires_at, writes_started, writes_settled, uncertain, idempotency_key)
       VALUES (?1, ?2, ?3, 'stage-token', ?4, 1, 1, 0, ?5)`,
    )
      .bind(messageId, aliasId, JSON.stringify([rawKey]), nowIso(), outboundKey)
      .run();
    await DB.prepare(
      `UPDATE outbound_jobs SET state = 'DELETED', lease_token = NULL, lease_expires_at = NULL
       WHERE idempotency_key = ?1`,
    )
      .bind(outboundKey)
      .run();
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE alias_id = ?1`)
      .bind(aliasId, new Date(0).toISOString())
      .run();
    await drainDeletionJobs(TEST_ENV);
    const messageJob = await readDeletionJob(messageId);
    expect(messageJob).toMatchObject({ state: "DONE", r2_keys_json: "[]" });
    expect(await BUCKET.get(rawKey)).toBeNull();

    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE alias_id = ?1`)
      .bind(aliasId, new Date(0).toISOString())
      .run();
    await drainDeletionJobs(TEST_ENV);
    expect(
      await DB.prepare(`SELECT id FROM aliases WHERE id = ?1`).bind(aliasId).first(),
    ).toBeNull();
  });

  it("requires an idempotency key on replies before attempting to send", async () => {
    const response = await worker.fetch(
      req("/api/messages/absent/reply", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ text: "reply" }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("Idempotency-Key") },
    });
  });

  it("preserves historical mail when an alias is kept then its domain is forgotten", async () => {
    const mail = await seedMail();
    const aliasDelete = await worker.fetch(
      req(`/api/aliases/${mail.aliasId}`, {
        method: "DELETE",
        headers: mutationHeaders,
        body: JSON.stringify({ purgeMessages: false }),
      }),
      TEST_ENV,
      CTX,
    );
    expect(aliasDelete.status).toBe(200);

    const detached = await DB.prepare(`SELECT alias_id FROM messages WHERE id = ?1`)
      .bind(mail.messageId)
      .first<{ alias_id: string | null }>();
    expect(detached).toEqual({ alias_id: null });

    const domainDelete = await worker.fetch(
      req(`/api/domains/${mail.zoneId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
      }),
      TEST_ENV,
      CTX,
    );
    expect(domainDelete.status).toBe(400);

    await expect(
      DB.prepare(`DELETE FROM domains WHERE id = ?1`).bind(mail.domainId).run(),
    ).rejects.toThrow(/domain_has_dependents/);

    const preserved = await DB.prepare(
      `SELECT id, alias_id, raw_r2_key, parsed_r2_key, embedded_at FROM messages WHERE id = ?1`,
    )
      .bind(mail.messageId)
      .first<{
        id: string;
        alias_id: string | null;
        raw_r2_key: string;
        parsed_r2_key: string;
        embedded_at: string | null;
      }>();
    const attachment = await DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?1`)
      .bind(mail.attachmentId)
      .first<{ r2_key: string }>();
    const extraAttachment = await DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?1`)
      .bind(mail.extraAttachmentId)
      .first<{ r2_key: string }>();
    const rawObject = !!(await BUCKET.get(mail.keys.raw));
    const parsedObject = !!(await BUCKET.get(mail.keys.parsed));
    const attachmentObject = !!(await BUCKET.get(mail.keys.attachment));

    const orphanedSearchRows = await DB.prepare(
      `SELECT COUNT(*) AS count FROM messages_fts f LEFT JOIN messages m ON m.id = f.message_id WHERE m.id IS NULL`,
    ).first<{ count: number }>();
    const attachmentResponse = await worker.fetch(
      req(`/api/messages/${mail.messageId}/attachments/${mail.attachmentId}`),
      TEST_ENV,
      CTX,
    );
    const attachmentBody = await attachmentResponse.text();

    expect({
      preserved,
      attachment,
      extraAttachment,
      rawObject,
      parsedObject,
      attachmentObject,
      orphanedSearchRows: Number(orphanedSearchRows?.count ?? 0),
      attachmentStatus: attachmentResponse.status,
      attachmentBody,
    }).toMatchObject({
      preserved: {
        id: mail.messageId,
        alias_id: null,
        raw_r2_key: mail.keys.raw,
        parsed_r2_key: mail.keys.parsed,
        embedded_at: mail.indexedAt,
      },
      attachment: { r2_key: mail.keys.attachment },
      extraAttachment: { r2_key: mail.keys.extraAttachment },
      rawObject: true,
      parsedObject: true,
      attachmentObject: true,
      orphanedSearchRows: 0,
      attachmentStatus: 200,
      attachmentBody: "evidence",
    });
  });

  it("retains every cleanup identifier when R2 and Vectorize deletes fail", async () => {
    const mail = await seedMail();
    let r2Failure = true;
    let vectorFailure = true;
    const vectorIds = new Set([mail.messageId]);
    const vectorize = {
      deleteByIds: async (ids: string[]) => {
        if (vectorFailure) throw new Error("temporary Vectorize failure");
        for (const id of ids) vectorIds.delete(id);
      },
    } as unknown as Env["VECTORIZE"];
    const env = {
      ...TEST_ENV,
      MAIL_BUCKET: bucketWithDeleteFailures([mail.keys.raw], () => r2Failure),
      AI: { run: async () => ({ data: [] }) },
      VECTORIZE: vectorize,
    } as unknown as Env;

    const outboundKey = `deleted-${mail.messageId}`;
    await DB.prepare(
      `INSERT INTO outbound_jobs
         (idempotency_key, request_hash, message_id, state, quota_charged, provider_message_id, error_code, created_at, updated_at)
       VALUES (?1, 'digest', ?2, 'DISPATCHING', 1, 'provider-id', 'old-error', ?3, ?3)`,
    )
      .bind(outboundKey, mail.messageId, mail.indexedAt)
      .run();

    const response = await worker.fetch(
      req(`/api/messages/${mail.messageId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
      }),
      env,
      CTX,
    );
    expect(response.status).toBeLessThan(500);
    const repeatedDelete = await worker.fetch(
      req(`/api/messages/${mail.messageId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
      }),
      env,
      CTX,
    );
    expect([200, 202, 204].includes(repeatedDelete.status)).toBe(true);
    const pendingRow = await DB.prepare(`SELECT deletion_pending FROM messages WHERE id = ?1`)
      .bind(mail.messageId)
      .first<{ deletion_pending: number }>();
    expect(pendingRow).toEqual({ deletion_pending: 1 });
    const inbox = await worker.fetch(req("/api/messages"), env, CTX);
    const inboxBody = (await inbox.json()) as { items: Array<{ id: string }> };
    expect(inboxBody.items.some((item) => item.id === mail.messageId)).toBe(false);
    expect((await worker.fetch(req(`/api/messages/${mail.messageId}`), env, CTX)).status).toBe(404);
    expect(await isMessageDeletionTombstoned(DB, mail.dedupeKey)).toBe(true);
    const redelivery: IngestJob = {
      v: 1,
      messageId: mail.messageId,
      dedupeKey: mail.dedupeKey,
      domainId: mail.domainId,
      aliasId: mail.aliasId,
      rawKey: mail.keys.raw,
      parsedKey: mail.keys.parsed,
      envelopeFrom: "sender@example.net",
      envelopeTo: `history@${mail.domainId}.example`,
    };
    expect(await commitIngest(redelivery, DB, BUCKET, { ...env, VECTORIZE: undefined })).toEqual({
      status: "duplicate",
    });
    const outboundAtRequest = await DB.prepare(
      `SELECT state, quota_charged, provider_message_id, error_code FROM outbound_jobs WHERE idempotency_key = ?1`,
    )
      .bind(outboundKey)
      .first<{
        state: string;
        quota_charged: number;
        provider_message_id: string | null;
        error_code: string | null;
      }>();
    expect(outboundAtRequest).toEqual({
      state: "DELETED",
      quota_charged: 1,
      provider_message_id: null,
      error_code: null,
    });

    let drain = await drainDeletionJobs(env);
    expect(drain.failed).toBe(1);
    let job = await readDeletionJob(mail.messageId);
    expect(job).toMatchObject({
      message_id: mail.messageId,
      state: "PENDING",
      attempts: 1,
      error_code: "EXTERNAL_DELETE_FAILED",
      vector_id: mail.messageId,
    });
    expect(JSON.parse(job?.r2_keys_json ?? "[]")).toEqual(
      expect.arrayContaining(Object.values(mail.keys)),
    );
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(mail.messageId).first(),
    ).not.toBeNull();
    expect(await BUCKET.get(mail.keys.raw)).not.toBeNull();

    r2Failure = false;
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
      .bind(mail.messageId, new Date(0).toISOString())
      .run();
    drain = await drainDeletionJobs(env);
    expect(drain.failed).toBe(1);
    job = await readDeletionJob(mail.messageId);
    expect(job).toMatchObject({
      state: "PENDING",
      attempts: 2,
      error_code: "EXTERNAL_DELETE_FAILED",
      vector_id: mail.messageId,
    });
    expect(await BUCKET.get(mail.keys.raw)).toBeNull();
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(mail.messageId).first(),
    ).not.toBeNull();

    vectorFailure = false;
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
      .bind(mail.messageId, new Date(0).toISOString())
      .run();
    drain = await drainDeletionJobs(env);
    expect(drain.completed).toBe(1);
    job = await readDeletionJob(mail.messageId);
    expect(job).toMatchObject({
      state: "DONE",
      r2_keys_json: "[]",
      vector_id: null,
      error_code: null,
    });
    expect(vectorIds.has(mail.messageId)).toBe(false);
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(mail.messageId).first(),
    ).toBeNull();
    expect(
      await DB.prepare(`SELECT 1 FROM attachments WHERE message_id = ?1`)
        .bind(mail.messageId)
        .first(),
    ).toBeNull();
    expect(
      await DB.prepare(`SELECT 1 FROM messages_fts WHERE message_id = ?1`)
        .bind(mail.messageId)
        .first(),
    ).toBeNull();
    expect(await BUCKET.get(mail.keys.extraAttachment)).toBeNull();
    const outbound = await DB.prepare(
      `SELECT state, provider_message_id, error_code FROM outbound_jobs WHERE idempotency_key = ?1`,
    )
      .bind(outboundKey)
      .first<{ state: string; provider_message_id: string | null; error_code: string | null }>();
    expect(outbound).toEqual({ state: "DELETED", provider_message_id: null, error_code: null });
    const outboundQuota = await DB.prepare(
      `SELECT quota_charged FROM outbound_jobs WHERE idempotency_key = ?1`,
    )
      .bind(outboundKey)
      .first<{ quota_charged: number }>();
    expect(outboundQuota).toEqual({ quota_charged: 1 });
    expect(await isMessageDeletionTombstoned(DB, mail.dedupeKey)).toBe(true);
  });

  it("uses the same durable cleanup path for bulk deletion", async () => {
    const mail = await seedMail();
    const env = {
      ...TEST_ENV,
      MAIL_BUCKET: bucketWithDeleteFailures([mail.keys.raw]),
      AI: { run: async () => ({ data: [] }) },
      VECTORIZE: {
        deleteByIds: async () => {
          throw new Error("temporary Vectorize failure");
        },
      } as unknown as Env["VECTORIZE"],
    } as unknown as Env;

    const response = await worker.fetch(
      req("/api/messages/bulk", {
        method: "POST",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
        body: JSON.stringify({ ids: [mail.messageId], action: "delete" }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBeLessThan(500);
    const job = await readDeletionJob(mail.messageId);
    expect({ rawObject: !!(await BUCKET.get(mail.keys.raw)), job }).toMatchObject({
      rawObject: true,
      job: {
        message_id: mail.messageId,
        r2_keys_json: expect.any(String),
        vector_id: mail.messageId,
      },
    });
    expect(JSON.parse(job?.r2_keys_json ?? "[]")).toEqual(
      expect.arrayContaining(Object.values(mail.keys)),
    );
  });

  it("keeps alias-purge cleanup retryable instead of orphaning mail and vectors", async () => {
    const mail = await seedMail();
    const vectorIds = new Set([mail.messageId]);
    let r2Failure = true;
    let vectorFailure = true;
    const env = {
      ...TEST_ENV,
      MAIL_BUCKET: bucketWithDeleteFailures([mail.keys.raw], () => r2Failure),
      AI: { run: async () => ({ data: [] }) },
      VECTORIZE: {
        deleteByIds: async (ids: string[]) => {
          if (vectorFailure) throw new Error("temporary Vectorize failure");
          for (const id of ids) vectorIds.delete(id);
        },
      } as unknown as Env["VECTORIZE"],
    } as unknown as Env;

    const outboundKey = `purged-alias-${mail.messageId}`;
    await DB.prepare(
      `INSERT INTO outbound_jobs
         (idempotency_key, request_hash, message_id, state, quota_charged, provider_message_id, error_code, created_at, updated_at)
       VALUES (?1, 'digest', ?2, 'STAGING', 1, 'provider-id', 'old-error', ?3, ?3)`,
    )
      .bind(outboundKey, mail.messageId, mail.indexedAt)
      .run();

    const response = await worker.fetch(
      req(`/api/aliases/${mail.aliasId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
        body: JSON.stringify({ purgeMessages: true }),
      }),
      env,
      CTX,
    );
    expect(response.status).toBeLessThan(500);
    expect(
      await DB.prepare(
        `SELECT state, quota_charged, provider_message_id, error_code FROM outbound_jobs WHERE idempotency_key = ?1`,
      )
        .bind(outboundKey)
        .first(),
    ).toEqual({ state: "DELETED", quota_charged: 1, provider_message_id: null, error_code: null });
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?1 WHERE alias_id = ?2`)
      .bind(new Date(0).toISOString(), mail.aliasId)
      .run();
    const drain = await drainDeletionJobs(env);
    expect(drain.failed).toBe(1);
    const job = await readDeletionJob(mail.messageId);
    if (!job) throw new Error("alias purge did not stage its first bounded message chunk");
    expect({
      rawObject: !!(await BUCKET.get(mail.keys.raw)),
      messageRow: !!(await DB.prepare(`SELECT 1 AS present FROM messages WHERE id = ?1`)
        .bind(mail.messageId)
        .first()),
      vectorRetained: vectorIds.has(mail.messageId),
      job,
    }).toMatchObject({
      rawObject: true,
      vectorRetained: true,
      job: {
        message_id: mail.messageId,
        state: "PENDING",
        r2_keys_json: expect.any(String),
        vector_id: mail.messageId,
      },
    });
    expect(JSON.parse(job?.r2_keys_json ?? "[]")).toEqual(
      expect.arrayContaining(Object.values(mail.keys)),
    );

    r2Failure = false;
    vectorFailure = false;
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
      .bind(mail.messageId, new Date(0).toISOString())
      .run();
    await drainDeletionJobs(env);
    await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?1 WHERE alias_id = ?2`)
      .bind(new Date(0).toISOString(), mail.aliasId)
      .run();
    await drainDeletionJobs(env);
    const completed = await readDeletionJob(mail.messageId);
    expect(completed).toMatchObject({ state: "DONE", r2_keys_json: "[]", vector_id: null });
    expect(vectorIds.has(mail.messageId)).toBe(false);
    expect(
      await DB.prepare(`SELECT id FROM messages WHERE id = ?1`).bind(mail.messageId).first(),
    ).toBeNull();
    expect(
      await DB.prepare(`SELECT id FROM aliases WHERE id = ?1`).bind(mail.aliasId).first(),
    ).toBeNull();
  });

  it("bounds automatic retries and exposes failed jobs for deliberate retry", async () => {
    const mail = await seedMail();
    const env = {
      ...TEST_ENV,
      MAIL_BUCKET: bucketWithDeleteFailures([mail.keys.raw]),
      AI: { run: async () => ({ data: [] }) },
      VECTORIZE: { deleteByIds: async () => {} } as unknown as Env["VECTORIZE"],
    } as unknown as Env;
    const response = await worker.fetch(
      req(`/api/messages/${mail.messageId}`, {
        method: "DELETE",
        headers: { ...mutationHeaders, ...(await grantHeader()) },
      }),
      env,
      CTX,
    );
    expect(response.status).toBe(202);
    const job = await readDeletionJob(mail.messageId);
    if (!job) throw new Error("message deletion job was not created");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?2 WHERE message_id = ?1`)
        .bind(mail.messageId, new Date(0).toISOString())
        .run();
      await drainDeletionJobs(env);
    }
    const exhausted = await readDeletionJob(mail.messageId);
    expect(exhausted).toMatchObject({
      state: "FAILED",
      attempts: 8,
      error_code: "EXTERNAL_DELETE_FAILED",
    });

    const statusResponse = await worker.fetch(req("/api/deletions"), env, CTX);
    const status = (await statusResponse.json()) as {
      failed: Array<{ id: string; errorCode: string; attempts: number }>;
    };
    expect(status.failed).toContainEqual(
      expect.objectContaining({ id: job.id, errorCode: "EXTERNAL_DELETE_FAILED", attempts: 8 }),
    );

    const retryResponse = await worker.fetch(
      req(`/api/deletions/${job.id}/retry`, { method: "POST", headers: mutationHeaders }),
      env,
      CTX,
    );
    expect(retryResponse.status).toBe(202);
    expect(await readDeletionJob(mail.messageId)).toMatchObject({
      state: "PENDING",
      attempts: 0,
      error_code: null,
    });
  });
});
