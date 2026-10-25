import { nowIso } from "../lib/util";

/**
 * Server-side drafts (plan B4): the compose-in-progress, kept in the vault so it follows
 * the owner between devices instead of living in one browser's storage. One row per
 * composer slot — "compose", or "reply-<message id>" — upserted on every autosave.
 */

export interface DraftRow {
  id: string;
  from_address: string | null;
  to_text: string | null;
  cc_text: string | null;
  bcc_text: string | null;
  subject: string | null;
  text: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Draft {
  id: string;
  fromAddress: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  text: string | null;
  replyToMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

const toDraft = (r: DraftRow): Draft => ({
  id: r.id,
  fromAddress: r.from_address,
  to: r.to_text,
  cc: r.cc_text,
  bcc: r.bcc_text,
  subject: r.subject,
  text: r.text,
  replyToMessageId: r.reply_to_message_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface DraftInput {
  id: string;
  fromAddress?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  replyToMessageId?: string;
}

export async function upsertDraft(db: D1Database, input: DraftInput): Promise<Draft> {
  const existing = await db.prepare(`SELECT * FROM drafts WHERE id = ?1`).bind(input.id).first<DraftRow>();
  const now = nowIso();
  if (existing) {
    await db
      .prepare(
        `UPDATE drafts SET from_address=?2, to_text=?3, cc_text=?4, bcc_text=?5, subject=?6,
         text=?7, reply_to_message_id=?8, updated_at=?9 WHERE id=?1`,
      )
      .bind(
        input.id,
        input.fromAddress ?? null,
        input.to ?? null,
        input.cc ?? null,
        input.bcc ?? null,
        input.subject ?? null,
        input.text ?? null,
        input.replyToMessageId ?? null,
        now,
      )
      .run();
    return toDraft({
      ...existing,
      from_address: input.fromAddress ?? null,
      to_text: input.to ?? null,
      cc_text: input.cc ?? null,
      bcc_text: input.bcc ?? null,
      subject: input.subject ?? null,
      text: input.text ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      updated_at: now,
    });
  }
  const row: DraftRow = {
    id: input.id,
    from_address: input.fromAddress ?? null,
    to_text: input.to ?? null,
    cc_text: input.cc ?? null,
    bcc_text: input.bcc ?? null,
    subject: input.subject ?? null,
    text: input.text ?? null,
    reply_to_message_id: input.replyToMessageId ?? null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO drafts (id, from_address, to_text, cc_text, bcc_text, subject, text, reply_to_message_id, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
    .bind(row.id, row.from_address, row.to_text, row.cc_text, row.bcc_text, row.subject, row.text, row.reply_to_message_id, row.created_at, row.updated_at)
    .run();
  return toDraft(row);
}

export async function getDraft(db: D1Database, id: string): Promise<Draft | null> {
  const row = await db.prepare(`SELECT * FROM drafts WHERE id = ?1`).bind(id).first<DraftRow>();
  return row ? toDraft(row) : null;
}

export async function listDrafts(db: D1Database): Promise<Draft[]> {
  const { results } = await db
    .prepare(`SELECT * FROM drafts ORDER BY updated_at DESC LIMIT 50`)
    .all<DraftRow>();
  return (results ?? []).map(toDraft);
}

export async function deleteDraft(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM drafts WHERE id = ?1`).bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
