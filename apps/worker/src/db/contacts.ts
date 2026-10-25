import { newId, nowIso } from "../lib/util";

/**
 * The owner's own address book (B10): addresses chosen and kept, offered first by the
 * composer's autocomplete. Correspondence history stays a separate suggestion source — a
 * contact is a decision, not a side effect of receiving mail.
 */

export interface Contact {
  id: string;
  address: string;
  name: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listContacts(db: D1Database, q?: string): Promise<Contact[]> {
  const like = `%${(q ?? "").replace(/[%_]/g, "")}%`;
  const { results } = await (q
    ? db
        .prepare(
          `SELECT * FROM contacts WHERE address LIKE ?1 OR name LIKE ?1 ORDER BY address LIMIT 100`,
        )
        .bind(like)
    : db.prepare(`SELECT * FROM contacts ORDER BY address LIMIT 100`)
  ).all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    address: String(r.address),
    name: (r.name as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

/** Upsert by address: saving the same sender twice is an update, never a duplicate. */
export async function upsertContact(
  db: D1Database,
  input: { address: string; name?: string | null; note?: string | null },
): Promise<Contact> {
  const address = input.address.trim().toLowerCase();
  const now = nowIso();
  const existing = await db
    .prepare(`SELECT * FROM contacts WHERE address = ?1`)
    .bind(address)
    .first<Record<string, unknown>>();
  if (existing) {
    await db
      .prepare(`UPDATE contacts SET name = COALESCE(?2, name), note = COALESCE(?3, note), updated_at = ?4 WHERE id = ?1`)
      .bind(String(existing.id), input.name ?? null, input.note ?? null, now)
      .run();
    return {
      id: String(existing.id),
      address,
      name: input.name ?? (existing.name as string | null),
      note: input.note ?? (existing.note as string | null),
      createdAt: String(existing.created_at),
      updatedAt: now,
    };
  }
  const id = newId();
  await db
    .prepare(`INSERT INTO contacts (id, address, name, note, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)`)
    .bind(id, address, input.name ?? null, input.note ?? null, now)
    .run();
  return { id, address, name: input.name ?? null, note: input.note ?? null, createdAt: now, updatedAt: now };
}

export async function deleteContact(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM contacts WHERE id = ?1`).bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
