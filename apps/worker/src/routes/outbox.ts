import { Hono } from "hono";
import { ComposeInputSchema, RecipientQuerySchema, SEND_LIMITS } from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import { maxSendsPerDay } from "../env";
import { AppError, notFound } from "../lib/errors";
import { log } from "../lib/logging";
import { nowIso } from "../lib/util";
import { listDomains } from "../db/domains";
import { countSentSince, listCorrespondents, listThread } from "../db/messages";
import { sendIdempotencyKey, sendOutbound } from "../mail/send";
import { actorOf, parseQuery, readJson } from "./_helpers";

const dayStart = () => `${nowIso().slice(0, 10)}T00:00:00.000Z`;

/**
 * Sending. Two routes: compose a new message to anybody, and read one conversation.
 *
 * Everything about who may send what is decided inside `sendOutbound` — the alias must
 * exist, be active, and sit on a domain whose Email Sending is enabled — because those are
 * security rules, not presentation choices.
 */
export const outboxRoute = new Hono<AppEnv>()
  .post("/api/outbox", async (c) => {
    const input = await readJson(c, ComposeInputSchema);
    const result = await sendOutbound(
      {
        idempotencyKey: sendIdempotencyKey(c.req.header("Idempotency-Key")),
        fromAddress: input.fromAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        fromName: input.fromName,
        replyTo: input.replyTo,
        replyToMessageId: input.replyToMessageId,
        attachments: input.attachments,
      },
      c.env,
      c.env.DB,
      c.env.MAIL_BUCKET,
    );

    if (!result.ok) {
      log.warn("outbox_refused", { actor: actorOf(c).email, code: result.code });
      // A refusal is the mailbox declining something the owner asked for, so it is a 400
      // with the machine code kept so the compose screen can explain a reply-auth refusal.
      throw new AppError(400, result.code, result.message);
    }
    log.info("outbox_sent", { actor: actorOf(c).email, messageId: result.outcome.id });
    return c.json(result.outcome, 201);
  })

  /**
   * Which aliases can send right now, and the day's remaining budget. The compose screen
   * asks this before it lets a message be written, so an unusable sender is never offered.
   */
  .get("/api/outbox/capabilities", async (c) => {
    const domains = await listDomains(c.env.DB);
    const limit = maxSendsPerDay(c.env);
    const sent = await countSentSince(c.env.DB, dayStart());
    return c.json({
      canCompose: !!c.env.EMAIL && domains.some((d) => d.sendingStatus === "ENABLED"),
      bindingMissing: !c.env.EMAIL,
      limit,
      sent,
      remaining: Math.max(0, limit - sent),
      maxRecipients: SEND_LIMITS.maxRecipients,
      domains: domains.map((d) => ({
        domainId: d.id,
        name: d.name,
        mailStatus: d.mailStatus,
        sendingStatus: d.sendingStatus,
        /** The name mail actually leaves under, when it is not the domain's own. */
        sendingVia: d.sendingVia,
        canSend: d.sendingStatus === "ENABLED",
      })),
    });
  })

  /**
   * Autocomplete for the To / Cc fields, from this mailbox's own history — inbound senders and
   * everyone the owner has written to. Capped and filtered server-side so a keystroke cannot
   * enumerate the whole correspondence.
   */
  .get("/api/recipients", async (c) => {
    const { q } = parseQuery(c, RecipientQuerySchema);
    const items = await listCorrespondents(c.env.DB, q, 8);
    return c.json({ items });
  })

  /** One conversation: received and sent mail interleaved, oldest first. */
  .get("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) throw notFound("Thread not found");
    const items = await listThread(c.env.DB, id);
    if (items.length === 0) throw notFound("Thread not found");
    return c.json({ id, items });
  });
