import type { InsertAttachmentInput } from "./messages";
import { log } from "../lib/logging";
import { nowIso } from "../lib/util";

export type IngestStatus = "RULES_PENDING" | "SEMANTIC_PENDING" | "COMMITTED" | null;

export interface IngestRecord {
  id: string;
  domainId: string;
  aliasId: string;
  dedupeKey: string;
  rawKey: string;
  parsedKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  status: IngestStatus;
  deletionPending: boolean;
}

export interface InboundStagingInput {
  messageId: string;
  dedupeKey: string;
  aliasId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  objectKeys: string[];
}

export interface InboundStagingCleanup {
  writesSettled: boolean;
  messageId: string;
  dedupeKey: string;
  objectKeys: string[];
}

interface IngestRow {
  id: string;
  domain_id: string;
  alias_id: string | null;
  dedupe_key: string;
  raw_r2_key: string;
  parsed_r2_key: string | null;
  envelope_from: string | null;
  envelope_to: string | null;
  ingest_status: IngestStatus;
  deletion_pending: number;
}

function mapRecord(row: IngestRow): IngestRecord | null {
  if (!row.alias_id || !row.parsed_r2_key || !row.envelope_from || !row.envelope_to) return null;
  return {
    id: row.id,
    domainId: row.domain_id,
    aliasId: row.alias_id,
    dedupeKey: row.dedupe_key,
    rawKey: row.raw_r2_key,
    parsedKey: row.parsed_r2_key,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    status: row.ingest_status,
    deletionPending: row.deletion_pending === 1,
  };
}

export async function findIngestByDedupeKey(
  db: D1Database,
  key: string,
): Promise<IngestRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, domain_id, alias_id, dedupe_key, raw_r2_key, parsed_r2_key,
              envelope_from, envelope_to, ingest_status, deletion_pending
       FROM messages WHERE dedupe_key = ?1`,
    )
    .bind(key)
    .first<IngestRow>();
  return row ? mapRecord(row) : null;
}

export async function findIngestById(db: D1Database, id: string): Promise<IngestRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, domain_id, alias_id, dedupe_key, raw_r2_key, parsed_r2_key,
              envelope_from, envelope_to, ingest_status, deletion_pending
       FROM messages WHERE id = ?1`,
    )
    .bind(id)
    .first<IngestRow>();
  return row ? mapRecord(row) : null;
}

/** A pending or completed cleanup blocks retries for this canonical identity. */
export async function isIngestDeletionBlocked(
  db: D1Database,
  messageId: string,
  dedupeKey: string,
  aliasId: string | null = null,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
           AND (message_id = ?1 OR dedupe_key = ?2))
         OR EXISTS(SELECT 1 FROM inbound_staging WHERE message_id = ?1 AND state = 'TOMBSTONED')
         OR EXISTS(SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE' AND alias_id = ?3) AS tombstoned,
         EXISTS(SELECT 1 FROM messages WHERE id = ?1 AND deletion_pending = 1) AS deleting`,
    )
    .bind(messageId, dedupeKey, aliasId)
    .first<{ tombstoned: number; deleting: number }>();
  return Number(row?.tombstoned ?? 0) === 1 || Number(row?.deleting ?? 0) === 1;
}

/** Persist the complete R2 write set before a staging writer can issue its first put. */
export async function beginInboundStaging(
  db: D1Database,
  input: InboundStagingInput,
): Promise<boolean> {
  const objectKeys = [...new Set(input.objectKeys.filter(Boolean))];
  if (objectKeys.length !== input.objectKeys.length)
    throw new Error("inbound_staging_keys_invalid");
  const now = nowIso();
  try {
    const created = await db
      .prepare(
        `INSERT INTO inbound_staging
         (message_id, dedupe_key, alias_id, state, lease_token, lease_expires_at, writes_settled, created_at, updated_at)
       SELECT ?1, ?2, ?3, 'WRITING', ?4, ?5, 0, ?6, ?6
       WHERE EXISTS (SELECT 1 FROM aliases WHERE id = ?3 AND status = 'ACTIVE')
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE
         (job_type = 'MESSAGE' AND (message_id = ?1 OR dedupe_key = ?2))
         OR (job_type = 'ALIAS_PURGE' AND alias_id = ?3))`,
      )
      .bind(
        input.messageId,
        input.dedupeKey,
        input.aliasId,
        input.leaseToken,
        input.leaseExpiresAt,
        now,
      )
      .run();
    if (Number(created.meta.changes ?? 0) !== 1) return false;

    const statements = objectKeys.map((key) =>
      db
        .prepare(
          `INSERT INTO inbound_staging_objects (message_id, r2_key)
         SELECT s.message_id, ?2 FROM inbound_staging s
         WHERE s.message_id = ?1 AND s.state = 'WRITING' AND s.lease_token = ?3
           AND s.lease_expires_at > ?4
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
             AND (message_id = s.message_id OR dedupe_key = s.dedupe_key))
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'
             AND alias_id = s.alias_id)`,
        )
        .bind(input.messageId, key, input.leaseToken, now),
    );
    const inserted = statements.length === 0 ? [] : await db.batch(statements);
    if (inserted.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      await settleUnstartedInboundStaging(db, input.messageId, input.leaseToken);
      return false;
    }
    const writable = await isInboundStagingWritable(db, input.messageId, input.leaseToken);
    if (!writable) await settleUnstartedInboundStaging(db, input.messageId, input.leaseToken);
    return writable;
  } catch (error) {
    await settleUnstartedInboundStaging(db, input.messageId, input.leaseToken).catch(() => {});
    throw error;
  }
}

// Only used before begin returns; no R2 operation can have started yet.
async function settleUnstartedInboundStaging(
  db: D1Database,
  messageId: string,
  leaseToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'TOMBSTONED', writes_settled = 1, updated_at = ?3
     WHERE message_id = ?1 AND lease_token = ?2 AND state IN ('WRITING', 'TOMBSTONED')`,
    )
    .bind(messageId, leaseToken, nowIso())
    .run();
}

/** A writer must check the D1 fence immediately before and after every R2 put. */
export async function isInboundStagingWritable(
  db: D1Database,
  messageId: string,
  leaseToken: string,
): Promise<boolean> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'TOMBSTONED', updated_at = ?3
       WHERE message_id = ?1 AND lease_token = ?2 AND state = 'WRITING'
         AND (lease_expires_at <= ?3 OR EXISTS (
           SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
             AND (message_id = inbound_staging.message_id OR dedupe_key = inbound_staging.dedupe_key)
         ) OR EXISTS (
           SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'
             AND alias_id = inbound_staging.alias_id
         ))`,
    )
    .bind(messageId, leaseToken, now)
    .run();
  const row = await db
    .prepare(
      `SELECT 1 AS writable FROM inbound_staging s
       WHERE s.message_id = ?1 AND s.lease_token = ?2 AND s.state = 'WRITING'
         AND s.lease_expires_at > ?3
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
           AND (message_id = s.message_id OR dedupe_key = s.dedupe_key))
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'
           AND alias_id = s.alias_id)`,
    )
    .bind(messageId, leaseToken, now)
    .first<{ writable: number }>();
  return Number(row?.writable ?? 0) === 1;
}

/** Settle every awaited R2 operation, keeping a deletion or expired lease fenced. */
export async function finishInboundStaging(
  db: D1Database,
  messageId: string,
  leaseToken: string,
): Promise<boolean> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE inbound_staging SET
         state = CASE WHEN state = 'WRITING' AND lease_expires_at > ?3
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
             AND (message_id = inbound_staging.message_id OR dedupe_key = inbound_staging.dedupe_key))
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'
             AND alias_id = inbound_staging.alias_id)
           THEN 'STAGED' ELSE 'TOMBSTONED' END,
         writes_settled = 1, cleanup_confirmed = 0, next_sweep_at = '1970-01-01T00:00:00.000Z', updated_at = ?3
       WHERE message_id = ?1 AND lease_token = ?2 AND state IN ('WRITING', 'TOMBSTONED')`,
    )
    .bind(messageId, leaseToken, now)
    .run();
  const row = await db
    .prepare(`SELECT state FROM inbound_staging WHERE message_id = ?1 AND lease_token = ?2`)
    .bind(messageId, leaseToken)
    .first<{ state: string }>();
  return row?.state === "STAGED";
}

/** Retain uncertain writes for repeated cleanup; lease expiry is not a purge receipt. */
export async function abandonInboundStaging(
  db: D1Database,
  messageId: string,
  leaseToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'TOMBSTONED', updated_at = ?3
       WHERE message_id = ?1 AND lease_token = ?2 AND state = 'WRITING'`,
    )
    .bind(messageId, leaseToken, nowIso())
    .run();
}

/** A discarded duplicate is no longer writing but its keys stay sweepable. */
export async function discardInboundStaging(db: D1Database, messageId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'TOMBSTONED', writes_settled = 1, updated_at = ?2
       WHERE message_id = ?1 AND state IN ('STAGED', 'TOMBSTONED')`,
    )
    .bind(messageId, nowIso())
    .run();
}

/** The R2 write set is now represented by durable message metadata. */
export async function markInboundStagingCommitted(
  db: D1Database,
  messageId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'COMMITTED', updated_at = ?2
       WHERE message_id = ?1 AND state = 'STAGED'
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE'
           AND (message_id = inbound_staging.message_id OR dedupe_key = inbound_staging.dedupe_key))
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'ALIAS_PURGE'
           AND alias_id = inbound_staging.alias_id)`,
    )
    .bind(messageId, nowIso())
    .run();
}

/** Return retained tombstones and expire any writer whose bounded lease elapsed. */
export async function listInboundStagingCleanup(
  db: D1Database,
  now = nowIso(),
  limit = 100,
): Promise<InboundStagingCleanup[]> {
  await db
    .prepare(
      `UPDATE inbound_staging SET state = 'TOMBSTONED', updated_at = ?1
       WHERE state = 'WRITING' AND lease_expires_at <= ?1`,
    )
    .bind(now)
    .run();
  const { results } = await db
    .prepare(
      `SELECT message_id, dedupe_key, writes_settled FROM inbound_staging
       WHERE state = 'TOMBSTONED' AND next_sweep_at <= ?1
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = inbound_staging.message_id)
         AND (writes_settled = 1 OR lease_expires_at <= ?1)
       ORDER BY next_sweep_at, updated_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ message_id: string; dedupe_key: string; writes_settled: number }>();
  const manifests: InboundStagingCleanup[] = [];
  for (const row of results ?? []) {
    const objects = await db
      .prepare(`SELECT r2_key FROM inbound_staging_objects WHERE message_id = ?1 ORDER BY r2_key`)
      .bind(row.message_id)
      .all<{ r2_key: string }>();
    manifests.push({
      writesSettled: row.writes_settled === 1,
      messageId: row.message_id,
      dedupeKey: row.dedupe_key,
      objectKeys: (objects.results ?? []).map(({ r2_key }) => r2_key),
    });
  }
  return manifests;
}

/** Keep tombstones due for retry after the caller's R2 delete attempt. */
export async function deferInboundStagingCleanup(
  db: D1Database,
  messageId: string,
  nextSweepAt: string,
  confirmed = false,
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_staging SET next_sweep_at = ?2, updated_at = ?3, cleanup_confirmed = ?4
       WHERE message_id = ?1 AND state = 'TOMBSTONED'`,
    )
    .bind(messageId, nextSweepAt, nowIso(), confirmed ? 1 : 0)
    .run();
}

/** Repeated sweeps retain keys even when a remote PUT may finish after a DELETE. */
export async function drainInboundStagingCleanup(db: D1Database, bucket: R2Bucket): Promise<void> {
  for (const manifest of await listInboundStagingCleanup(db)) {
    let confirmed = false;
    try {
      for (let start = 0; start < manifest.objectKeys.length; start += 1000) {
        await bucket.delete(manifest.objectKeys.slice(start, start + 1000));
      }
      confirmed = manifest.writesSettled;
    } catch {
      log.warn("inbound_staging_cleanup_failed", { messageId: manifest.messageId });
    }
    await deferInboundStagingCleanup(
      db,
      manifest.messageId,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      confirmed,
    );
  }
}

export async function ingestCoreComplete(
  db: D1Database,
  record: Pick<IngestRecord, "id" | "rawKey" | "parsedKey">,
  attachments: InsertAttachmentInput[],
): Promise<boolean> {
  const [message, storedAttachments, fts] = await Promise.all([
    db
      .prepare(`SELECT raw_r2_key, parsed_r2_key, attachment_count FROM messages WHERE id = ?1`)
      .bind(record.id)
      .first<{ raw_r2_key: string; parsed_r2_key: string | null; attachment_count: number }>(),
    db
      .prepare(`SELECT id, r2_key FROM attachments WHERE message_id = ?1`)
      .bind(record.id)
      .all<{ id: string; r2_key: string }>(),
    db
      .prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = ?1`)
      .bind(record.id)
      .first<{ count: number }>(),
  ]);
  if (
    message?.raw_r2_key !== record.rawKey ||
    message.parsed_r2_key !== record.parsedKey ||
    Number(message.attachment_count) !== attachments.length ||
    Number(fts?.count ?? 0) !== 1
  ) {
    return false;
  }
  const expected = attachments.map(({ id, r2Key }) => `${id}|${r2Key}`).sort();
  const actual = (storedAttachments.results ?? [])
    .map(({ id, r2_key }) => `${id}|${r2_key}`)
    .sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Core D1 artifacts share a transaction; R2 objects were verified before this batch. */
export async function reconcileIngestCore(
  db: D1Database,
  messageId: string,
  attachments: InsertAttachmentInput[],
  text: { subject: string | null; preview: string | null; sender: string | null },
): Promise<void> {
  const statements = attachments.map((attachment) =>
    db
      .prepare(
        `INSERT INTO attachments
          (id, message_id, filename, safe_filename, content_type, size, r2_key, content_id, created_at)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
         WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?2 AND deletion_pending = 0)
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?2)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        attachment.id,
        messageId,
        attachment.filename,
        attachment.safeFilename,
        attachment.contentType,
        attachment.size,
        attachment.r2Key,
        attachment.contentId,
        nowIso(),
      ),
  );
  statements.push(
    db
      .prepare(
        `DELETE FROM messages_fts WHERE message_id = ?1
         AND EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND deletion_pending = 0)
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)`,
      )
      .bind(messageId),
    db
      .prepare(
        `INSERT INTO messages_fts (message_id, subject, preview, sender)
         SELECT ?1,?2,?3,?4
         WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND deletion_pending = 0)
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)`,
      )
      .bind(messageId, text.subject ?? "", text.preview ?? "", text.sender ?? ""),
    db
      .prepare(
        `UPDATE messages SET ingest_status = CASE
           WHEN ingest_status IS NULL THEN 'RULES_PENDING' ELSE ingest_status END
         WHERE id = ?1 AND deletion_pending = 0
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)`,
      )
      .bind(messageId),
  );
  await db.batch(statements);

  if (await isIngestDeletionBlocked(db, messageId, "")) throw new Error("ingest_message_deleting");

  for (const attachment of attachments) {
    const row = await db
      .prepare(`SELECT message_id, r2_key FROM attachments WHERE id = ?1`)
      .bind(attachment.id)
      .first<{ message_id: string; r2_key: string }>();
    if (row?.message_id !== messageId || row.r2_key !== attachment.r2Key) {
      throw new Error("ingest_attachment_reconciliation_failed");
    }
  }
  await markInboundStagingCommitted(db, messageId);
}

/** Apply rule effects/hit counters once, atomically advancing the lifecycle state. */
export async function commitIngestRules(
  db: D1Database,
  messageId: string,
  applied: {
    archive: boolean;
    tag: string | null;
    ruleId: string | null;
    note: string | null;
    ruleIds: string[];
  },
): Promise<void> {
  const now = nowIso();
  const statements = applied.ruleIds.map((id) =>
    db
      .prepare(
        `UPDATE rules SET hits = hits + 1, last_hit_at = ?2
         WHERE id = ?1 AND EXISTS (
           SELECT 1 FROM messages WHERE id = ?3 AND ingest_status = 'RULES_PENDING'
             AND deletion_pending = 0
             AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?3)
         )`,
      )
      .bind(id, now, messageId),
  );
  statements.push(
    db
      .prepare(
        `UPDATE messages
         SET archived = ?2, rule_tag = ?3, applied_rule_id = ?4, applied_rule_note = ?5,
             ingest_status = 'SEMANTIC_PENDING'
         WHERE id = ?1 AND ingest_status = 'RULES_PENDING' AND deletion_pending = 0
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)`,
      )
      .bind(messageId, applied.archive ? 1 : 0, applied.tag, applied.ruleId, applied.note),
  );
  await db.batch(statements);
}

export async function completeIngest(db: D1Database, messageId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE messages SET ingest_status = 'COMMITTED' WHERE id = ?1 AND ingest_status = 'SEMANTIC_PENDING'
       AND deletion_pending = 0
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE job_type = 'MESSAGE' AND message_id = ?1)`,
    )
    .bind(messageId)
    .run();
}

/** Only return keys with no message or attachment reference; callers may then delete them. */
export async function unreferencedIngestKeys(db: D1Database, keys: string[]): Promise<string[]> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return [];
  const referenced = new Set<string>();
  for (let start = 0; start < unique.length; start += 20) {
    const chunk = unique.slice(start, start + 20);
    const slots = (offset: number) => chunk.map((_, i) => `?${offset + i + 1}`).join(",");
    const { results } = await db
      .prepare(
        `SELECT raw_r2_key AS key FROM messages WHERE raw_r2_key IN (${slots(0)})
         UNION SELECT parsed_r2_key AS key FROM messages WHERE parsed_r2_key IN (${slots(chunk.length)})
         UNION SELECT r2_key AS key FROM attachments WHERE r2_key IN (${slots(chunk.length * 2)})`,
      )
      .bind(...chunk, ...chunk, ...chunk)
      .all<{ key: string }>();
    for (const row of results ?? []) referenced.add(row.key);
  }
  return unique.filter((key) => !referenced.has(key));
}
