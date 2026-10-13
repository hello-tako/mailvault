/** Where a portal link points, and why that is not necessarily where the app lives. */

/**
 * The portal is served on a hostname with no Cloudflare Access in front of it — the app's
 * hostname is fully gated, so a customer's link could never open there. When PORTAL_ORIGIN is
 * unset (local development, or a single-hostname deployment that has opened a path) the app's
 * own origin is used, which keeps the feature testable without inventing a hostname.
 */
export function portalOrigin(env: { PORTAL_ORIGIN?: string }, requestOrigin: string): string {
  return (env.PORTAL_ORIGIN || requestOrigin).replace(/\/+$/, "");
}

export function portalPath(token: string): string {
  return `/c/${token}`;
}

/**
 * Whether a request arrived on the portal's own hostname, which has exactly one job. Anything
 * else asked of it is refused rather than answered with the mailbox app: a public domain serving
 * the owner's UI would be a login-less look-alike of MailVault on a URL nobody intended to publish.
 */
export function isPortalHost(env: { PORTAL_ORIGIN?: string }, host: string): boolean {
  if (!env.PORTAL_ORIGIN) return false;
  try {
    return new URL(env.PORTAL_ORIGIN).host === host;
  } catch {
    return false;
  }
}
