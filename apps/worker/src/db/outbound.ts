import { newId, nowIso } from "../lib/util";
import { visibleMessageSql } from "./visibility";

export interface OutboundJob {
  idempotency_key: string;
  request_hash: string;
  message_id: string;
  state: "STAGING" | "DISPATCHING" | "ACCEPTED" | "FAILED" | "DELETED";
  provider_message_id: string | null;
  error_code: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
}

export async function getOutboundJob(db: D1Database, key: string): Promise<OutboundJob | null> {
  return db
    .prepare("SELECT * FROM outbound_jobs WHERE idempotency_key=?1")
    .bind(key)
    .first<OutboundJob>();
}

/** Record every deterministic object key before the first R2 write. */
export async function registerOutboundStaging(
  db: D1Database,
  key: string,
  lease: string,
  aliasId: string,
  keys: string[],
): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO outbound_staging
         (message_id, idempotency_key, alias_id, r2_keys_json, lease_token, lease_expires_at)
       SELECT o.message_id, o.idempotency_key, a.id, ?4, o.lease_token, o.lease_expires_at
       FROM outbound_jobs o JOIN aliases a ON a.id = ?3
       WHERE o.idempotency_key = ?1 AND o.lease_token = ?2 AND o.state = 'STAGING'
         AND o.lease_expires_at > ?5 AND a.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs d WHERE d.job_type = 'ALIAS_PURGE' AND d.alias_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs d WHERE d.job_type = 'MESSAGE' AND d.message_id = o.message_id)
       ON CONFLICT(message_id) DO UPDATE SET
         lease_token = excluded.lease_token,
         lease_expires_at = excluded.lease_expires_at,
         uncertain = CASE
           WHEN outbound_staging.lease_token IS NOT NULL
             AND outbound_staging.lease_expires_at <= ?5
             AND outbound_staging.writes_started = 1
             AND outbound_staging.writes_settled = 0 THEN 1
           ELSE outbound_staging.uncertain
         END
       WHERE outbound_staging.idempotency_key = excluded.idempotency_key
         AND outbound_staging.alias_id = excluded.alias_id
         AND outbound_staging.r2_keys_json = excluded.r2_keys_json
         AND (outbound_staging.lease_token IS NULL OR outbound_staging.lease_expires_at <= ?5)`,
    )
    .bind(key, lease, aliasId, JSON.stringify([...new Set(keys)]), now)
    .run();
  return result.meta.changes > 0;
}

export async function beginOutboundR2Write(
  db: D1Database,
  key: string,
  lease: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbound_staging SET writes_started = 1, writes_settled = 0
       WHERE idempotency_key = ?1 AND lease_token = ?2
         AND EXISTS (SELECT 1 FROM outbound_jobs o WHERE o.idempotency_key = ?1
           AND o.lease_token = ?2 AND o.state = 'STAGING')
         AND EXISTS (SELECT 1 FROM aliases a WHERE a.id = outbound_staging.alias_id AND a.status = 'ACTIVE')
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs d WHERE d.job_type = 'ALIAS_PURGE'
           AND d.alias_id = outbound_staging.alias_id)`,
    )
    .bind(key, lease)
    .run();
  return result.meta.changes > 0;
}

export async function settleOutboundR2Writes(
  db: D1Database,
  key: string,
  lease: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE outbound_staging SET writes_settled = 1
       WHERE idempotency_key = ?1 AND lease_token = ?2`,
    )
    .bind(key, lease)
    .run();
  return result.meta.changes > 0;
}

export async function cancelOutboundStaging(
  db: D1Database,
  key: string,
  lease: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE outbound_jobs SET state = 'DELETED', lease_token = NULL, lease_expires_at = NULL,
         updated_at = ?3 WHERE idempotency_key = ?1 AND lease_token = ?2 AND state = 'STAGING'`,
    )
    .bind(key, lease, nowIso())
    .run();
}

/** The complete D1 attachment manifest now makes these R2 keys independently discoverable. */
export async function completeOutboundStaging(
  db: D1Database,
  key: string,
  lease: string,
): Promise<boolean> {
  const result = await db.batch([
    db
      .prepare(
        `UPDATE outbound_staging SET lease_token = NULL, lease_expires_at = NULL
         WHERE idempotency_key = ?1 AND lease_token = ?2 AND writes_settled = 1`,
      )
      .bind(key, lease),
    db
      .prepare(
        `DELETE FROM outbound_staging
         WHERE idempotency_key = ?1 AND lease_token IS NULL AND uncertain = 0
           AND NOT EXISTS (SELECT 1 FROM deletion_jobs d
             WHERE (d.job_type = 'MESSAGE' AND d.message_id = outbound_staging.message_id)
                OR (d.job_type = 'ALIAS_PURGE' AND d.alias_id = outbound_staging.alias_id))`,
      )
      .bind(key),
  ]);
  return result[0]?.meta.changes === 1;
}

export async function reserveOutbound(
  db: D1Database,
  key: string,
  hash: string,
  limit: number,
): Promise<{ job: OutboundJob | null; lease: string | null }> {
  const at = nowIso();
  const since = `${at.slice(0, 10)}T00:00:00.000Z`;
  const token = newId();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO outbound_jobs
    (idempotency_key,request_hash,message_id,state,lease_token,lease_expires_at,created_at,updated_at)
    SELECT ?1,?2,?3,'STAGING',?4,?5,?6,?6
    WHERE (SELECT COUNT(*) FROM outbound_jobs WHERE created_at >= ?7 AND (quota_charged=1 OR (state='STAGING' AND lease_expires_at > ?6))) +
      (SELECT COUNT(*) FROM messages m WHERE direction='OUT' AND received_at >= ?7
       AND COALESCE(send_status,'QUEUED') NOT IN ('FAILED','SUPPRESSED')
       AND NOT EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id)) < ?8
    ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .bind(key, hash, newId(), token, expires, at, since, limit)
    .run();
  let job = await getOutboundJob(db, key);
  if (!job || job.request_hash !== hash || job.state !== "STAGING") return { job, lease: null };
  if (job.lease_token !== token) {
    const result = await db
      .prepare(
        `UPDATE outbound_jobs SET lease_token=?2,lease_expires_at=?3,updated_at=?4
      WHERE idempotency_key=?1 AND request_hash=?5 AND state='STAGING'
      AND (lease_token IS NULL OR lease_expires_at <= ?4)
      AND (SELECT COUNT(*) FROM outbound_jobs WHERE created_at >= ?6 AND idempotency_key <> ?1
        AND (quota_charged=1 OR (state='STAGING' AND lease_expires_at > ?4))) +
        (SELECT COUNT(*) FROM messages m WHERE direction='OUT' AND received_at >= ?6
         AND COALESCE(send_status,'QUEUED') NOT IN ('FAILED','SUPPRESSED')
         AND NOT EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id)) < ?7`,
      )
      .bind(key, token, expires, at, hash, since, limit)
      .run();
    if (!result.meta.changes) return { job, lease: null };
    job = (await getOutboundJob(db, key))!;
  }
  return { job, lease: token };
}

export async function releaseOutbound(db: D1Database, key: string, lease: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE outbound_jobs SET lease_token=NULL,lease_expires_at=NULL WHERE idempotency_key=?1 AND lease_token=?2 AND state IN ('STAGING','DELETED')",
      )
      .bind(key, lease),
    db
      .prepare(
        `UPDATE outbound_staging SET lease_token = NULL, lease_expires_at = NULL
         WHERE idempotency_key = ?1 AND lease_token = ?2`,
      )
      .bind(key, lease),
  ]);
}

export async function beginDispatch(
  db: D1Database,
  key: string,
  lease: string,
  messageId: string,
): Promise<void> {
  // This marker is irreversible: a crash from here cannot justify a second transport call.
  const result = await db.batch([
    db
      .prepare(
        `UPDATE outbound_jobs SET state='DISPATCHING',quota_charged=1,updated_at=?3
      WHERE idempotency_key=?1 AND lease_token=?2 AND state='STAGING' AND lease_expires_at > ?3
        AND EXISTS(SELECT 1 FROM messages m WHERE m.id=outbound_jobs.message_id
          AND ${visibleMessageSql()} AND m.send_status='PREPARING')`,
      )
      .bind(key, lease, nowIso()),
    db
      .prepare(
        `UPDATE messages SET send_status='UNKNOWN',send_error='Provider acceptance not yet confirmed'
      WHERE id=?1 AND EXISTS(SELECT 1 FROM outbound_jobs WHERE message_id=?1 AND state='DISPATCHING' AND lease_token=?2)`,
      )
      .bind(messageId, lease),
  ]);
  if (!result[0]?.meta.changes)
    throw new Error("Outbound staging lease expired; retry the same key");
}

export async function finishOutbound(
  db: D1Database,
  key: string,
  state: "ACCEPTED" | "FAILED",
  providerId: string | null,
  code: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE outbound_jobs SET state=?2,quota_charged=CASE WHEN ?2='FAILED' THEN 0 ELSE 1 END,provider_message_id=?3,error_code=?4,
          lease_token=NULL,lease_expires_at=NULL,updated_at=?5 WHERE idempotency_key=?1 AND state IN ('STAGING','DISPATCHING')`,
      )
      .bind(key, state, providerId, code, nowIso()),
    db
      .prepare(
        `UPDATE outbound_staging SET lease_token = NULL, lease_expires_at = NULL, writes_settled = 1
         WHERE idempotency_key = ?1`,
      )
      .bind(key),
  ]);
}
