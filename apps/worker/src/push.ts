import { SignJWT, importJWK } from "jose";
import type { PushOutcome } from "@mailvault/shared";
import type { Env } from "./env";
import { vapidConfig } from "./env";
import { log } from "./lib/logging";
import { Elapsed, writeMetric } from "./lib/metrics";
import { newId, nowIso } from "./lib/util";

/**
 * Web Push for "new mail arrived".
 *
 * Two rules shape this module. A push endpoint URL is a bearer credential, so it lives
 * only in D1 and is never returned by an API or written to a log. And the notification is
 * payload-free: the device learns "something arrived at MailVault", never who sent it,
 * what it says, or what code is inside — the content stays behind the Access gate.
 */

export interface PushInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

interface PushTarget extends PushInput {
  id: string;
}

/** Retire an endpoint that keeps failing: it is almost certainly a retracted subscription. */
const MAX_FAILURES = 5;

/** Endpoints are always HTTPS with an opaque, provider-specific path and query. */
export function isUsableEndpoint(url: string): boolean {
  if (!url || url.length > 2048) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function bytesFromB64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function b64urlFrom(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uncompressed P-256 point (`0x04 || x || y`) — what browsers pass as applicationServerKey. */
export function vapidPublicKey(jwk: JsonWebKey): string {
  const x = jwk.x ?? "";
  const y = jwk.y ?? "";
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(bytesFromB64url(x), 1);
  point.set(bytesFromB64url(y), 33);
  return b64urlFrom(point);
}

async function vapidAssertion(endpoint: string, cfg: { jwk: JsonWebKey; subject: string; publicKey: string }): Promise<string> {
  // Every subscriber on one push service gets an identical assertion for the same origin;
  // signing it once per sweep rather than once per device is most of the saving.
  const origin = new URL(endpoint).origin;
  const cached = assertionCache.get(origin);
  if (cached && Date.now() - cached.at < ASSERTION_TTL_MS) return cached.value;
  const key = await importJWK(cfg.jwk, "ES256");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .setAudience(origin)
    .setSubject(cfg.subject)
    .setExpirationTime("12h")
    .sign(key);
  const value = `vapid t=${jwt}, k=${cfg.publicKey}`;
  assertionCache.set(origin, { at: Date.now(), value });
  return value;
}

/** Assertions live ~11h of their 12h lifetime; the sweep that finds one expired re-signs. */
const ASSERTION_TTL_MS = 11 * 60 * 60_000;
const assertionCache = new Map<string, { at: number; value: string }>();

type PushResult = "ok" | "gone" | "failed";

async function pushOne(target: PushTarget, cfg: { jwk: JsonWebKey; subject: string; publicKey: string }, fetchImpl: typeof fetch): Promise<PushResult> {
  let res: Response;
  try {
    res = await fetchImpl(target.endpoint, {
      method: "POST",
      headers: {
        TTL: "3600",
        // Deliberately no `Urgency` header, i.e. RFC 8030's `normal`. Sending `low` told
        // the push service it may batch this, and a verification code then surfaced as a
        // notification minutes after the mail was already sitting in the inbox.
        Authorization: await vapidAssertion(target.endpoint, cfg),
      },
      // No body on purpose. An encrypted payload would need the subscription's keys and
      // would put message content outside the authenticated app.
    });
  } catch {
    return "failed";
  }
  if (res.ok) return "ok";
  if (res.status === 404 || res.status === 410) return "gone";
  return "failed";
}

export async function saveSubscription(db: D1Database, input: PushInput): Promise<string> {
  const now = nowIso();
  const existing = await db
    .prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?1`)
    .bind(input.endpoint)
    .first<{ id: string }>();
  if (existing) {
    // Same endpoint, possibly refreshed keys: reset the failure counter rather than
    // letting a browser that revived a subscription inherit its death sentence.
    await db
      .prepare(`UPDATE push_subscriptions SET p256dh = ?2, auth = ?3, user_agent = ?4, fails = 0, updated_at = ?5 WHERE id = ?1`)
      .bind(existing.id, input.p256dh, input.auth, input.userAgent ?? null, now)
      .run();
    return existing.id;
  }
  const id = newId();
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, fails, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)`,
    )
    .bind(id, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null, now)
    .run();
  return id;
}

export async function deleteSubscription(db: D1Database, endpoint: string): Promise<number> {
  const res = await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(endpoint).run();
  return Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
}

export async function countSubscriptions(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM push_subscriptions`).first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/**
 * Send one payload-free notification to every subscriber. Never throws: push is a
 * convenience, and a dead endpoint must not fail mail ingestion or return a 500.
 */
export async function pushToAll(env: Env, db: D1Database, fetchImpl: typeof fetch = fetch): Promise<PushOutcome> {
  const timer = new Elapsed();
  const config = vapidConfig(env);
  if (!config) {
    writeMetric(env, "push", { outcome: "skipped", reason: "not-configured", stageMs: timer.stop() });
    return { sent: 0, pruned: 0, failed: 0, skipped: "not-configured" };
  }
  const cfg = { ...config, publicKey: vapidPublicKey(config.jwk) };

  const { results } = await db
    .prepare(`SELECT id, endpoint, p256dh, auth, user_agent FROM push_subscriptions`)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string; user_agent: string | null }>();
  const targets: PushTarget[] = (results ?? []).map((r) => ({
    id: r.id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
  }));
  if (targets.length === 0) {
    writeMetric(env, "push", { outcome: "skipped", reason: "no-subscribers", stageMs: timer.stop() });
    return { sent: 0, pruned: 0, failed: 0, skipped: "no-subscribers" };
  }

  const outcome: PushOutcome = { sent: 0, pruned: 0, failed: 0 };
  // Independent endpoints, asked together: one slow push service must not delay every
  // other device's notification (nor the queue consumer that triggered this).
  const settled = await Promise.allSettled(targets.map((target) => pushOne(target, cfg, fetchImpl)));
  const now = nowIso();
  const writes: D1PreparedStatement[] = [];
  const failureWrites: { index: number; id: string }[] = [];
  settled.forEach((result, i) => {
    const target = targets[i]!;
    const value = result.status === "fulfilled" ? result.value : "failed";
    if (value === "ok") {
      outcome.sent += 1;
      writes.push(
        db.prepare(`UPDATE push_subscriptions SET last_ok_at = ?2, fails = 0, updated_at = ?2 WHERE id = ?1`).bind(target.id, now),
      );
    } else if (value === "gone") {
      outcome.pruned += 1;
      writes.push(db.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(target.id));
      log.info("push_subscription_pruned", { id: target.id, reason: "gone" });
    } else {
      outcome.failed += 1;
      failureWrites.push({ index: writes.length, id: target.id });
      writes.push(
        db.prepare(`UPDATE push_subscriptions SET fails = fails + 1, updated_at = ?2 WHERE id = ?1 RETURNING fails`).bind(target.id, now),
      );
    }
  });
  if (writes.length > 0) {
    const results = await db.batch(writes);
    // The RETURNING column is what decides a retirement, so the deletions are a second
    // batch over only the endpoints that just crossed the line.
    const deaths = failureWrites.filter((fw) => Number((results[fw.index]?.results?.[0] as { fails?: number })?.fails ?? 0) >= MAX_FAILURES);
    if (deaths.length > 0) {
      await db.batch(deaths.map((fw) => db.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(fw.id)));
      for (const fw of deaths) log.info("push_subscription_pruned", { id: fw.id, reason: "repeated-failure" });
    }
  }
  log.info("push_run", { sent: outcome.sent, pruned: outcome.pruned, failed: outcome.failed });
  writeMetric(env, "push", {
    outcome: outcome.failed > 0 ? "partial" : "ok",
    reason: `sent=${outcome.sent} pruned=${outcome.pruned} failed=${outcome.failed}`,
    stageMs: timer.stop(),
  });
  return outcome;
}
