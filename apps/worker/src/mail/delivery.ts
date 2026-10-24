import { SendStatus } from "@mailvault/shared";
import type { Env } from "../env";
import { log } from "../lib/logging";
import { writeMetric, Elapsed } from "../lib/metrics";
import { refreshSendStatuses, writeRecipientStatement } from "../db/recipients";

/**
 * Email Sending delivery events.
 *
 * The `send_email` binding resolves as soon as Cloudflare has accepted the message, which
 * is not the same fact as "the recipient's server took it". The difference between those two
 * is what a mailbox has to show, because a message that never arrived is otherwise invisible:
 * it sits in Sent looking sent. Queues event subscriptions deliver that answer as one event
 * per (message, recipient), and this turns them back into rows.
 *
 * A message id that matches nothing is not an error. Mail sent before per-recipient tracking
 * existed, or from another Worker on the same domain, produces events this mailbox has no row
 * for; those are counted and acknowledged, never retried, because a retry can never make an
 * unknown id known.
 */

/** The event envelope as Queues delivers it — only the fields this consumer reads. */
interface DeliveryEventPayload {
  messageId?: unknown;
  recipient?: unknown;
  terminal?: unknown;
  delivery?: { status?: unknown; smtpStatusCode?: unknown; smtpResponse?: unknown };
  bounce?: { type?: unknown; reason?: unknown };
  rejection?: { reason?: unknown; party?: unknown; detail?: unknown };
  complaint?: { type?: unknown };
  failure?: { reason?: unknown };
}

export interface DeliveryEvent {
  providerMessageId: string;
  recipient: string;
  status: SendStatus;
  smtpCode: string | null;
  detail: string | null;
}

const STATUS_BY_EVENT: Record<string, SendStatus> = {
  delivered: SendStatus.Delivered,
  deferred: SendStatus.Deferred,
  bounced: SendStatus.Bounced,
  failed: SendStatus.Failed,
  rejected: SendStatus.Rejected,
  complained: SendStatus.Complained,
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `cf.email.sending.message.delivered` → `delivered`. */
function eventSuffix(type: string | null): string | null {
  const hit = /^cf\.email\.sending\.message\.([a-z]+)$/i.exec(type ?? "");
  return hit ? (hit[1] ?? "").toLowerCase() : null;
}

/**
 * One event, or null when the record is not something this consumer can act on.
 *
 * `delivery.status` is preferred over the event type because it is what the provider
 * actually concluded; the type is the fallback for a payload that carries one without the
 * other. A suppression is reported as `rejected`, and it is worth naming separately, because
 * "the address is on the account's suppression list" is a different problem to solve from a
 * server that refused the message.
 */
export function parseDeliveryEvent(raw: unknown): DeliveryEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as { type?: unknown; payload?: DeliveryEventPayload };
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;

  const messageId = text(payload.messageId)?.replace(/^<|>$/g, "");
  const recipient = text(payload.recipient)?.toLowerCase();
  if (!messageId || !recipient) return null;

  const reported = text(payload.delivery?.status)?.toLowerCase();
  const fromType = eventSuffix(text(event.type));
  const key = (reported && STATUS_BY_EVENT[reported] ? reported : fromType) ?? null;
  if (!key) return null;
  let status = STATUS_BY_EVENT[key] ?? null;
  if (!status) return null;

  const detail =
    text(payload.delivery?.smtpResponse) ??
    text(payload.bounce?.reason) ??
    text(payload.rejection?.detail) ??
    text(payload.rejection?.reason) ??
    text(payload.failure?.reason) ??
    (payload.complaint?.type ? `complaint: ${text(payload.complaint.type) ?? ""}`.trim() : null);

  if (status === SendStatus.Rejected && /suppress/i.test(detail ?? "")) status = SendStatus.Suppressed;

  return {
    providerMessageId: messageId,
    recipient,
    status,
    smtpCode: text(payload.delivery?.smtpStatusCode),
    detail,
  };
}

/** The OUT rows a batch of provider message ids belong to, if this mailbox sent them. */
async function findOutboundByProviderIds(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT id, provider_message_id FROM messages WHERE direction = 'OUT' AND provider_message_id IN (${placeholders})`)
    .bind(...unique)
    .all<{ id: string; provider_message_id: string }>();
  return new Map((results ?? []).map((r) => [r.provider_message_id, r.id]));
}

export interface DeliveryTally {
  applied: number;
  unmatched: number;
  malformed: number;
}

/**
 * Apply a batch of delivery events. The caller acks per message, so this must distinguish a
 * database failure (worth retrying) from a record it simply cannot use (never worth it).
 *
 * One batch is four database round trips at most — the provider-id lookup, the recorded
 * destinations, the upserts, the summary refresh — whatever the batch size, rather than
 * two per event.
 */
export async function consumeDeliveryEvents(
  bodies: unknown[],
  env: Env,
  db: D1Database,
): Promise<DeliveryTally> {
  const timer = new Elapsed();
  const tally: DeliveryTally = { applied: 0, unmatched: 0, malformed: 0 };

  const events = bodies
    .map((body) => parseDeliveryEvent(body))
    .filter((e): e is DeliveryEvent => {
      if (!e) tally.malformed += 1;
      return !!e;
    });
  if (events.length > 0) {
    const outbound = await findOutboundByProviderIds(db, events.map((e) => e.providerMessageId));
    const placed = events.filter((e) => {
      if (!outbound.has(e.providerMessageId)) {
        tally.unmatched += 1;
        return false;
      }
      return true;
    });
    if (placed.length > 0) {
      const affected = [...new Set(placed.map((e) => outbound.get(e.providerMessageId)!))];
      const placeholders = affected.map((_, i) => `?${i + 1}`).join(", ");
      const { results } = await db
        .prepare(`SELECT message_id, address, list FROM message_recipients WHERE message_id IN (${placeholders})`)
        .bind(...affected)
        .all<{ message_id: string; address: string; list: "to" | "cc" | "bcc" }>();
      const known = new Map((results ?? []).map((r) => [`${r.message_id}|${r.address}`, r.list]));

      await db.batch(
        placed.map((e) => {
          const messageId = outbound.get(e.providerMessageId)!;
          const list = known.get(`${messageId}|${e.recipient}`) ?? "to";
          return writeRecipientStatement(db, messageId, { address: e.recipient, list: "to", status: e.status, smtpCode: e.smtpCode, detail: e.detail }, list);
        }),
      );
      await refreshSendStatuses(db, affected);
      tally.applied = placed.length;
    }
  }

  // Counts only: an SMTP line can name a recipient, and neither belongs in a metric or a log.
  writeMetric(env, "delivery", {
    outcome: tally.applied > 0 ? "applied" : tally.unmatched > 0 ? "unmatched" : "ignored",
    reason: `applied=${tally.applied} unmatched=${tally.unmatched} malformed=${tally.malformed}`,
    commitMs: timer.stop(),
  });
  if (tally.malformed > 0) log.warn("delivery_event_unparsed", { count: tally.malformed });
  return tally;
}
