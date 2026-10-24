import { newId, nowIso } from "../lib/util";

/**
 * Notification preferences (plan D1). Muting is a filter on the *interruption*, never on
 * the mail: storage, search and the archive behave identically either way.
 */

export interface NotificationPref {
  id: string;
  scopeType: "alias" | "sender_domain";
  scopeValue: string;
  action: "all" | "mute";
  createdAt: string;
  updatedAt: string;
}

interface PrefRow {
  id: string;
  scope_type: string;
  scope_value: string;
  action: string;
  created_at: string;
  updated_at: string;
}

const toPref = (r: PrefRow): NotificationPref => ({
  id: r.id,
  scopeType: r.scope_type === "sender_domain" ? "sender_domain" : "alias",
  scopeValue: r.scope_value,
  action: r.action === "mute" ? "mute" : "all",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listNotificationPrefs(db: D1Database): Promise<NotificationPref[]> {
  const { results } = await db
    .prepare(`SELECT * FROM notification_prefs ORDER BY scope_type, scope_value`)
    .all<PrefRow>();
  return (results ?? []).map(toPref);
}

export async function upsertNotificationPref(
  db: D1Database,
  scope: { scopeType: "alias" | "sender_domain"; scopeValue: string },
  action: "all" | "mute",
): Promise<NotificationPref> {
  const existing = await db
    .prepare(`SELECT * FROM notification_prefs WHERE scope_type = ?1 AND scope_value = ?2`)
    .bind(scope.scopeType, scope.scopeValue.toLowerCase())
    .first<PrefRow>();
  const now = nowIso();
  if (existing) {
    await db
      .prepare(`UPDATE notification_prefs SET action = ?3, updated_at = ?4 WHERE id = ?1`)
      .bind(existing.id, scope.scopeType, action, now)
      .run();
    return toPref({ ...existing, action, updated_at: now });
  }
  const pref: NotificationPref = {
    id: newId(),
    scopeType: scope.scopeType,
    scopeValue: scope.scopeValue.toLowerCase(),
    action,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO notification_prefs (id, scope_type, scope_value, action, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
    .bind(pref.id, pref.scopeType, pref.scopeValue, pref.action, pref.createdAt, pref.updatedAt)
    .run();
  return pref;
}

export async function deleteNotificationPref(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM notification_prefs WHERE id = ?1`).bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

const domainOf = (address: string): string => address.split("@")[1]?.toLowerCase() ?? "";

/**
 * The commit-time gate: true when either this exact alias or the sender's whole domain is
 * muted. One indexed read per stored message — the table is owner-sized.
 */
export async function isNotificationMuted(
  db: D1Database,
  mail: { aliasId: string; envelopeFrom: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM notification_prefs
       WHERE action = 'mute'
         AND ((scope_type = 'alias' AND scope_value = ?1)
           OR (scope_type = 'sender_domain' AND scope_value = ?2))
       LIMIT 1`,
    )
    .bind(mail.aliasId, domainOf(mail.envelopeFrom))
    .first<{ x: number }>();
  return !!row;
}
