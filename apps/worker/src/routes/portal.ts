import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { getAliasById } from "../db/aliases";
import { findGrantByToken, portalCandidates, touchGrant } from "../db/portal";
import { log } from "../lib/logging";
import { rateLimited } from "../lib/errors";
import { PORTAL_WINDOW_MINUTES, pickPortalCode } from "../portal/code";
import { portalPage } from "../portal/page";

/**
 * The customer code portal.
 *
 * Mounted outside `/api/*`, so it never passes the Access gate that protects the mailbox — and
 * it must never be given a path that starts with `/api`, because that gate is what keeps a
 * stranger out of somebody else's mail. The token in the URL is the whole credential: 192 bits,
 * stored only as a hash, scoped to one alias, dead after its expiry or its view cap.
 *
 * What it can say: the newest verified code for that alias, how old it is, and the address it
 * arrived at. What it can never say: a subject, a body, an attachment, a link, a list of
 * messages, or anything about a different address.
 */

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

/** Best-effort per-isolate throttle. It raises the cost of scraping; the token is the real defence. */
const WINDOW_MS = 60_000;
const MAX_PAGE_VIEWS_PER_IP = 240;
const MAX_BAD_TOKENS_PER_IP = 40;
const hits = new Map<string, { window: number; pages: number; bad: number }>();

function count(ip: string, kind: "pages" | "bad", max: number): void {
  const now = Date.now();
  const entry = hits.get(ip) ?? { window: now, pages: 0, bad: 0 };
  if (now - entry.window > WINDOW_MS) {
    entry.window = now;
    entry.pages = 0;
    entry.bad = 0;
  }
  entry[kind] += 1;
  hits.set(ip, entry);
  if (entry[kind] > max) throw rateLimited();
}

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** The page inlines its own script because it has no build step; nothing else is allowed to load. */
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

async function resolve(c: { env: AppEnv["Bindings"] }, token: string) {
  const grant = await findGrantByToken(c.env.DB, token);
  if (!grant || grant.revokedAt) return { state: "invalid" as const };
  if (Date.parse(grant.expiresAt) <= Date.now()) return { state: "expired" as const, grant };
  if (grant.maxViews !== null && grant.views >= grant.maxViews) return { state: "spent" as const, grant };
  const alias = await getAliasById(c.env.DB, grant.aliasId);
  if (!alias) return { state: "invalid" as const };
  return { state: "open" as const, grant, aliasId: grant.aliasId, alias: alias.address };
}

/**
 * A link nobody issued and a link the owner killed answer the same way, so a lost token cannot
 * be told apart from a withdrawn one. Expiry and exhaustion are different: the customer needs
 * to know to ask for a new link, and the seller already knows which of the two happened.
 */
function statusFor(state: "invalid" | "expired" | "spent"): 403 | 404 | 410 {
  return state === "expired" ? 410 : state === "spent" ? 403 : 404;
}

export const portalRoute = new Hono<AppEnv>()
  .get("/c/:token", async (c) => {
    const token = c.req.param("token") ?? "";
    if (!TOKEN_SHAPE.test(token)) {
      count(clientIp(c.req.raw.headers), "bad", MAX_BAD_TOKENS_PER_IP);
      return c.html(portalPage({ token: "invalid", lang: c.req.query("lang") ?? "vi", expiresAt: null }), 404, {
        ...NO_STORE,
        "Content-Security-Policy": PAGE_CSP,
      });
    }
    count(clientIp(c.req.raw.headers), "pages", MAX_PAGE_VIEWS_PER_IP);

    const found = await resolve(c, token);
    if (found.state !== "open") {
      log.warn("portal_page_denied", { state: found.state });
      return c.html(portalPage({ token, lang: c.req.query("lang") ?? "vi", expiresAt: null }), statusFor(found.state), {
        ...NO_STORE,
        "Content-Security-Policy": PAGE_CSP,
      });
    }

    // Only a look is counted, not every poll of the JSON endpoint, or a cap of five views
    // would be spent by one customer watching the page.
    await touchGrant(c.env.DB, found.grant.id);
    log.info("portal_page_viewed", { grantId: found.grant.id });
    return c.html(portalPage({ token, lang: c.req.query("lang") ?? "vi", expiresAt: found.grant.expiresAt }), 200, {
      ...NO_STORE,
      "Content-Security-Policy": PAGE_CSP,
    });
  })

  .get("/c/:token/code", async (c) => {
    const token = c.req.param("token") ?? "";
    if (!TOKEN_SHAPE.test(token)) {
      count(clientIp(c.req.raw.headers), "bad", MAX_BAD_TOKENS_PER_IP);
      return c.json({ state: "invalid" }, { status: 404, headers: { ...NO_STORE } });
    }

    const found = await resolve(c, token);
    if (found.state !== "open") {
      return c.json({ state: found.state }, { status: statusFor(found.state), headers: { ...NO_STORE } });
    }

    const now = new Date();
    const since = new Date(now.getTime() - PORTAL_WINDOW_MINUTES * 60_000).toISOString();
    const candidates = await portalCandidates(c.env.DB, found.aliasId, since);
    const picked = pickPortalCode(candidates, now);

    if (!picked) {
      return c.json({ state: "waiting", alias: found.alias, windowMinutes: PORTAL_WINDOW_MINUTES }, { headers: { ...NO_STORE } });
    }
    // The code itself is never logged; the grant and the age are enough to answer "why was it
    // empty" without putting a live credential into a log line.
    log.info("portal_code_served", { grantId: found.grant.id, ageSeconds: picked.ageSeconds });
    return c.json(
      { state: "code", code: picked.code, kind: picked.kind, ageSeconds: picked.ageSeconds, alias: found.alias },
      { headers: { ...NO_STORE } },
    );
  });
