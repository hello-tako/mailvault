import type { Env } from "./env";
import { deliveryEventsQueue } from "./env";
import type {
  ExportedHandler,
  ExecutionContext,
  ForwardableEmailMessage,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import { createCloudflareClient } from "./cf/api-client";
import { createApp } from "./app";
import { decorateResponse } from "./security/headers";
import { stageEmail, commitIngest, type IngestJob } from "./mail/ingest";
import { consumeDeliveryEvents } from "./mail/delivery";
import { pushToAll } from "./push";
import { Elapsed, writeMetric } from "./lib/metrics";
import { MailboxHub, notifyNewMail } from "./live/hub";
import { log } from "./lib/logging";
import { runWatchdog } from "./provisioning/watchdog";
import { drainDeletionJobs } from "./db/deletions";

// Durable Object classes must be exported from the entry module.
export { MailboxHub };
export { CustomerOtpReader } from "./customer-otp/entrypoint";

// One router instance per isolate is safe: Hono is stateless and env is per-request.
const app = createApp();

export default {
  /**
   * HTTP: `/api/*` is served by the authenticated router; every other path falls
   * through to Workers Static Assets (the SPA), which handles its own routing.
   * Responses are hardened with security headers here so errors and assets included.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const res = await app.fetch(request, env, ctx);
      return decorateResponse(env, request.url, res);
    }
    const assetRes = await env.ASSETS.fetch(request);
    return decorateResponse(env, request.url, assetRes);
  },

  /**
   * Incoming mail from a Cloudflare Email Routing catch-all rule. Acceptance is
   * gated on an ACTIVE alias in D1; unknown recipients are rejected (never
   * auto-created). Startup/deploy performs no domain mutation (section 9).
   *
   * This handler stages (parse + write R2) and hands the metadata commit to the queue.
   * A throw before the hand-off means nothing was durably written, so Cloudflare's own
   * delivery retry starts clean; after it, the message is safe in R2 either way.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const timer = new Elapsed();
    try {
      const staged = await stageEmail(message, env, env.DB, env.MAIL_BUCKET);
      const stageMs = timer.stop();
      if (staged.status !== "staged") {
        writeMetric(env, "ingest", {
          outcome: staged.status,
          reason: "reason" in staged.result ? staged.result.reason : undefined,
          stageMs,
        });
        return;
      }
      // Do not delete staged objects when send fails: the queue may have accepted the job.
      await env.MAIL_INGEST_QUEUE.send(staged.job);
      writeMetric(env, "ingest", { outcome: "staged", stageMs });
    } catch (err) {
      // Rejected for retry; log without body/token (section 34). The throw is deliberate.
      writeMetric(env, "ingest", {
        outcome: "failed",
        reason: "handler_error",
        stageMs: timer.stop(),
      });
      log.error("email_handler_failed", { error: err instanceof Error ? err.message : "error" });
      throw err;
    }
  },

  /**
   * Commit staged messages to D1. This is the part that used to be able to lose a
   * message: a transient database failure inside the email handler had no retry of its
   * own. Here a failure re-delivers the job with the R2 objects untouched, and after the
   * consumer's retry budget the job parks in the dead-letter queue — still recoverable,
   * because the job carries keys only, never content.
   *
   * One Worker consumes two queues, so the batch is routed by the name it arrived on rather
   * than by its shape: guessing from field names would make an ingest job that happens to
   * look like a delivery event get applied as one.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === deliveryEventsQueue(env)) {
      await consumeDeliveryBatch(batch, env);
      return;
    }
    await consumeIngestBatch(batch as MessageBatch<IngestJob>, env, ctx);
  },

  /**
   * Drift check. Cloudflare config can be changed from the dashboard by anyone, and then
   * mail silently stops arriving. This re-reads only what MailVault already believes
   * works and updates its own rows — it never enables routing, edits DNS or touches a
   * zone (section 9: no automatic domain mutation).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void ctx;
    try {
      const report = await drainDeletionJobs(env);
      log.info("deletion_drain", {
        cron: controller.cron,
        claimed: report.claimed,
        completed: report.completed,
        failed: report.failed,
        deferred: report.deferred,
      });
    } catch (err) {
      log.error("deletion_drain_failed", { error: err instanceof Error ? err.message : "error" });
    }

    const token = env.CLOUDFLARE_API_TOKEN;
    if (!token || !env.MAIL_WORKER_NAME) {
      log.warn("watchdog_skipped", {
        reason: token ? "MAIL_WORKER_NAME unset" : "API token unset",
      });
      return;
    }
    const timer = new Elapsed();
    try {
      const client = createCloudflareClient({ token, accountId: env.CF_ACCOUNT_ID || undefined });
      const report = await runWatchdog(env.DB, client, env.MAIL_WORKER_NAME);
      writeMetric(env, "watchdog", {
        outcome: report.drifted.length > 0 ? "drift" : "ok",
        reason: `checked=${report.checked} drifted=${report.drifted.length} restored=${report.restored.length} failed=${report.failed.length}`,
        commitMs: timer.stop(),
      });
      log.info("watchdog_run", {
        cron: controller.cron,
        checked: report.checked,
        drifted: report.drifted.length,
        restored: report.restored.length,
        failed: report.failed.length,
      });
    } catch (err) {
      writeMetric(env, "watchdog", {
        outcome: "failed",
        reason: "run_error",
        commitMs: timer.stop(),
      });
      log.error("watchdog_run_failed", { error: err instanceof Error ? err.message : "error" });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * The ingest half of the queue handler. Ack and retry are per message rather than per
 * batch: one unreadable job must not be delivered to every other message in the batch for
 * the rest of its retry budget.
 */
async function consumeIngestBatch(
  batch: MessageBatch<IngestJob>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const timer = new Elapsed();
    try {
      const result = await commitIngest(message.body, env.DB, env.MAIL_BUCKET, env);
      writeMetric(env, "ingest_commit", {
        outcome: result.status,
        verdict: result.status === "stored" ? result.verdict : undefined,
        commitMs: timer.stop(),
      });
      if (result.status === "stored") {
        // Notify only after the mail is durable, and detached: a slow or dead push
        // endpoint must never affect delivery or make the message retry.
        ctx.waitUntil(
          Promise.allSettled([pushToAll(env, env.DB), notifyNewMail(env)]).then(() => undefined),
        );
      }
      message.ack();
    } catch (err) {
      writeMetric(env, "ingest_commit", {
        outcome: "failed",
        reason: "commit_error",
        commitMs: timer.stop(),
      });
      log.error("ingest_commit_failed", {
        attempt: message.attempts,
        error: err instanceof Error ? err.message : "error",
      });
      message.retry();
    }
  }
}

/**
 * The delivery-event half. A database failure retries the batch; a record this mailbox
 * cannot place is counted and dropped inside the consumer, because no number of retries
 * turns an unknown message id into a known one. Nothing here touches R2 — a delivery event
 * reports on a message, it is not a copy of one.
 */
async function consumeDeliveryBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  try {
    await consumeDeliveryEvents(
      batch.messages.map((m) => m.body),
      env,
      env.DB,
    );
    for (const message of batch.messages) message.ack();
  } catch (err) {
    writeMetric(env, "delivery", { outcome: "failed", reason: "db_error" });
    log.error("delivery_event_failed", {
      attempt: batch.messages[0]?.attempts,
      error: err instanceof Error ? err.message : "error",
    });
    for (const message of batch.messages) message.retry();
  }
}
