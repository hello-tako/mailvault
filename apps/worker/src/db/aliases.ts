import { visibleMessageSql } from "./visibility";
import type { Alias, AliasStats, AliasStatus } from "@mailvault/shared";
import { conflict } from "../lib/errors";
import { newId, nowIso } from "../lib/util";
import { toAlias } from "./mappers";
import type { AliasRow } from "./rows";

export interface NewAlias {
  domainId: string;
  domainName: string;
  localPart: string;
  label: string | null;
}

export async function createAlias(db: D1Database, input: NewAlias): Promise<Alias> {
  const address = `${input.localPart}@${input.domainName.toLowerCase()}`;
  const now = nowIso();
  const id = newId();
  try {
    await db
      .prepare(
        `INSERT INTO aliases (id, domain_id, local_part, address, label, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'ACTIVE', ?6, ?6)`,
      )
      .bind(id, input.domainId, input.localPart, address, input.label, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw conflict("That alias already exists on this domain", { address });
    }
    throw err;
  }
  const created = await getAliasById(db, id);
  if (!created) throw new Error("alias insert did not persist");
  return created;
}

export async function getAliasById(db: D1Database, id: string): Promise<Alias | null> {
  const row = await db
    .prepare(
      `SELECT a.*, d.name AS domain_name,
        (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id AND ${visibleMessageSql()}) AS message_count
       FROM aliases a JOIN domains d ON d.id = a.domain_id WHERE a.id = ?1`,
    )
    .bind(id)
    .first<AliasRow>();
  return row ? toAlias(row) : null;
}

export type AliasListView = "all" | "active" | "archived";

export async function listAliases(
  db: D1Database,
  q?: string,
  view: AliasListView = "active",
): Promise<Alias[]> {
  const like = q ? `%${q.toLowerCase().replace(/\s+/g, "%")}%` : null;
  const sql = `
    SELECT a.*, d.name AS domain_name,
      (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id AND ${visibleMessageSql()}) AS message_count,
      (SELECT COUNT(*) FROM messages m WHERE m.alias_id = a.id AND ${visibleMessageSql()} AND m.is_read = 0) AS unread_count
    FROM aliases a JOIN domains d ON d.id = a.domain_id
    WHERE (?2 = 'all' OR (?2 = 'archived' AND a.archived = 1) OR (?2 = 'active' AND a.archived = 0))
      AND (?1 IS NULL OR lower(a.address) LIKE ?1 OR lower(COALESCE(a.label,'')) LIKE ?1 OR lower(COALESCE(a.notes,'')) LIKE ?1)
    ORDER BY a.pinned DESC, a.created_at DESC`;
  const { results } = await db.prepare(sql).bind(like, view).all<AliasRow>();
  return (results ?? []).map(toAlias);
}

/** Arrival history for one alias: counts, span and who actually writes to it. */
export async function aliasStats(db: D1Database, id: string): Promise<AliasStats> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(is_read = 0), 0) AS unread,
              MIN(received_at) AS first_received_at,
              MAX(received_at) AS last_received_at
       FROM messages m WHERE alias_id = ?1 AND ${visibleMessageSql()}`,
    )
    .bind(id)
    .first<{
      messages: number;
      unread: number;
      first_received_at: string | null;
      last_received_at: string | null;
    }>();
  const { results } = await db
    .prepare(
      `SELECT COALESCE(header_from, envelope_from) AS name, COUNT(*) AS count
       FROM messages m WHERE alias_id = ?1 AND ${visibleMessageSql()}
       GROUP BY name ORDER BY count DESC, name ASC LIMIT 6`,
    )
    .bind(id)
    .all<{ name: string | null; count: number }>();
  return {
    messages: Number(totals?.messages ?? 0),
    unread: Number(totals?.unread ?? 0),
    firstReceivedAt: totals?.first_received_at ?? null,
    lastReceivedAt: totals?.last_received_at ?? null,
    senders: (results ?? [])
      .filter((r) => r.name)
      .map((r) => ({ name: r.name as string, count: Number(r.count) })),
  };
}

/** Used by the inbound handler: only ACTIVE aliases receive mail. */
export async function findActiveAliasByAddress(
  db: D1Database,
  address: string,
): Promise<Alias | null> {
  const row = await db
    .prepare(`SELECT * FROM aliases WHERE address = ?1 AND status = 'ACTIVE'`)
    .bind(address.toLowerCase())
    .first<AliasRow>();
  return row ? toAlias(row) : null;
}

export async function aliasExists(
  db: D1Database,
  domainId: string,
  localPart: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM aliases WHERE domain_id = ?1 AND local_part = ?2`)
    .bind(domainId, localPart)
    .first<{ x: number }>();
  return !!row;
}

export async function setAliasStatus(
  db: D1Database,
  id: string,
  status: AliasStatus,
): Promise<void> {
  await db
    .prepare(`UPDATE aliases SET status = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, status, nowIso())
    .run();
}

export interface AliasPatch {
  label?: string | null;
  notes?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

/** Field-preserving update: pinning an alias must not blank its notes, and vice versa. */
export async function updateAlias(db: D1Database, id: string, patch: AliasPatch): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [id];
  const put = (col: string, val: unknown) => {
    binds.push(val);
    sets.push(`${col} = ?${binds.length}`);
  };
  if ("label" in patch) put("label", patch.label ?? null);
  if ("notes" in patch) put("notes", patch.notes ?? null);
  if ("pinned" in patch) put("pinned", patch.pinned ? 1 : 0);
  if ("archived" in patch) put("archived", patch.archived ? 1 : 0);
  if (sets.length === 0) return;
  binds.push(nowIso());
  sets.push(`updated_at = ?${binds.length}`);
  await db
    .prepare(`UPDATE aliases SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(...binds)
    .run();
}

/** Returns the R2 keys that must be removed after the DB rows are deleted. */
export async function deleteAlias(
  db: D1Database,
  id: string,
  purgeMessages: boolean,
): Promise<{ rawKeys: string[] }> {
  if (purgeMessages) throw new Error("alias_purge_requires_durable_job");
  // Permanent purge uses requestAliasPurge; this helper only detaches preserved mail.
  await db.prepare(`DELETE FROM aliases WHERE id = ?1`).bind(id).run();
  return { rawKeys: [] };
}

export async function collectMessageR2KeysForAlias(
  db: D1Database,
  aliasId: string,
): Promise<string[]> {
  const msgs = await db
    .prepare(
      `SELECT raw_r2_key, parsed_r2_key FROM messages m WHERE alias_id = ?1 AND ${visibleMessageSql()}`,
    )
    .bind(aliasId)
    .all<{ raw_r2_key: string; parsed_r2_key: string | null }>();
  const atts = await db
    .prepare(
      `SELECT r2_key FROM attachments WHERE message_id IN (SELECT id FROM messages m WHERE alias_id = ?1 AND ${visibleMessageSql()})`,
    )
    .bind(aliasId)
    .all<{ r2_key: string }>();
  const set = new Set<string>();
  for (const r of msgs.results ?? []) {
    set.add(r.raw_r2_key);
    if (r.parsed_r2_key) set.add(r.parsed_r2_key);
  }
  for (const a of atts.results ?? []) set.add(a.r2_key);
  return [...set];
}
