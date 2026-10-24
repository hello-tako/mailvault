/**
 * Runtime bindings + configuration for the MailVault Worker.
 * Boundings come from wrangler.jsonc; secrets are injected via `wrangler secret put`
 * (production) or `.dev.vars` (local). Nothing secret is ever read into a response.
 */
import { log } from "./lib/logging";
import type { IngestJob } from "./mail/ingest";

export interface Env {
  DB: D1Database;
  MAIL_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /**
   * Staged messages waiting for their metadata commit. The email handler cannot retry a
   * D1 write on its own, so it hands the job here; a commit that keeps failing ends up in
   * the dead-letter queue with its R2 objects still in place.
   */
  MAIL_INGEST_QUEUE: Queue<IngestJob>;
  /** Per-owner websocket hub for "new mail" nudges to already-open tabs. */
  MAILBOX_HUB: DurableObjectNamespace;
  /**
   * Analytics Engine dataset for rates and percentiles over time. Optional by design:
   * every write is best-effort, so a harness or a partial config without it still runs.
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * Workers AI + Vectorize, for opt-in semantic search. Both optional: the feature is off
   * until the owner turns it on, and stays usable as plain keyword search if either is
   * unavailable.
   */
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  /**
   * Email Sending. Optional by design, exactly like the AI bindings: a deployment without it
   * still receives mail, and the compose screen says so rather than failing at send time.
   */
  EMAIL?: SendEmail;

  // Plain-text vars
  ENVIRONMENT?: string; // "development" | "production" (default production)
  CF_ACCOUNT_ID?: string;
  MAIL_WORKER_NAME?: string;
  APP_ORIGIN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  MAX_MESSAGE_BYTES?: string;
  /**
   * How many messages the owner may send per UTC day. This is MailVault's own brake, not
   * Cloudflare's quota: the account-level counter is not realtime, so it cannot be trusted
   * to stop anything.
   */
  MAX_SENDS_PER_DAY?: string;
  ALLOWED_EMAILS?: string; // comma-separated owner allowlist (empty = any Access user)
  /**
   * Comma-separated domains the owner has ruled out of MailVault management because they
   * serve another mail product. No Cloudflare mutation is ever issued for them, whatever
   * takeover flags the request carries.
   */
  DOMAIN_DENYLIST?: string;
  /**
   * Origin the customer code portal is served from. The app's own hostname sits behind Cloudflare
   * Access on every path, so a buyer's link cannot open there; this names the public hostname that
   * is. Unset falls back to the request's origin, which is what local development wants.
   */
  PORTAL_ORIGIN?: string;
  DEV_AUTH_BYPASS?: string;
  /**
   * Name of the queue that Email Sending delivery events land on, since one Worker consumes
   * both that and the ingest queue and the handler dispatches on `batch.queue`.
   */
  DELIVERY_EVENTS_QUEUE?: string;

  // Secrets
  CLOUDFLARE_API_TOKEN?: string;
  /** JSON private JWK (P-256) used to sign VAPID assertions. */
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string; // contact for the VAPID JWT `sub` claim
}

export const DEFAULT_MAX_MESSAGE_BYTES = 20 * 1024 * 1024; // 20 MiB safety ceiling

/** The queue Email Sending event subscriptions are pointed at. */
export const DEFAULT_DELIVERY_EVENTS_QUEUE = "mail-delivery-events";

export function deliveryEventsQueue(env: Env): string {
  return env.DELIVERY_EVENTS_QUEUE?.trim() || DEFAULT_DELIVERY_EVENTS_QUEUE;
}

/** Generous for one person writing to other people, tight enough to cap the damage of a runaway client. */
export const DEFAULT_MAX_SENDS_PER_DAY = 50;

export function maxSendsPerDay(env: Env): number {
  const raw = Number.parseInt(env.MAX_SENDS_PER_DAY ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_SENDS_PER_DAY;
  // Cloudflare's own account quota is the hard wall; never claim a budget above it.
  return Math.min(raw, 1000);
}

export function maxMessageBytes(env: Env): number {
  const raw = Number.parseInt(env.MAX_MESSAGE_BYTES ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_MESSAGE_BYTES;
  // Cloudflare's incoming-message ceiling is ~25 MiB; never exceed it.
  return Math.min(raw, 25 * 1024 * 1024);
}

export function isDevelopment(env: Env): boolean {
  const e = (env.ENVIRONMENT ?? "").toLowerCase();
  return e === "development" || e === "local" || e === "test";
}

/**
 * Whether the Access check may be bypassed. True only when BOTH the explicit var is
 * set AND the environment is non-production — this makes an accidental production
 * bypass effectively impossible (section 28).
 */
export function devAuthBypassEnabled(env: Env): boolean {
  return (env.DEV_AUTH_BYPASS ?? "").toLowerCase() === "true" && isDevelopment(env);
}

export function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Domains the owner ruled out of management. Empty means nothing is excluded. */
export function domainDenylist(env: Env): string[] {
  return (env.DOMAIN_DENYLIST ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function appOrigin(env: Env): string {
  return (env.APP_ORIGIN ?? "").replace(/\/+$/, "");
}

/**
 * VAPID configuration, or null when push is not configured (the feature stays off).
 * The secret is the whole private JWK, because `x`/`y` are needed to sign and to derive
 * the public key the browser subscribes with — one secret cannot then disagree with itself.
 */
export function vapidConfig(env: Env): { jwk: JsonWebKey; subject: string } | null {
  const raw = env.VAPID_PRIVATE_KEY?.trim();
  if (!raw) return null;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    log.warn("vapid_secret_unparseable");
    return null;
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    log.warn("vapid_secret_invalid", { kty: jwk.kty ?? null, crv: jwk.crv ?? null });
    return null;
  }
  // RFC 8292 allows either a mailto: contact or an https: origin in the JWT `sub`.
  const configured = env.VAPID_SUBJECT?.trim();
  const subject = configured
    ? configured.includes(":")
      ? configured
      : `mailto:${configured}`
    : appOrigin(env) || "https://localhost";
  return { jwk, subject };
}
