import { SendStatus, type MessageRecipient } from "@mailvault/shared";
import { newId, nowIso } from "../lib/util";
import type { MessageRecipientRow } from "./rows";

/**
 * Per-destination delivery state for sent mail.
 *
 * `messages.send_status` is a summary and this is the evidence behind it: Email Sending
 * reports one event per (message, recipient), so a message addressed to three people
 * produces three answers and any single status would be wrong for at least two of them.
 */

/**
 * How far along a destination is, highest last.
 *
 * A status is only ever written when it ranks at least as high as what is stored, because
 * events for one message arrive in whatever order the queues deliver them: a `deferred`
 * retry report landing after the eventual `delivered` must not rewrite history.
 */
export const STATUS_RANK: Record<SendStatus, number> = {
  [SendStatus.Preparing]: -2,
  [SendStatus.Unknown]: -1,
  [SendStatus.Queued]: 0,
  [SendStatus.Deferred]: 1,
  [SendStatus.Delivered]: 2,
  // A complaint says the mail did arrive, which is further along than any delivery report,
  // but it is not a failure — see `aggregateStatus`.
  [SendStatus.Complained]: 3,
  [SendStatus.Bounced]: 4,
  [SendStatus.Rejected]: 4,
  [SendStatus.Suppressed]: 4,
  [SendStatus.Failed]: 4,
};

/** Statuses that settle a destination: nothing further is expected for them. */
const TERMINAL_FAILURES: SendStatus[] = [
  SendStatus.Bounced,
  SendStatus.Rejected,
  SendStatus.Suppressed,
  SendStatus.Failed,
];

function rankOf(status: SendStatus): number {
  return STATUS_RANK[status] ?? 0;
}

export interface RecipientWrite {
  address: string;
  list: "to" | "cc" | "bcc";
  status: SendStatus;
  smtpCode?: string | null;
  detail?: string | null;
}

/** Atomic upsert that refuses to move a destination backwards. */
export function writeRecipientStatement(
  db: D1Database,
  messageId: string,
  r: RecipientWrite,
  existingList: "to" | "cc" | "bcc",
): D1PreparedStatement {
  const at = nowIso();
  return db
    .prepare(
      `INSERT INTO message_recipients (id, message_id, address, list, status, rank, smtp_code, detail, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(message_id, address) DO UPDATE SET
         list = excluded.list,
         status = excluded.status,
         rank = excluded.rank,
         smtp_code = excluded.smtp_code,
         detail = excluded.detail,
         updated_at = excluded.updated_at
       WHERE excluded.rank >= message_recipients.rank`,
    )
    .bind(
      newId(),
      messageId,
      r.address.toLowerCase(),
      existingList,
      r.status,
      rankOf(r.status),
      r.smtpCode ?? null,
      r.detail ? r.detail.slice(0, 500) : null,
      at,
    );
}

/** Kept for callers that apply one event at a time; the batch consumer builds statements directly. */
async function writeRecipient(db: D1Database, messageId: string, r: RecipientWrite, existingList: "to" | "cc" | "bcc"): Promise<void> {
  await writeRecipientStatement(db, messageId, r, existingList).run();
}

/**
 * Record the destinations a send named, before any of them has answered.
 *
 * Written at send time rather than derived from `envelope_to` on read: an event only ever
 * mentions one address, so without this a message whose recipients never reported back
 * would look like it had none.
 */
export async function recordRecipients(
  db: D1Database,
  messageId: string,
  lists: { to: string[]; cc: string[]; bcc: string[] },
): Promise<void> {
  const rows: RecipientWrite[] = [
    ...lists.to.map((address) => ({ address, list: "to" as const })),
    ...lists.cc.map((address) => ({ address, list: "cc" as const })),
    ...lists.bcc.map((address) => ({ address, list: "bcc" as const })),
  ].map((r) => ({ ...r, status: SendStatus.Queued }));
  if (rows.length === 0) return;
  const at = nowIso();
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO message_recipients (id, message_id, address, list, status, rank, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(message_id, address) DO NOTHING`,
        )
        .bind(newId(), messageId, r.address.toLowerCase(), r.list, r.status, rankOf(r.status), at),
    ),
  );
}

/** Move every recorded destination to one status — for a send the provider never accepted. */
export async function failAllRecipients(
  db: D1Database,
  messageId: string,
  status: SendStatus,
  detail: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE message_recipients SET status = ?2, rank = ?3, detail = ?4, updated_at = ?5
       WHERE message_id = ?1 AND rank < ?3`,
    )
    .bind(messageId, status, rankOf(status), detail.slice(0, 500), nowIso())
    .run();
}

/**
 * One delivery event applied to one message: the destination is written, then the message's
 * summary status is recomputed from every destination it has.
 */
export async function applyDeliveryEvent(
  db: D1Database,
  messageId: string,
  event: { recipient: string; status: SendStatus; smtpCode: string | null; detail: string | null },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT list FROM message_recipients WHERE message_id = ?1 AND address = ?2`)
    .bind(messageId, event.recipient.toLowerCase())
    .first<{ list: "to" | "cc" | "bcc" }>();
  // An address that reports in without having been recorded is still a destination of this
  // message — the send may predate per-recipient tracking, so the event creates its row.
  await writeRecipient(db, messageId, { address: event.recipient, list: "to", status: event.status, smtpCode: event.smtpCode, detail: event.detail }, existing?.list ?? "to");
  await refreshSendStatus(db, messageId);
}

/** The single status the list badge shows, derived from every recorded destination. */
export function aggregateStatus(statuses: SendStatus[]): SendStatus {
  const failed = TERMINAL_FAILURES.find((s) => statuses.includes(s));
  if (failed) return failed;
  // Nothing has gone badly and something is still outstanding, so the message has not
  // finished. `deferred` says the receiving server is retrying, which is worth naming.
  if (statuses.includes(SendStatus.Deferred)) return SendStatus.Deferred;
  if (statuses.includes(SendStatus.Queued)) return SendStatus.Queued;
  if (statuses.length === 0) return SendStatus.Queued;
  // Delivered, or delivered-and-reported-as-spam: the mail got there either way.
  return SendStatus.Delivered;
}

/** Recompute `messages.send_status` from the destination rows. */
export async function refreshSendStatus(
  db: D1Database,
  messageId: string,
): Promise<SendStatus | null> {
  const { results } = await db
    .prepare(`SELECT status FROM message_recipients WHERE message_id = ?1`)
    .bind(messageId)
    .all<{ status: string }>();
  const rows = results ?? [];
  if (rows.length === 0) return null;
  const status = aggregateStatus(rows.map((r) => r.status as SendStatus));
  await db
    .prepare(`UPDATE messages SET send_status = ?2 WHERE id = ?1`)
    .bind(messageId, status)
    .run();
  return status;
}

/**
 * The same recompute for a whole delivery batch: one read for every destination, one
 * UPDATE per affected message, applied together. The per-event path above is what a
 * single caller uses; the queue consumer should never pay it twenty times over.
 */
export async function refreshSendStatuses(db: D1Database, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const placeholders = unique.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT message_id, status FROM message_recipients WHERE message_id IN (${placeholders})`)
    .bind(...unique)
    .all<{ message_id: string; status: string }>();
  const byMessage = new Map<string, string[]>();
  for (const r of results ?? []) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push(r.status);
    byMessage.set(r.message_id, list);
  }
  const stmts = [...byMessage.entries()].map(([id, statuses]) =>
    db.prepare(`UPDATE messages SET send_status = ?2 WHERE id = ?1`).bind(id, aggregateStatus(statuses as SendStatus[])),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

export async function listRecipients(db: D1Database, messageId: string): Promise<MessageRecipient[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM message_recipients WHERE message_id = ?1
       ORDER BY CASE list WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END, address`,
    )
    .bind(messageId)
    .all<MessageRecipientRow>();
  return (results ?? []).map((r) => ({
    address: r.address,
    list: r.list,
    status: r.status as SendStatus,
    smtpCode: r.smtp_code ?? null,
    detail: r.detail ?? null,
    updatedAt: r.updated_at,
  }));
}
