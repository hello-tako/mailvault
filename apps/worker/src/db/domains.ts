import type {
  AuthPolicy,
  ConflictDetails,
  DiscoveredZone,
  Domain,
  MailStatus,
} from "@mailvault/shared";
import { MailStatus as MS } from "@mailvault/shared";
import type { CatchAllStatus, ConflictType, RoutingStatus, SendingStatus } from "@mailvault/shared";
import { newId, nowIso } from "../lib/util";
import { toDomain } from "./mappers";
import type { DomainRow } from "./rows";

/**
 * Domain discovery stores rows; it never mutates Cloudflare. Provisioning state is
 * only changed through the explicit state machine, so sync must NOT reset a domain
 * that is already configured.
 */
export async function upsertDiscoveredZones(db: D1Database, zones: DiscoveredZone[]): Promise<void> {
  const now = nowIso();
  const stmts = zones.map((z) =>
    db
      .prepare(
        `INSERT INTO domains (
           id, cloudflare_zone_id, cloudflare_account_id, name, zone_status, zone_type,
           mail_status, routing_status, catch_all_status, conflict_type, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'DISCOVERED', 'UNKNOWN', 'UNKNOWN', 'NONE', ?7, ?7)
         ON CONFLICT(cloudflare_zone_id) DO UPDATE SET
           cloudflare_account_id = excluded.cloudflare_account_id,
           name                  = excluded.name,
           zone_status           = excluded.zone_status,
           zone_type             = excluded.zone_type,
           last_checked_at       = ?7,
           updated_at            = ?7`,
      )
      .bind(newId(), z.cloudflareZoneId, z.cloudflareAccountId, z.name.toLowerCase(), z.status, z.type, now),
  );
  if (stmts.length) await db.batch(stmts);
}

export async function listDomains(db: D1Database): Promise<Domain[]> {
  const { results } = await db.prepare(`SELECT * FROM domains ORDER BY name ASC`).all<DomainRow>();
  return (results ?? []).map(toDomain);
}

export async function getDomainByZoneId(db: D1Database, zoneId: string): Promise<Domain | null> {
  const row = await db
    .prepare(`SELECT * FROM domains WHERE cloudflare_zone_id = ?1`)
    .bind(zoneId)
    .first<DomainRow>();
  return row ? toDomain(row) : null;
}

export async function getDomainById(db: D1Database, id: string): Promise<Domain | null> {
  const row = await db.prepare(`SELECT * FROM domains WHERE id = ?1`).bind(id).first<DomainRow>();
  return row ? toDomain(row) : null;
}

/** Record a fresh, read-only delivery-path proof for customer OTP readiness. */
export async function markRoutingVerified(
  db: D1Database,
  zoneId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE domains
       SET routing_verified_at = ?2, updated_at = ?2
       WHERE cloudflare_zone_id = ?1`,
    )
    .bind(zoneId, nowIso())
    .run();
}

/** Clear delivery-path proof immediately when a watchdog check observes drift. */
export async function clearRoutingVerified(db: D1Database, zoneId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE domains
       SET routing_verified_at = NULL, updated_at = ?2
       WHERE cloudflare_zone_id = ?1`,
    )
    .bind(zoneId, nowIso())
    .run();
}

/** Owner-controlled enforcement level for unauthenticated senders on this domain. */
export async function setDomainAuthPolicy(db: D1Database, id: string, policy: AuthPolicy): Promise<number> {
  const res = await db
    .prepare(`UPDATE domains SET auth_policy = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, policy, nowIso())
    .run();
  return Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
}

/**
 * What MailVault currently believes about Email Sending for this domain, and when it last
 * asked Cloudflare. Kept apart from the receiving state machine on purpose: enabling sending
 * can never disturb MX routing, so a domain can send and fail to receive, or the reverse.
 */
export async function setDomainSending(
  db: D1Database,
  id: string,
  patch: { sendingStatus: SendingStatus; sendingTag?: string | null },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE domains
       SET sending_status = ?2, sending_tag = COALESCE(?3, sending_tag), sending_checked_at = ?4, updated_at = ?4
       WHERE id = ?1`,
    )
    .bind(id, patch.sendingStatus, patch.sendingTag ?? null, now)
    .run();
}

/**
 * Choose which Email Sending name this domain's mail leaves under, and forget what was believed
 * about the previous one.
 *
 * The reset is the point: `sending_status` describes the chosen name, so carrying over the old
 * name's verdict would let a domain read as sendable when the identity it now sends through has
 * never been looked at. `null` returns to sending as the domain itself.
 */
export async function setDomainSendingVia(db: D1Database, id: string, name: string | null): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE domains
       SET sending_via = ?2, sending_status = 'UNKNOWN', sending_tag = NULL, sending_checked_at = NULL, updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(id, name, now)
    .run();
}

export interface ProvisionPatch {
  mailStatus?: MailStatus;
  routingStatus?: RoutingStatus;
  catchAllStatus?: CatchAllStatus;
  conflictType?: ConflictType;
  conflictDetails?: ConflictDetails | null;
}

/** Narrow update of a domain's provisioning state (state machine persistence). */
export async function patchDomainProvisioning(
  db: D1Database,
  zoneId: string,
  patch: ProvisionPatch,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?${binds.length + 1}`);
    binds.push(val);
  };
  if (patch.mailStatus) push("mail_status", patch.mailStatus);
  if (patch.routingStatus) push("routing_status", patch.routingStatus);
  if (patch.catchAllStatus) push("catch_all_status", patch.catchAllStatus);
  if (patch.conflictType) push("conflict_type", patch.conflictType);
  if ("conflictDetails" in patch)
    push("conflict_details_json", patch.conflictDetails ? JSON.stringify(patch.conflictDetails) : null);
  push("last_checked_at", nowIso());
  push("updated_at", nowIso());
  binds.push(zoneId);
  await db
    .prepare(`UPDATE domains SET ${sets.join(", ")} WHERE cloudflare_zone_id = ?${binds.length}`)
    .bind(...binds)
    .run();
}

export async function recordProvisioningEvent(
  db: D1Database,
  domainId: string,
  event: string,
  status: string | null,
  details?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provisioning_events (id, domain_id, event, status, details_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(newId(), domainId, event, status, details ? JSON.stringify(details) : null, nowIso())
    .run();
}

export async function domainCountByStatus(
  db: D1Database,
): Promise<{ total: number; ready: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN mail_status = ?1 THEN 1 ELSE 0 END) AS ready
       FROM domains`,
    )
    .bind(MS.Ready)
    .first<{ total: number; ready: number }>();
  return { total: Number(row?.total ?? 0), ready: Number(row?.ready ?? 0) };
}
