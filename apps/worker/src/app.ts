import { Hono } from "hono";
import type { AppEnv } from "./app-env";
import { verifyAccessIdentity } from "./auth";
import { checkCsrf } from "./security/headers";
import { badOrigin, handleError, unauthorized } from "./lib/errors";
import { log } from "./lib/logging";
import { healthRoute } from "./routes/health";
import { dashboardRoute } from "./routes/dashboard";
import { domainsRoute } from "./routes/domains";
import { aliasesRoute } from "./routes/aliases";
import { messagesRoute } from "./routes/messages";
import { outboxRoute } from "./routes/outbox";
import { sendingRoute } from "./routes/sending";
import { pushRoute } from "./routes/push";
import { liveRoute } from "./routes/live";
import { securityRoute } from "./routes/security";
import { rulesRoute } from "./routes/rules";
import { semanticRoute } from "./routes/semantic";
import { notificationsRoute } from "./routes/notifications";
import { draftsRoute } from "./routes/drafts";
import { portalRoute } from "./routes/portal";

/**
 * Assembles the HTTP API. Ordering matters: the unauthenticated liveness probe is
 * mounted first, then a global auth gate on /api/* (health is exempted), then the
 * CSRF guard. Static assets + SPA fallback are handled by the Worker entrypoint,
 * not this router.
 */
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));

  // Public: coarse health only. Never gated, exposes no identity/config.
  app.route("/", healthRoute);

  // The customer code portal is public by design and lives outside /api on purpose: the gate
  // below is what keeps a stranger out of the mailbox, and this route must never grow a path
  // that slips under it. Its credential is a 192-bit token that can ask for one code only.
  app.route("/", portalRoute);

  // Everything else under /api requires a valid Cloudflare Access identity.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const actor = await verifyAccessIdentity(c.env, c.req.raw);
    if (!actor) {
      log.warn("api_unauthorized", { path: c.req.path });
      throw unauthorized();
    }
    c.set("actor", actor);
    return next();
  });

  // State-changing calls must be same-origin + carry our custom header (CSRF).
  app.use("/api/*", async (c, next) => {
    const res = checkCsrf(c);
    if (!res.ok) {
      log.warn("api_csrf_rejected", { path: c.req.path, reason: res.reason });
      throw badOrigin(res.reason);
    }
    return next();
  });

  app.route("/", dashboardRoute);
  app.route("/", domainsRoute);
  app.route("/", aliasesRoute);
  app.route("/", messagesRoute);
  app.route("/", outboxRoute);
  app.route("/", sendingRoute);
  app.route("/", pushRoute);
  app.route("/", liveRoute);
  app.route("/", securityRoute);
  app.route("/", rulesRoute);
  app.route("/", notificationsRoute);
  app.route("/", draftsRoute);
  app.route("/", semanticRoute);

  return app;
}
