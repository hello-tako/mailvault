import { drainInboundStagingCleanup } from "./ingest";
import type { Env } from "../env";
import { newId, nowIso } from "../lib/util";
import { log } from "../lib/logging";

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const LEASE_MS = 60 * 1000;
const ID_QUERY_BATCH = 80;
const MESSAGE_BATCH = 25;
const JOB_BATCH = 20;

interface DeletionMessageRow {
  id: string;
  dedupe_key: string;
  alias_id: string | null;
  raw_r2_key: string;
  parsed_r2_key: string | null;
  embedded_at: string | null;
  attachment_key: string | null;
  staging_keys_json: string | null;
}

interface DeletionJobRow {
  id: string;
  job_type: "MESSAGE" | "ALIAS_PURGE";
  message_id: string | null;
  alias_id: string | null;
  r2_keys_json: string;
  vector_id: string | null;
  attempts: number;
  lease_until: string | null;
}

function uniqueKeys(rows: DeletionMessageRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(row.raw_r2_key);
    if (row.parsed_r2_key) keys.add(row.parsed_r2_key);
    if (row.attachment_key) keys.add(row.attachment_key);
    if (row.staging_keys_json) {
      const staged: unknown = JSON.parse(row.staging_keys_json);
      if (!Array.isArray(staged) || staged.some((key) => typeof key !== "string"))
        throw new Error("OUTBOUND_STAGE_MANIFEST_CORRUPT");
      for (const key of staged) keys.add(key);
    }
  }
  return [...keys];
}

async function messageRows(db: D1Database, ids: string[]): Promise<DeletionMessageRow[]> {
  if (ids.length === 0) return [];
  const rows: DeletionMessageRow[] = [];
  for (let start = 0; start < ids.length; start += ID_QUERY_BATCH) {
    const batch = ids.slice(start, start + ID_QUERY_BATCH);
    const placeholders = batch.map((_, index) => `?${index + 1}`).join(", ");
    const { results } = await db
      .prepare(
        `SELECT m.id, m.dedupe_key, m.alias_id, m.raw_r2_key, m.parsed_r2_key, m.embedded_at,
                a.r2_key AS attachment_key,
                (SELECT s.r2_keys_json FROM outbound_staging s WHERE s.message_id = m.id) AS staging_keys_json
         FROM messages m LEFT JOIN attachments a ON a.message_id = m.id
         WHERE m.id IN (${placeholders}) AND m.deletion_pending = 0`,
      )
      .bind(...batch)
      .all<DeletionMessageRow>();
    rows.push(...(results ?? []));
  }
  return rows;
}

async function stageMessages(db: D1Database, rows: DeletionMessageRow[]): Promise<number> {
  let staged = 0;
  const grouped = new Map<string, DeletionMessageRow[]>();
  for (const row of rows) {
    const same = grouped.get(row.id);
    if (same) same.push(row);
    else grouped.set(row.id, [row]);
  }
  const messages = [...grouped.values()];
  for (let start = 0; start < messages.length; start += MESSAGE_BATCH) {
    const batch = messages.slice(start, start + MESSAGE_BATCH);
    const statements = batch.flatMap((group) => {
      const row = group[0];
      if (!row) return [];
      const jobId = newId();
      return [
        db
          .prepare(
            `INSERT INTO deletion_jobs
               (id, job_type, message_id, dedupe_key, r2_keys_json, vector_id, state, next_attempt_at, created_at, updated_at)
             SELECT ?1, 'MESSAGE', m.id, m.dedupe_key, ?2,
                    CASE WHEN m.embedded_at IS NOT NULL OR EXISTS (
                      SELECT 1 FROM semantic_index_leases l WHERE l.message_id = m.id
                    ) THEN m.id END,
                    'PENDING', ?3, ?3, ?3
             FROM messages m WHERE m.id = ?4 AND m.deletion_pending = 0
             ON CONFLICT(message_id) DO NOTHING`,
          )
          .bind(jobId, JSON.stringify(uniqueKeys(group)), nowIso(), row.id),
        db
          .prepare(
            `UPDATE messages SET deletion_pending = 1
             WHERE id = ?1 AND deletion_pending = 0
               AND EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.message_id = messages.id AND j.state <> 'DONE')`,
          )
          .bind(row.id),
        db
          .prepare(
            `UPDATE outbound_jobs SET state = 'DELETED', provider_message_id = NULL, error_code = NULL,
               updated_at = ?2
             WHERE message_id = ?1 AND state IN ('STAGING', 'DISPATCHING', 'ACCEPTED', 'FAILED')`,
          )
          .bind(row.id, nowIso()),
      ];
    });
    await db.batch(statements);
    staged += batch.length;
  }
  return staged;
}

export interface RequestDeletionResult {
  found: boolean;
  state?: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
}

/** Record cleanup identifiers and hide messages in one D1 transaction. */
export async function requestMessageDeletion(
  db: D1Database,
  id: string,
): Promise<RequestDeletionResult> {
  const existing = await db
    .prepare(`SELECT state FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1`)
    .bind(id)
    .first<{ state: RequestDeletionResult["state"] }>();
  if (existing) return { found: true, state: existing.state };

  const rows = await messageRows(db, [id]);
  if (rows.length === 0) return { found: false };
  await stageMessages(db, rows);
  const job = await db
    .prepare(`SELECT state FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1`)
    .bind(id)
    .first<{ state: RequestDeletionResult["state"] }>();
  return job ? { found: true, state: job.state } : { found: false };
}

/** Tombstones retain this key after the message row is physically removed. */
export async function isMessageDeletionTombstoned(
  db: D1Database,
  dedupeKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM deletion_jobs
       WHERE job_type = 'MESSAGE' AND dedupe_key = ?1 LIMIT 1`,
    )
    .bind(dedupeKey)
    .first<{ present: number }>();
  return !!row;
}

/** Queue a bounded set of requested message ids; retrying the request is safe. */
export async function requestMessagesDeletion(db: D1Database, ids: string[]): Promise<number> {
  const unique = [...new Set(ids)];
  const rows = await messageRows(db, unique);
  await stageMessages(db, rows);
  if (unique.length === 0) return 0;
  let count = 0;
  for (let start = 0; start < unique.length; start += ID_QUERY_BATCH) {
    const batch = unique.slice(start, start + ID_QUERY_BATCH);
    const placeholders = batch.map((_, index) => `?${index + 1}`).join(", ");
    const result = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM deletion_jobs
         WHERE job_type = 'MESSAGE' AND message_id IN (${placeholders})`,
      )
      .bind(...batch)
      .first<{ count: number }>();
    count += Number(result?.count ?? 0);
  }
  return count;
}

/** Re-arm cleanup if a Vectorize upsert finishes after deletion made its earlier pass. */
export async function recordLateSemanticWrite(db: D1Database, id: string): Promise<boolean> {
  const blocked = await db
    .prepare(
      `SELECT 1 AS blocked
       WHERE EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)
          OR EXISTS (
            SELECT 1 FROM messages m WHERE m.id = ?1 AND (
              m.deletion_pending = 1 OR EXISTS (
                SELECT 1 FROM deletion_jobs j
                WHERE j.job_type = 'ALIAS_PURGE' AND j.alias_id = m.alias_id AND j.state <> 'DONE'
              )
            )
          )`,
    )
    .bind(id)
    .first<{ blocked: number }>();
  if (!blocked) return false;

  const requested = await requestMessageDeletion(db, id);
  if (!requested.found) return false;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', vector_id = ?2, attempts = 0,
         next_attempt_at = ?3, lease_until = NULL, error_code = NULL, updated_at = ?3
       WHERE job_type = 'MESSAGE' AND message_id = ?2`,
    )
    .bind(id, id, now)
    .run();
  return true;
}

export async function requestAliasPurge(
  db: D1Database,
  aliasId: string,
): Promise<RequestDeletionResult> {
  const existing = await db
    .prepare(`SELECT state FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE' AND alias_id = ?1`)
    .bind(aliasId)
    .first<{ state: RequestDeletionResult["state"] }>();
  if (existing) return { found: true, state: existing.state };

  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO deletion_jobs
           (id, job_type, alias_id, state, next_attempt_at, created_at, updated_at)
         SELECT ?1, 'ALIAS_PURGE', id, 'PENDING', ?2, ?2, ?2 FROM aliases WHERE id = ?3
         ON CONFLICT DO NOTHING`,
      )
      .bind(newId(), now, aliasId),
    db
      .prepare(`UPDATE aliases SET status = 'DISABLED', updated_at = ?2 WHERE id = ?1`)
      .bind(aliasId, now),
    db
      .prepare(
        `UPDATE outbound_jobs SET state = 'DELETED', provider_message_id = NULL, error_code = NULL,
           updated_at = ?2
         WHERE (message_id IN (SELECT id FROM messages WHERE alias_id = ?1)
           OR message_id IN (SELECT message_id FROM outbound_staging WHERE alias_id = ?1))
           AND state IN ('STAGING', 'DISPATCHING', 'ACCEPTED', 'FAILED')`,
      )
      .bind(aliasId, now),
  ]);
  const job = await db
    .prepare(`SELECT state FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE' AND alias_id = ?1`)
    .bind(aliasId)
    .first<{ state: RequestDeletionResult["state"] }>();
  return job ? { found: true, state: job.state } : { found: false };
}

function retryAt(attempt: number): string {
  const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 12), MAX_BACKOFF_MS);
  return new Date(Date.now() + delay).toISOString();
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "INBOUND_STAGE_UNCERTAIN") return message;
  if (message === "VECTORIZE_UNAVAILABLE") return message;
  if (message === "OUTBOUND_STAGE_UNCERTAIN" || message === "OUTBOUND_STAGE_MANIFEST_CORRUPT")
    return message;
  return "EXTERNAL_DELETE_FAILED";
}

async function claimNext(db: D1Database): Promise<DeletionJobRow | null> {
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT id FROM deletion_jobs
       WHERE (state = 'PENDING' AND next_attempt_at <= ?1)
          OR (state = 'PROCESSING' AND lease_until <= ?1 AND (job_type <> 'MESSAGE' OR attempts < ?2))
       ORDER BY next_attempt_at, created_at LIMIT 1`,
    )
    .bind(now, MAX_ATTEMPTS)
    .first<{ id: string }>();
  if (!row) return null;
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  return db
    .prepare(
      `UPDATE deletion_jobs SET state = 'PROCESSING', lease_until = ?2,
         attempts = CASE WHEN job_type = 'MESSAGE' THEN attempts + 1 ELSE attempts END,
         updated_at = ?3
       WHERE id = ?1 AND (
         (state = 'PENDING' AND next_attempt_at <= ?3) OR
         (state = 'PROCESSING' AND lease_until <= ?3 AND (job_type <> 'MESSAGE' OR attempts < ?4))
       )
       RETURNING id, job_type, message_id, alias_id, r2_keys_json, vector_id, attempts, lease_until`,
    )
    .bind(row.id, leaseUntil, now, MAX_ATTEMPTS)
    .first<DeletionJobRow>();
}

async function stageAliasChunk(db: D1Database, job: DeletionJobRow): Promise<void> {
  const now = nowIso();
  const unregisteredWriter = await db
    .prepare(
      `SELECT 1 AS present FROM outbound_jobs o
       WHERE o.state = 'STAGING' AND o.lease_token IS NOT NULL AND o.lease_expires_at > ?1
         AND NOT EXISTS (SELECT 1 FROM outbound_staging s WHERE s.message_id = o.message_id)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = o.message_id)
       LIMIT 1`,
    )
    .bind(now)
    .first<{ present: number }>();
  if (unregisteredWriter) {
    await db
      .prepare(
        `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2,
           lease_until = NULL, updated_at = ?2
         WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
      )
      .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
      .run();
    return;
  }
  const unlinkedStages = await db
    .prepare(
      `SELECT s.message_id, s.writes_started, s.writes_settled, s.uncertain,
              s.lease_token, s.lease_expires_at, o.lease_token AS job_lease_token,
              o.lease_expires_at AS job_lease_expires_at
       FROM outbound_staging s JOIN outbound_jobs o ON o.message_id = s.message_id
       WHERE s.alias_id = ?1
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs d WHERE d.job_type = 'MESSAGE' AND d.message_id = s.message_id)
       ORDER BY s.message_id LIMIT ?2`,
    )
    .bind(job.alias_id, MESSAGE_BATCH)
    .all<{
      message_id: string;
      writes_started: number;
      writes_settled: number;
      uncertain: number;
      lease_token: string | null;
      lease_expires_at: string | null;
      job_lease_token: string | null;
      job_lease_expires_at: string | null;
    }>();
  if (unlinkedStages.results?.length) {
    for (const stage of unlinkedStages.results) {
      if (
        (stage.lease_token && stage.lease_expires_at && stage.lease_expires_at > now) ||
        (stage.job_lease_token && stage.job_lease_expires_at && stage.job_lease_expires_at > now)
      ) {
        await db
          .prepare(
            `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2,
               lease_until = NULL, updated_at = ?2
             WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
          )
          .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
          .run();
        return;
      }
      if (stage.uncertain || (stage.writes_started && !stage.writes_settled))
        throw new Error("OUTBOUND_STAGE_UNCERTAIN");
    }
    await db.batch(
      unlinkedStages.results.map((stage) =>
        db
          .prepare(
            `INSERT INTO deletion_jobs
               (id, job_type, message_id, dedupe_key, r2_keys_json, state, next_attempt_at, created_at, updated_at)
             SELECT ?1, 'MESSAGE', s.message_id, 'out|' || s.message_id, s.r2_keys_json,
                    'PENDING', ?2, ?2, ?2
             FROM outbound_staging s
             WHERE s.message_id = ?3 AND s.alias_id = ?4
               AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = s.message_id)
               AND NOT EXISTS (SELECT 1 FROM deletion_jobs d WHERE d.job_type = 'MESSAGE' AND d.message_id = s.message_id)
             ON CONFLICT(message_id) DO NOTHING`,
          )
          .bind(newId(), now, stage.message_id, job.alias_id),
      ),
    );
    await db
      .prepare(
        `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2,
           lease_until = NULL, updated_at = ?2
         WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
      )
      .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
      .run();
    return;
  }

  const rows = await db
    .prepare(
      `SELECT id FROM messages WHERE alias_id = ?1 AND deletion_pending = 0 ORDER BY id LIMIT ?2`,
    )
    .bind(job.alias_id, MESSAGE_BATCH)
    .all<{ id: string }>();
  if (rows.results?.length) {
    const fullRows = await messageRows(
      db,
      rows.results.map((row) => row.id),
    );
    await stageMessages(db, fullRows);
  }

  const remaining = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE alias_id = ?1) AS messages,
              ((SELECT COUNT(*) FROM outbound_staging WHERE alias_id = ?1) +
               (SELECT COUNT(*) FROM inbound_staging WHERE alias_id = ?1
                 AND (state <> 'TOMBSTONED' OR writes_settled = 0 OR cleanup_confirmed = 0))) AS staging`,
    )
    .bind(job.alias_id)
    .first<{ messages: number; staging: number }>();
  if (Number(remaining?.messages ?? 0) === 0 && Number(remaining?.staging ?? 0) === 0) {
    await db.batch([
      db
        .prepare(
          `DELETE FROM aliases WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM messages WHERE alias_id = ?1)`,
        )
        .bind(job.alias_id),
      db
        .prepare(
          `UPDATE deletion_jobs SET state = 'DONE', lease_until = NULL, error_code = NULL,
             updated_at = ?2 WHERE id = ?1 AND job_type = 'ALIAS_PURGE'`,
        )
        .bind(job.id, now),
    ]);
    return;
  }

  await db
    .prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2, lease_until = NULL, updated_at = ?2
       WHERE id = ?1 AND job_type = 'ALIAS_PURGE'`,
    )
    .bind(job.id, new Date(Date.now() + (rows.results?.length ? 1000 : 5000)).toISOString())
    .run();
}

async function finalizeMessageDeletion(db: D1Database, job: DeletionJobRow): Promise<void> {
  const now = nowIso();
  if (!job.lease_until) return;
  const ownedJob = `EXISTS (
    SELECT 1 FROM deletion_jobs j WHERE j.id = ?2 AND j.state = 'PROCESSING' AND j.lease_until = ?3
  )`;
  const noActiveSemanticWriter = `NOT EXISTS (
    SELECT 1 FROM semantic_index_leases l WHERE l.message_id = ?4 AND l.lease_until > ?5
  )`;
  await db.batch([
    db
      .prepare(
        `DELETE FROM messages_fts WHERE message_id = ?1 AND ${ownedJob} AND ${noActiveSemanticWriter}`,
      )
      .bind(job.message_id, job.id, job.lease_until, job.message_id, now),
    db
      .prepare(
        `DELETE FROM messages WHERE id = ?1 AND deletion_pending = 1 AND ${ownedJob} AND ${noActiveSemanticWriter}`,
      )
      .bind(job.message_id, job.id, job.lease_until, job.message_id, now),
    db
      .prepare(
        `UPDATE outbound_jobs SET state = 'DELETED', provider_message_id = NULL, error_code = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?6
         WHERE message_id = ?1 AND ${ownedJob} AND ${noActiveSemanticWriter}`,
      )
      .bind(job.message_id, job.id, job.lease_until, job.message_id, now, now),
    db
      .prepare(
        `DELETE FROM outbound_staging WHERE message_id = ?1 AND ${ownedJob} AND ${noActiveSemanticWriter}`,
      )
      .bind(job.message_id, job.id, job.lease_until, job.message_id, now),
    db
      .prepare(
        `UPDATE deletion_jobs SET state = 'DONE', r2_keys_json = '[]', vector_id = NULL,
           lease_until = NULL, error_code = NULL, updated_at = ?2
         WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3
           AND ${noActiveSemanticWriter}`,
      )
      .bind(job.id, now, job.lease_until, job.message_id, now),
  ]);
}

async function cleanupMessage(env: Env, job: DeletionJobRow): Promise<void> {
  const now = nowIso();
  const writer = await env.DB.prepare(
    `SELECT lease_until FROM semantic_index_leases WHERE message_id = ?1`,
  )
    .bind(job.message_id)
    .first<{ lease_until: string }>();
  if (writer?.lease_until && writer.lease_until > now) {
    await env.DB.prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2,
           lease_until = NULL, updated_at = ?2
         WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
    )
      .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
      .run();
    return;
  }
  const outboundWriter = await env.DB.prepare(
    `SELECT 1 AS present FROM outbound_jobs
       WHERE message_id = ?1 AND lease_token IS NOT NULL AND lease_expires_at > ?2 LIMIT 1`,
  )
    .bind(job.message_id, now)
    .first<{ present: number }>();
  if (outboundWriter) {
    await env.DB.prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2,
           lease_until = NULL, updated_at = ?2
         WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
    )
      .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
      .run();
    return;
  }
  const inbound = await env.DB.prepare(
    `SELECT lease_expires_at FROM inbound_staging s WHERE s.writes_settled = 0
       AND (s.message_id = ?1 OR s.dedupe_key = (SELECT dedupe_key FROM deletion_jobs WHERE id = ?2)) LIMIT 1`,
  )
    .bind(job.message_id, job.id)
    .first<{ lease_expires_at: string }>();
  if (inbound) {
    if (inbound.lease_expires_at <= now) throw new Error("INBOUND_STAGE_UNCERTAIN");
    await env.DB.prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', next_attempt_at = ?2, lease_until = NULL, updated_at = ?2
       WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?3`,
    )
      .bind(job.id, new Date(Date.now() + 1000).toISOString(), job.lease_until)
      .run();
    return;
  }
  const staging = await env.DB.prepare(
    `SELECT writes_started, writes_settled, uncertain FROM outbound_staging WHERE message_id = ?1`,
  )
    .bind(job.message_id)
    .first<{ writes_started: number; writes_settled: number; uncertain: number }>();
  if (staging?.uncertain || (staging?.writes_started && !staging.writes_settled))
    throw new Error("OUTBOUND_STAGE_UNCERTAIN");
  const savedKeys = JSON.parse(job.r2_keys_json) as unknown;
  if (!Array.isArray(savedKeys) || savedKeys.some((key) => typeof key !== "string")) {
    throw new Error("DELETION_JOB_CORRUPT");
  }
  const message = await env.DB.prepare(
    `SELECT raw_r2_key, parsed_r2_key FROM messages WHERE id = ?1`,
  )
    .bind(job.message_id)
    .first<{ raw_r2_key: string; parsed_r2_key: string | null }>();
  const attachments = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id = ?1`)
    .bind(job.message_id)
    .all<{ r2_key: string }>();
  const keys = new Set(savedKeys as string[]);
  if (message) {
    keys.add(message.raw_r2_key);
    if (message.parsed_r2_key) keys.add(message.parsed_r2_key);
  }
  for (const attachment of attachments.results ?? []) keys.add(attachment.r2_key);
  const stagingManifest = await env.DB.prepare(
    `SELECT r2_keys_json FROM outbound_staging WHERE message_id = ?1`,
  )
    .bind(job.message_id)
    .first<{ r2_keys_json: string }>();
  if (stagingManifest) {
    const staged: unknown = JSON.parse(stagingManifest.r2_keys_json);
    if (!Array.isArray(staged) || staged.some((key) => typeof key !== "string"))
      throw new Error("OUTBOUND_STAGE_MANIFEST_CORRUPT");
    for (const key of staged) keys.add(key);
  }
  const inboundKeys = await env.DB.prepare(
    `SELECT o.r2_key FROM inbound_staging_objects o JOIN inbound_staging s ON s.message_id = o.message_id
     WHERE s.message_id = ?1 OR s.dedupe_key = (SELECT dedupe_key FROM deletion_jobs WHERE id = ?2)`,
  )
    .bind(job.message_id, job.id)
    .all<{ r2_key: string }>();
  for (const object of inboundKeys.results ?? []) keys.add(object.r2_key);
  const refreshed = await env.DB.prepare(
    `UPDATE deletion_jobs SET r2_keys_json = ?3
       WHERE id = ?1 AND state = 'PROCESSING' AND lease_until = ?2 RETURNING id`,
  )
    .bind(job.id, job.lease_until, JSON.stringify([...keys]))
    .first<{ id: string }>();
  if (!refreshed) return;
  const keyList = [...keys];
  for (let start = 0; start < keyList.length; start += 1000) {
    await env.MAIL_BUCKET.delete(keyList.slice(start, start + 1000));
  }
  if (job.vector_id) {
    if (!env.VECTORIZE) throw new Error("VECTORIZE_UNAVAILABLE");
    await env.VECTORIZE.deleteByIds([job.vector_id]);
  }
  await finalizeMessageDeletion(env.DB, job);
}

async function handleFailure(db: D1Database, job: DeletionJobRow, error: unknown): Promise<void> {
  const attempts = job.job_type === "MESSAGE" ? job.attempts : job.attempts + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  const code = safeErrorCode(error);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE deletion_jobs SET state = ?2, attempts = ?3, next_attempt_at = ?4,
         lease_until = NULL, error_code = ?5, updated_at = ?6 WHERE id = ?1 AND state = 'PROCESSING'`,
    )
    .bind(job.id, terminal ? "FAILED" : "PENDING", attempts, retryAt(attempts), code, now)
    .run();
}

export interface DeletionDrainResult {
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
}

/** Process a bounded number of cleanup jobs; provider errors are durably rescheduled. */
export async function drainDeletionJobs(env: Env, limit = JOB_BATCH): Promise<DeletionDrainResult> {
  await drainInboundStagingCleanup(env.DB, env.MAIL_BUCKET);
  const report: DeletionDrainResult = { claimed: 0, completed: 0, failed: 0, deferred: 0 };
  const max = Math.max(1, Math.min(limit, JOB_BATCH));
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE deletion_jobs SET state = 'FAILED', error_code = 'ATTEMPT_LIMIT_EXCEEDED',
         lease_until = NULL, updated_at = ?1
       WHERE state = 'PROCESSING' AND job_type = 'MESSAGE' AND attempts >= ?2 AND lease_until <= ?1`,
  )
    .bind(now, MAX_ATTEMPTS)
    .run();
  for (let index = 0; index < max; index += 1) {
    const job = await claimNext(env.DB);
    if (!job) break;
    report.claimed += 1;
    try {
      if (job.job_type === "ALIAS_PURGE") await stageAliasChunk(env.DB, job);
      else await cleanupMessage(env, job);
      const state = await env.DB.prepare(`SELECT state FROM deletion_jobs WHERE id = ?1`)
        .bind(job.id)
        .first<{ state: string }>();
      if (state?.state === "DONE") report.completed += 1;
      else report.deferred += 1;
    } catch (error) {
      await handleFailure(env.DB, job, error);
      log.warn("deletion_job_retry", {
        jobId: job.id,
        errorCode: safeErrorCode(error),
        attempt: job.job_type === "MESSAGE" ? job.attempts : job.attempts + 1,
      });
      report.failed += 1;
    }
  }
  return report;
}

export async function deletionJobCounts(
  db: D1Database,
): Promise<Array<{ state: string; count: number }>> {
  const { results } = await db
    .prepare(`SELECT state, COUNT(*) AS count FROM deletion_jobs GROUP BY state ORDER BY state`)
    .all<{ state: string; count: number }>();
  return (results ?? []).map((row) => ({ state: row.state, count: Number(row.count) }));
}

export async function failedDeletionJobs(db: D1Database): Promise<
  Array<{
    id: string;
    jobType: string;
    errorCode: string | null;
    attempts: number;
    updatedAt: string;
  }>
> {
  const { results } = await db
    .prepare(
      `SELECT id, job_type, error_code, attempts, updated_at FROM deletion_jobs
       WHERE state = 'FAILED' ORDER BY updated_at DESC LIMIT 100`,
    )
    .all<{
      id: string;
      job_type: string;
      error_code: string | null;
      attempts: number;
      updated_at: string;
    }>();
  return (results ?? []).map((job) => ({
    id: job.id,
    jobType: job.job_type,
    errorCode: job.error_code,
    attempts: job.attempts,
    updatedAt: job.updated_at,
  }));
}

export async function retryDeletionJob(
  db: D1Database,
  id: string,
): Promise<{ found: boolean; state?: string }> {
  await db
    .prepare(
      `UPDATE deletion_jobs SET state = 'PENDING', attempts = 0, next_attempt_at = ?2,
         lease_until = NULL, error_code = NULL, updated_at = ?2
       WHERE id = ?1 AND state = 'FAILED'`,
    )
    .bind(id, nowIso())
    .run();
  const job = await db
    .prepare(`SELECT state FROM deletion_jobs WHERE id = ?1`)
    .bind(id)
    .first<{ state: string }>();
  return job ? { found: true, state: job.state } : { found: false };
}
