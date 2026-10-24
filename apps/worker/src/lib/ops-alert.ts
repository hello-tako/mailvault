import type { Env } from "../env";
import { allowedEmails } from "../env";
import { getSetting, setSetting } from "../db/settings";
import { log } from "./logging";
import { writeMetric } from "./metrics";

/**
 * Operational failure alerts — the pipeline telling the owner it is losing.
 *
 * The queue consumers already retry and dead-letter; what they cannot do is make anybody
 * look at the dead letter. This watches the failure streak itself: a few failures inside
 * an hour means the D1 commit path (or the delivery-event path) is genuinely broken, and
 * one email says so. It is sent through this app's own `send_email` binding, so the alert
 * path is the same one the owner already trusts for mail — no second service to run, and
 * no credentials beyond the ones the Worker already holds.
 *
 * The streak lives in `app_settings` as one JSON blob per pipeline, so a failure costs one
 * read and one write — failures are rare, and the code that is failing must not be asked
 * to do more work while it fails.
 */
export type OpsAlertKind = "ingest-commit" | "delivery-events";

/** Failures inside this window count as one streak; an older one starts fresh. */
const ALERT_WINDOW_MS = 60 * 60_000;
/** This many failures in a window means "broken", not "hiccup". */
const ALERT_THRESHOLD = 3;
/** At most one alert mail per pipeline per day: a broken inbox must not become a spammer. */
const ALERT_COOLDOWN_MS = 24 * 60 * 60_000;

export interface AlertState {
  count: number;
  firstAt: string;
  lastSentAt: string | null;
}

const KIND_LABEL: Record<OpsAlertKind, string> = {
  "ingest-commit": "incoming mail could not be committed",
  "delivery-events": "delivery events could not be recorded",
};

function stateKey(kind: OpsAlertKind): string {
  return `opsAlert:${kind}`;
}

async function readState(db: D1Database, kind: OpsAlertKind): Promise<AlertState | null> {
  const raw = await getSetting(db, stateKey(kind));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AlertState>;
    if (typeof parsed.count !== "number" || typeof parsed.firstAt !== "string") return null;
    return { count: parsed.count, firstAt: parsed.firstAt, lastSentAt: typeof parsed.lastSentAt === "string" ? parsed.lastSentAt : null };
  } catch {
    return null;
  }
}

/**
 * The whole decision, as a pure function of the previous state and the clock — the part
 * worth testing, separated from the D1 and the email that only carry it out.
 */
export function nextAlertState(prev: AlertState | null, nowMs: number): { state: AlertState; shouldAlert: boolean } {
  const now = new Date(nowMs).toISOString();
  if (!prev || nowMs - Date.parse(prev.firstAt) > ALERT_WINDOW_MS) {
    return { state: { count: 1, firstAt: now, lastSentAt: prev?.lastSentAt ?? null }, shouldAlert: false };
  }
  const count = prev.count + 1;
  const cooled = !prev.lastSentAt || nowMs - Date.parse(prev.lastSentAt) > ALERT_COOLDOWN_MS;
  const shouldAlert = count >= ALERT_THRESHOLD && cooled;
  return { state: { count, firstAt: prev.firstAt, lastSentAt: shouldAlert ? now : prev.lastSentAt }, shouldAlert };
}

/** An address the alert can leave from: the first active alias of a sending-enabled domain. */
async function alertSender(db: D1Database): Promise<{ address: string; via: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT a.address AS address, d.sending_via AS via
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.status = 'ACTIVE' AND d.sending_status = 'ENABLED'
       ORDER BY a.created_at ASC LIMIT 1`,
    )
    .first<{ address: string; via: string | null }>();
  return row ? { address: row.address, via: row.via } : null;
}

/**
 * Send the alert mail. The body names where to look, not what failed in detail: `detail`
 * is an error message from the pipeline (never mail content), and it is kept to one line.
 */
async function sendAlert(env: Env, kind: OpsAlertKind, state: AlertState, detail: string): Promise<boolean> {
  const to = allowedEmails(env)[0];
  if (!to) return false;
  if (!env.EMAIL) return false;
  const sender = await alertSender(env.DB);
  if (!sender) return false;

  // The same sending-name rule as a compose: when the domain leaves through one of its own
  // subdomains, the local part carries over and answers come back to the alias itself.
  const local = sender.address.split("@")[0] ?? "";
  const from = sender.via && local ? `${local}@${sender.via}` : sender.address;
  const subject = `[MailVault] ${state.count} failures: ${KIND_LABEL[kind]}`;
  const text = [
    `${state.count} failures in the last hour, first at ${state.firstAt}.`,
    "",
    `Pipeline: ${kind}`,
    `Last error: ${detail.slice(0, 200)}`,
    "",
    "Jobs that exhausted their retries are parked in the matching dead-letter queue",
    "(mail-ingest-dlq / mail-delivery-events-dlq) with their R2 objects untouched —",
    "see DEPLOYMENT.md, \"Backups & disaster recovery\", for how to drive one again.",
  ].join("\n");

  await env.EMAIL.send({ from, to: [to], subject, text, ...(sender.via ? { replyTo: sender.address } : {}) });
  return true;
}

/**
 * Record one failure. Call this detached (ctx.waitUntil) from a consumer's catch path:
 * alerting must never add a failure mode to a pipeline that is already failing.
 */
export async function recordOpsFailure(env: Env, kind: OpsAlertKind, detail: string): Promise<void> {
  try {
    const { state, shouldAlert } = nextAlertState(await readState(env.DB, kind), Date.now());
    let sent = false;
    if (shouldAlert) {
      sent = await sendAlert(env, kind, state, detail);
      writeMetric(env, "ops_alert", { outcome: sent ? "ok" : "skipped", reason: sent ? undefined : "cannot-send" });
    }
    await setSetting(env.DB, stateKey(kind), JSON.stringify(state));
    if (shouldAlert) log.warn("ops_alert_sent", { kind, count: state.count, delivered: sent });
  } catch (err) {
    // The pipeline already logged its own failure; this only says the page could not go out.
    writeMetric(env, "ops_alert", { outcome: "failed", reason: "alert_error" });
    log.warn("ops_alert_failed", { kind, error: err instanceof Error ? err.message : "error" });
  }
}
