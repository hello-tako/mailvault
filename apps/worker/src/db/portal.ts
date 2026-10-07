import type { AuthVerdict, ExtractedCode, PortalGrant } from "@mailvault/shared";
import { newId, nowIso, randomToken } from "../lib/util";
import type { PortalCandidate } from "../portal/code";

/**
 * Grants: the only thing a customer is ever given.
 *
 * A grant is a row that says "this random string may read the newest code for this alias until
 * this moment". The link itself is never stored — only its SHA-256 — so reading the database
 * does not hand over a working portal, and there is no column an attacker can enumerate
 * against. Revoking is a timestamp, not a delete, so the audit trail of who was shown what
 * survives the sale.
 */

interface GrantRow {
  id: string;
  alias_id: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  max_views: number | null;
  views: number;
  last_seen_at: string | null;
  revoked_at: string | null;
}

function toGrant(row: GrantRow): PortalGrant {
  return {
    id: row.id,
    aliasId: row.alias_id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxViews: row.max_views,
    views: Number(row.views),
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

const SELECT_GRANT = `SELECT id, alias_id, label, created_at, expires_at, max_views, views, last_seen_at, revoked_at
   FROM portal_grants`;

/** A 192-bit link: long enough that no one arrives at one by accident or by guessing. */
export function newGrantToken(): string {
  return randomToken(24);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CreateGrantInput {
  aliasId: string;
  label?: string | null;
  ttlMinutes: number;
  maxViews?: number | null;
}

/** Returns the token exactly once — it is the half of the pair only the customer holds. */
export async function createGrant(db: D1Database, input: CreateGrantInput): Promise<{ grant: PortalGrant; token: string }> {
  const token = newGrantToken();
  const id = newId();
  const created = nowIso();
  const expires = new Date(Date.now() + input.ttlMinutes * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO portal_grants (id, alias_id, token_hash, label, created_at, expires_at, max_views, views)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
    )
    .bind(id, input.aliasId, await hashToken(token), input.label ?? null, created, expires, input.maxViews ?? null)
    .run();
  return {
    grant: {
      id,
      aliasId: input.aliasId,
      label: input.label ?? null,
      createdAt: created,
      expiresAt: expires,
      maxViews: input.maxViews ?? null,
      views: 0,
      lastSeenAt: null,
      revokedAt: null,
    },
    token,
  };
}

export async function findGrantByToken(db: D1Database, token: string): Promise<PortalGrant | null> {
  const row = await db.prepare(`${SELECT_GRANT} WHERE token_hash = ?1`).bind(await hashToken(token)).first<GrantRow>();
  return row ? toGrant(row) : null;
}

/** One more pair of eyes on the code, recorded so a link can be capped. */
export async function touchGrant(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE portal_grants SET views = views + 1, last_seen_at = ?2 WHERE id = ?1`)
    .bind(id, nowIso())
    .run();
}

export async function listGrants(db: D1Database, aliasId: string): Promise<PortalGrant[]> {
  const { results } = await db
    .prepare(`${SELECT_GRANT} WHERE alias_id = ?1 ORDER BY created_at DESC LIMIT 50`)
    .bind(aliasId)
    .all<GrantRow>();
  return (results ?? []).map(toGrant);
}

/** Scoped to the alias so a guessed grant id from another row cannot be revoked by it. */
export async function revokeGrant(db: D1Database, id: string, aliasId: string): Promise<number> {
  const { meta } = await db
    .prepare(`UPDATE portal_grants SET revoked_at = ?3 WHERE id = ?1 AND alias_id = ?2 AND revoked_at IS NULL`)
    .bind(id, aliasId, nowIso())
    .run();
  return Number(meta.changes ?? 0);
}

/**
 * The messages a portal answer may be built from: inbound only, inside the window, and only
 * those where something was actually extracted. The freshness rule lives in `pickPortalCode`,
 * so this stays a plain read.
 */
export async function portalCandidates(db: D1Database, aliasId: string, sinceIso: string): Promise<PortalCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, received_at, auth_verdict, extracted_codes_json
         FROM messages
        WHERE alias_id = ?1 AND direction = 'IN' AND received_at >= ?2
          AND extracted_codes_json IS NOT NULL AND extracted_codes_json <> '[]'
        ORDER BY received_at DESC LIMIT 25`,
    )
    .bind(aliasId, sinceIso)
    .all<{ id: string; received_at: string; auth_verdict: string; extracted_codes_json: string }>();

  return (results ?? []).map((row) => ({
    messageId: row.id,
    receivedAt: row.received_at,
    authVerdict: row.auth_verdict as AuthVerdict,
    codes: parseCodes(row.extracted_codes_json),
  }));
}

function parseCodes(raw: string): ExtractedCode[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExtractedCode[]) : [];
  } catch {
    return [];
  }
}
