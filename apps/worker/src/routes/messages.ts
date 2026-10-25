import { Hono } from "hono";
import { z } from "zod";
import {
  BulkMessageAction,
  BulkMessageInputSchema,
  MessageListQuerySchema,
  ReadFlagSchema,
  ReplyInputSchema,
  paginated,
  ForwardInputSchema,
  type BulkMessageResult,
} from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import {
  deletionJobCounts,
  failedDeletionJobs,
  retryDeletionJob,
  requestMessageDeletion,
  requestMessagesDeletion,
} from "../db/deletions";
import { markAllRead,
  findAttachment,
  getMessageDetail,
  getMessageRow,
  listMessages,
  messageCounters,
  setMessageRead,
  setFlag,
  type FlagColumn,
} from "../db/messages";
import { AppError, notFound } from "../lib/errors";
import { log } from "../lib/logging";
import {
  forwardMessage,
  resendMessage,
  sendIdempotencyKey,
  sendReply,
} from "../mail/send";
import { embedCidImages } from "../mail/inline-images";
import { readInvite, readVCard, type CalendarInvite, type VCard } from "../mail/calendars";
import { sanitizeFilename } from "../lib/filename";
import { getObject } from "../storage/r2";
import { searchMessageIds, semanticEnabled } from "../lib/semantic";
import { sanitizeEmailHtml } from "../security/sanitize-html";
import { requireIrreversibleStepUp, STEP_UP_HEADER } from "../security/irreversible";
import { actorOf, parseQuery, readJson } from "./_helpers";

const IdParam = z.object({ id: z.string().min(1) });
const TranslateBodySchema = z.object({ to: z.enum(["vi", "en"]) });
const AttachmentParam = z.object({ messageId: z.string().min(1), attachmentId: z.string().min(1) });

/** `receivedAt|id` → the pair, or undefined when the client sent something unusable. */
function parseCursor(raw: string | undefined): { receivedAt: string; id: string } | undefined {
  if (!raw) return undefined;
  const idx = raw.lastIndexOf("|");
  if (idx <= 0) return undefined;
  const receivedAt = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!id || Number.isNaN(Date.parse(receivedAt))) return undefined;
  return { receivedAt, id };
}

/**
 * Which column each bulk flag action moves, and to what. `delete` is absent because it is
 * not a flag; it is handled on its own path. Totaling the two coverage sets is what makes
 * adding a seventh action a compile error rather than a runtime `undefined`.
 */
const FLAG_ACTIONS: Record<
  Exclude<BulkMessageAction, typeof BulkMessageAction.Delete>,
  [FlagColumn, 0 | 1]
> = {
  [BulkMessageAction.Read]: ["is_read", 1],
  [BulkMessageAction.Unread]: ["is_read", 0],
  [BulkMessageAction.Star]: ["starred", 1],
  [BulkMessageAction.Unstar]: ["starred", 0],
  [BulkMessageAction.Archive]: ["archived", 1],
  [BulkMessageAction.Unarchive]: ["archived", 0],
};

/** Shape persisted by the inbound parser at parsed/{messageId}.json (section 12). */
interface ParsedEmail {
  text: string | null;
  html: string | null;
  degraded?: boolean;
}

async function readParsed(bucket: R2Bucket, key: string | null): Promise<ParsedEmail | null> {
  if (!key) return null;
  const obj = await getObject(bucket, key);
  if (!obj) return null;
  try {
    return (await obj.json()) as ParsedEmail;
  } catch {
    return null;
  }
}

export const messagesRoute = new Hono<AppEnv>()
  .get("/api/messages", async (c) => {
    const query = parseQuery(c, MessageListQuerySchema);
    // Only the owner's opt-in turns a search into an embedding request; a client cannot
    // ask for semantic ids directly.
    const semanticIds =
      query.q && (await semanticEnabled(c.env.DB)) ? await searchMessageIds(c.env, query.q) : [];
    const { items, total } = await listMessages(c.env.DB, { ...query, semanticIds, before: parseCursor(query.before) });
    // A cursor the client can follow exists only for the plain list — a search reorders
    // rows by rank and a threaded view partitions them, so there they page by offset.
    const last = items[items.length - 1];
    const nextCursor =
      !query.q && !query.threaded && last && items.length === query.limit ? `${last.receivedAt}|${last.id}` : null;
    return c.json({ ...paginated(items, { limit: query.limit, offset: query.offset, total }), nextCursor });
  })

  .get("/api/deletions", async (c) =>
    c.json({ jobs: await deletionJobCounts(c.env.DB), failed: await failedDeletionJobs(c.env.DB) }),
  )

  .post("/api/deletions/:id/retry", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const result = await retryDeletionJob(c.env.DB, id);
    if (!result.found) throw notFound("Deletion job not found");
    log.info("deletion_job_retry_requested", { actor: actorOf(c).email, jobId: id });
    return c.json({ id, state: result.state }, 202);
  })

  /**
   * Tab and mailbox badges.
   *
   * Mounted above `/api/messages/:id` on purpose: Hono matches in registration order, and a
   * route registered later would be shadowed by the id param. Message ids are generated, so
   * nothing can actually be called "counters" — but the order is what makes that true rather
   * than a comment nobody enforces.
   */
  .get("/api/messages/counters", async (c) => {
    const domainId = c.req.query("domainId") || undefined;
    return c.json(await messageCounters(c.env.DB, domainId));
  })

  /**
   * Apply one action to a selection.
   *
   * Everything except `delete` is a flag flip in a single statement, and delete is the same
   * set of ids the owner can see on screen, so the ceiling is the page size rather than a
   * number invented here. Ownership needs no extra clause: this mailbox has one owner and
   * every route is behind the same Access gate — the id list is filtered by existence, not
   * by identity, exactly as the single-message routes already are.
   */
  .post("/api/messages/bulk", async (c) => {
    const { ids, action } = await readJson(c, BulkMessageInputSchema);
    if (action === BulkMessageAction.Delete) {
      await requireIrreversibleStepUp(
        c.env.DB,
        c.req.header(STEP_UP_HEADER),
        "message.bulk-delete",
      );
      const accepted = await requestMessagesDeletion(c.env.DB, ids);
      log.info("messages_bulk_deletion_queued", { actor: actorOf(c).email, count: accepted });
      return c.json({
        action,
        affected: accepted,
        r2ObjectsRemoved: 0,
      } satisfies BulkMessageResult);
    }
    const [column, value] = FLAG_ACTIONS[action];
    const affected = await setFlag(c.env.DB, ids, column, value);
    log.info("messages_bulk_flag", { actor: actorOf(c).email, action, count: affected });
    return c.json({ action, affected, r2ObjectsRemoved: 0 } satisfies BulkMessageResult);
  })

  /**
   * Detail view. Bodies come from private R2 parsed content, never from a public
   * source. HTML is server-side sanitized (section 19) and the browser still renders
   * it only inside a sandboxed iframe. Remote images stay blocked unless the owner
   * explicitly asks via ?remoteImages=1.
   */
  .get("/api/messages/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const detail = await getMessageDetail(c.env.DB, id);
    if (!detail) throw notFound("Message not found");

    const { parsedR2Key, ...body } = detail;
    const parsed = await readParsed(c.env.MAIL_BUCKET, parsedR2Key);
    const allowRemote = ["1", "true"].includes((c.req.query("remoteImages") ?? "").toLowerCase());

    // Inline images resolve server-side into data URLs (C2): the sanitizer keeps cid:
    // references, and each becomes the pixels of the attachment it names — no network, so
    // remote tracking images stay blocked exactly as before.
    let htmlBody = parsed?.html
      ? sanitizeEmailHtml(parsed.html, { allowRemoteImages: allowRemote, keepCidImages: true })
      : null;
    if (htmlBody?.includes("cid:")) {
      htmlBody = await embedCidImages(htmlBody, detail.attachments, c.env.MAIL_BUCKET, async (attachmentId) => {
        const row = await c.env.DB
          .prepare(`SELECT r2_key AS k FROM attachments WHERE id = ?1`)
          .bind(attachmentId)
          .first<{ k: string }>();
        return row?.k ?? null;
      });
    }

    // Attachments a mailbox can read by itself (C9): an invite and a contact card, parsed
    // out of their files when they are small — the download stays the source of truth.
    let calendar: CalendarInvite | null = null;
    let vcard: VCard | null = null;
    for (const att of detail.attachments) {
      if (calendar && vcard) break;
      const row = await c.env.DB
        .prepare(`SELECT r2_key, size FROM attachments WHERE id = ?1`)
        .bind(att.id)
        .first<{ r2_key: string; size: number }>();
      if (!row) continue;
      const isIcs = (att.contentType.startsWith("text/calendar") || /\.ics$/i.test(att.filename)) && !calendar;
      const isVcf = (att.contentType.startsWith("text/vcard") || /\.vcf$/i.test(att.filename)) && !vcard;
      if (isIcs) calendar = await readInvite(c.env.MAIL_BUCKET, row.r2_key, Number(row.size));
      else if (isVcf) vcard = await readVCard(c.env.MAIL_BUCKET, row.r2_key, Number(row.size));
    }

    return c.json({
      ...body,
      textBody: parsed?.text ?? null,
      htmlBody,
      parseDegraded: body.parseDegraded || parsed?.degraded === true,
      calendar,
      vcard,
    });
  })

  /** Read a message in the owner's own language (C11). The translation is made on demand,
   * returned to this reader only, and never stored: the vault keeps what arrived. */
  .post("/api/messages/:id/translate", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const { to } = await readJson(c, TranslateBodySchema);
    if (!c.env.AI) {
      throw new AppError(503, "AI_UNAVAILABLE", "This server has no Workers AI binding configured.");
    }
    const detail = await getMessageDetail(c.env.DB, id);
    if (!detail) throw notFound("Message not found");
    const parsed = await readParsed(c.env.MAIL_BUCKET, detail.parsedR2Key);
    const source = (parsed?.text ?? "").slice(0, 20_000).trim();
    if (!source) throw new AppError(400, "NOTHING_TO_TRANSLATE", "This message has no readable text.");
    const run = (await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: `Translate the user's email into ${to}. Reply with the translation only, no commentary.` },
        { role: "user", content: source },
      ],
    })) as { response?: string };
    const text = (run.response ?? "").trim();
    if (!text) throw new AppError(502, "TRANSLATE_FAILED", "The model returned nothing.");
    return c.json({ to, text });
  })

  /** Mark everything the current list would show as unread, read (C5). */
  .post("/api/messages/read-all", async (c) => {
    const parsed = parseQuery(c, MessageListQuerySchema);
    const { direction: _direction, threaded: _threaded, before: _before, ...query } = parsed;
    const changed = await markAllRead(c.env.DB, { ...query, limit: 0, offset: 0 });
    log.info("messages_marked_all_read", { actor: actorOf(c).email, changed });
    return c.json({ changed });
  })

  .patch("/api/messages/:id/read", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const { isRead } = await readJson(c, ReadFlagSchema);
    const changed = await setMessageRead(c.env.DB, id, isRead);
    if (changed === 0 && !(await getMessageRow(c.env.DB, id))) throw notFound("Message not found");
    return c.json({ id, isRead });
  })

  /**
   * Answer this message from the alias it arrived on. Who receives it is taken from the
   * stored headers, never from the request — see `sendReply`.
   */
  .post("/api/messages/:id/reply", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const input = await readJson(c, ReplyInputSchema);
    const result = await sendReply(
      id,
      { ...input, idempotencyKey: sendIdempotencyKey(c.req.header("Idempotency-Key")) },
      c.env,
      c.env.DB,
      c.env.MAIL_BUCKET,
    );
    if (!result.ok) {
      log.warn("reply_refused", { messageId: id, code: result.code });
      throw new AppError(400, result.code, result.message);
    }
    log.info("reply_sent", { messageId: id, replyId: result.outcome.id, actor: actorOf(c).email });
    return c.json(result.outcome, 201);
  })

  /** Hand one stored message to somebody new (B2): an intro plus the original, inlined or
   * attached as the untouched .eml. Recipients are the owner's choice, as in any compose. */
  .post("/api/messages/:id/forward", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const input = await readJson(c, ForwardInputSchema);
    const result = await forwardMessage(
      id,
      { ...input, idempotencyKey: sendIdempotencyKey(c.req.header("Idempotency-Key")) },
      c.env,
      c.env.DB,
      c.env.MAIL_BUCKET,
    );
    if (!result.ok) {
      log.warn("forward_refused", { messageId: id, code: result.code });
      throw new AppError(400, result.code, result.message);
    }
    log.info("forward_sent", { messageId: id, forwardId: result.outcome.id, actor: actorOf(c).email });
    return c.json(result.outcome, 201);
  })

  /**
   * Send a failed message again (B5): a new row in the same thread with the same body and
   * files, re-read from the vault. Only a delivery that actually failed is accepted.
   */
  .post("/api/messages/:id/resend", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const result = await resendMessage(
      id,
      c.env,
      c.env.DB,
      c.env.MAIL_BUCKET,
    );
    if (!result.ok) {
      log.warn("resend_refused", { messageId: id, code: result.code });
      throw new AppError(400, result.code, result.message);
    }
    log.info("resend_sent", { messageId: id, againId: result.outcome.id, actor: actorOf(c).email });
    return c.json(result.outcome, 201);
  })

  /** Cleanup runs from durable deletion jobs; pending mail is hidden until cleanup completes. */
  .delete("/api/messages/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    await requireIrreversibleStepUp(c.env.DB, c.req.header(STEP_UP_HEADER), "message.delete");
    const result = await requestMessageDeletion(c.env.DB, id);
    if (!result.found) throw notFound("Message not found");
    log.info("message_deletion_queued", {
      actor: actorOf(c).email,
      messageId: id,
      state: result.state,
    });
    return c.json(
      { deleted: result.state === "DONE", state: result.state },
      result.state === "DONE" ? 200 : 202,
    );
  })

  /**
   * The original bytes exactly as they arrived — for archiving a message outside the
   * vault, or moving it to another mail system. The stored raw object is the source the
   * parsed view was derived from, so what downloads is what was delivered, not a rebuild.
   */
  .get("/api/messages/:id/raw", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    const row = await getMessageRow(c.env.DB, id);
    if (!row) throw notFound("Message not found");
    const obj = await getObject(c.env.MAIL_BUCKET, row.raw_r2_key);
    if (!obj) throw notFound("The original message is no longer in storage");
    const base =
      (row.subject ?? "message")
        .normalize("NFKD")
        .replace(/[^\w\s.-]+/g, "")
        .trim()
        .slice(0, 60) || "message";
    return new Response(obj.body, {
      headers: {
        "content-type": "message/rfc822",
        "content-disposition": `attachment; filename="${base}.eml"`,
        "content-length": String(obj.size),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  })

  /**
   * Authenticated attachment download (section 20/43). Ownership is enforced by the
   * message+attachment FK lookup; the object streams from the private bucket with a
   * safe filename and forced `attachment` disposition so nothing inlines/executes.
   */
  .get("/api/messages/:messageId/attachments/:attachmentId", async (c) => {
    const { messageId, attachmentId } = AttachmentParam.parse({
      messageId: c.req.param("messageId"),
      attachmentId: c.req.param("attachmentId"),
    });
    const att = await findAttachment(c.env.DB, messageId, attachmentId);
    if (!att) throw notFound("Attachment not found");
    const obj = await getObject(c.env.MAIL_BUCKET, att.r2_key);
    if (!obj) throw notFound("Attachment content unavailable");

    const safeName = sanitizeFilename(att.safe_filename || att.filename);
    // A picture the owner asked to see opens in its own tab rather than downloading; the
    // bytes come from the same authenticated route either way, and nosniff keeps it honest.
    const wantInline =
      ["1", "true"].includes((c.req.query("inline") ?? "").toLowerCase()) &&
      (att.content_type || "").startsWith("image/");
    const headers = new Headers({
      "Content-Type": att.content_type || "application/octet-stream",
      "Content-Disposition": `${wantInline ? "inline" : "attachment"}; filename="${safeName.replace(/"/g, "")}"`,
      "Content-Length": String(obj.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    return new Response(obj.body, { status: 200, headers });
  });
