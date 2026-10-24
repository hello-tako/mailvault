import type { Context } from "hono";
import type { Env } from "../env";
import { appOrigin } from "../env";

/**
 * Security headers for every response (section 29). CSP is strict; the SPA is a
 * same-origin JSON client. Email HTML never renders in this document — only inside a
 * separately sandboxed iframe (see web/MessageView + SECURITY.md).
 *
 * Centralized as a builder so the same set is applied to success, error, 404 and
 * static-asset responses alike (the wrapper in index.ts runs after Hono dispatch).
 */
function isProd(env?: Env): boolean {
  return (env?.ENVIRONMENT ?? "production").toLowerCase() !== "development";
}

function securityHeaders(env: Env | undefined, url: string): Array<[string, string]> {
  const isHttps = new URL(url).protocol === "https:";

  const headers: Array<[string, string]> = [
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["X-Frame-Options", "DENY"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"],
    [
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // inline style attributes for the SPA
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self' blob: data:", // sandboxed email iframe
      ].join("; "),
    ],
  ];

  if (isProd(env) && isHttps) {
    headers.push(["Strict-Transport-Security", "max-age=31536000; includeSubDomains"]);
  }
  return headers;
}

/**
 * Return a new Response carrying the security headers, preserving status + body.
 * Used as a final wrapper so even onError/404/asset responses are hardened.
 */
export function decorateResponse(env: Env | undefined, url: string, res: Response): Response {
  // A websocket handshake answers 101 and carries the socket on the response itself.
  // Rebuilding it would both throw (the Response constructor rejects 1xx) and sever the
  // upgrade, so handshakes go through untouched — headers belong to the document that
  // opened the socket, which was already hardened when it was served.
  if (res.status < 200) return res;

  const headers = new Headers(res.headers);
  for (const [k, v] of securityHeaders(env, url)) {
    // A route that authored a header keeps its own value; everything else is applied to it.
    // The portal page needs both halves of that: it ships one inline script, which the app's
    // `script-src 'self'` would refuse to run, and it carries a token in its URL, so
    // `no-referrer` is tighter than the default.
    if (headers.has(k)) continue;
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Same-origin + custom-header CSRF guard for state-changing API calls. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATION_HEADER = "x-mailvault";

export function checkCsrf(c: Context): { ok: true } | { ok: false; reason: string } {
  const method = c.req.method;
  if (SAFE_METHODS.has(method)) return { ok: true };

  // Required custom header proves the request came from our JS client, not a form.
  if (!c.req.header(MUTATION_HEADER)) {
    return { ok: false, reason: "Missing required request header" };
  }

  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  const configured = appOrigin(c.env as Env);
  const reqOrigin = new URL(c.req.url).origin;

  const allowedOrigins = new Set<string>([reqOrigin]);
  if (configured) {
    try {
      allowedOrigins.add(new URL(configured).origin);
    } catch {
      /* ignore malformed APP_ORIGIN */
    }
  }

  if (!origin && !referer) return { ok: false, reason: "Missing Origin" };
  try {
    const source = new URL(origin ?? referer!).origin;
    if (!allowedOrigins.has(source)) return { ok: false, reason: "Cross-origin request rejected" };
  } catch {
    return { ok: false, reason: "Invalid Origin" };
  }
  return { ok: true };
}
