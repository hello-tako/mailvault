import type { Env } from "../env";
import { log } from "../lib/logging";
import { newId, nowIso } from "../lib/util";
import { sendOutbound, sendReply } from "./send";

/**
 * Sends that wait their turn (B6). The compose request lives in `scheduled_sends`; the
 * queue message that wakes it carries only the row id. Cancelling is a row update, and a
 * consumer that finds anything but WAITING acks and walks away — an undone send is a send
 * that never happened, which is the whole point of the undo window.
 */

export interface ScheduledSendInput {
  id?: string;
  kind: "compose" | "reply";
  payload: Record<string, unknown>;
  delaySeconds: number;
}

const MIN_DELAY = 5;
const MAX_DELAY = 86_400;

export async function scheduleSend(db: D1Database, input: ScheduledSendInput): Promise<{ id: string; sendAt: string }> {
  const delay = Math.min(Math.max(Math.round(input.delaySeconds), MIN_DELAY), MAX_DELAY);
  const id = input.id ?? newId();
  const now = nowIso();
  const sendAt = new Date(Date.now() + delay * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO scheduled_sends (id, kind, payload_json, send_at, state, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'WAITING', ?5, ?5)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, input.kind, JSON.stringify({ ...input.payload, idempotencyKey: `sched-${id}` }), sendAt, now)
    .run();
  return { id, sendAt };
}

/** What the Sent strip shows: sends still waiting, oldest first. */
export async function listWaitingScheduled(db: D1Database): Promise<
  Array<{ id: string; kind: string; sendAt: string; subject: string | null; to: string | null }>
> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, send_at, payload_json FROM scheduled_sends
       WHERE state = 'WAITING' ORDER BY send_at ASC LIMIT 20`,
    )
    .all<{ id: string; kind: string; send_at: string; payload_json: string }>();
  return (results ?? []).map((r) => {
    const payload = JSON.parse(r.payload_json) as { subject?: string; to?: string[] };
    return {
      id: r.id,
      kind: r.kind,
      sendAt: r.send_at,
      subject: payload.subject ?? null,
      to: Array.isArray(payload.to) ? payload.to.join(", ") : null,
    };
  });
}

export async function cancelScheduledSend(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE scheduled_sends SET state = 'CANCELLED', updated_at = ?2 WHERE id = ?1 AND state = 'WAITING'`)
    .bind(id, nowIso())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The queue's callback: run one scheduled send. Everything the normal path checks — the
 * daily budget, alias state, DMARC policy, size — is checked again here, because the world
 * may have changed since the owner pressed the button.
 */
export async function processScheduledSend(env: Env, id: string): Promise<"sent" | "skipped" | "failed"> {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT * FROM scheduled_sends WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; kind: string; payload_json: string; state: string }>();
  if (!row || row.state !== "WAITING") return "skipped";

  const payload = JSON.parse(row.payload_json) as Record<string, unknown> & {
    idempotencyKey?: string;
    replyToMessageId?: string;
  };
  const result =
    row.kind === "reply" && payload.replyToMessageId
      ? await sendReply(String(payload.replyToMessageId), payload as never, env, db, env.MAIL_BUCKET)
      : await sendOutbound(payload as never, env, db, env.MAIL_BUCKET);

  const now = nowIso();
  if (result.ok) {
    await db
      .prepare(`UPDATE scheduled_sends SET state = 'SENT', message_id = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(id, result.outcome.id, now)
      .run();
    log.info("scheduled_send_sent", { id, messageId: result.outcome.id });
    return "sent";
  }
  await db
    .prepare(`UPDATE scheduled_sends SET state = 'FAILED', error = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, `${result.code}: ${result.message}`, now)
    .run();
  log.warn("scheduled_send_failed", { id, code: result.code, message: result.message });
  return "failed";
}
