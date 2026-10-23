import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  BulkMessageAction,
  BulkMessageInputSchema,
  MessageListQuerySchema,
  ReadFlagSchema,
  ReplyInputSchema,
  paginated,
  type BulkMessageResult,
} from "@mailvault/shared";
import type { AppEnv } from "../app-env";
import {
  deleteMessage,
  deleteMessages,
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
import { sendReply } from "../mail/send";
import { sanitizeFilename } from "../lib/filename";
import { deleteKeys, getObject } from "../storage/r2";
import { removeIndex, searchMessageIds, semanticEnabled } from "../lib/semantic";
import { sanitizeEmailHtml } from "../security/sanitize-html";
import { actorOf, parseQuery, readJson } from "./_helpers";

const IdParam = z.object({ id: z.string().min(1) });
const AttachmentParam = z.object({ messageId: z.string().min(1), attachmentId: z.string().min(1) });

/** Run after the response leaves: waitUntil in the Workers runtime, fire-and-forget under tests. */
function detach(c: Context<AppEnv>, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

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
const FLAG_ACTIONS: Record<Exclude<BulkMessageAction, typeof BulkMessageAction.Delete>, [FlagColumn, 0 | 1]> = {
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
      const { removed, keys } = await deleteMessages(c.env.DB, ids);
      const purged = await deleteKeys(c.env.MAIL_BUCKET, keys);
      // Embeddings are copies of content the owner just deleted; they go with it — but
      // detached, because up to 200 Vectorize calls must not hold the response that
      // already says the mail is gone.
      detach(c, Promise.allSettled(ids.map((id) => removeIndex(c.env, id))));
      log.info("messages_bulk_deleted", { actor: actorOf(c).email, count: removed, r2Attempted: purged.attempted });
      return c.json({
        action,
        affected: removed,
        r2ObjectsRemoved: purged.attempted - purged.failed.length,
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

    return c.json({
      ...body,
      textBody: parsed?.text ?? null,
      htmlBody: parsed?.html ? sanitizeEmailHtml(parsed.html, { allowRemoteImages: allowRemote }) : null,
      parseDegraded: body.parseDegraded || parsed?.degraded === true,
    });
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
    const result = await sendReply(id, input, c.env, c.env.DB, c.env.MAIL_BUCKET);
    if (!result.ok) {
      log.warn("reply_refused", { messageId: id, code: result.code });
      throw new AppError(400, result.code, result.message);
    }
    log.info("reply_sent", { messageId: id, replyId: result.outcome.id, actor: actorOf(c).email });
    return c.json(result.outcome, 201);
  })

  /** Delete permanently removes the row plus raw/parsed/attachment R2 objects (section 24). */
  .delete("/api/messages/:id", async (c) => {
    const { id } = IdParam.parse({ id: c.req.param("id") });
    if (!(await getMessageRow(c.env.DB, id))) throw notFound("Message not found");
    const keys = await deleteMessage(c.env.DB, id);
    const removed = await deleteKeys(c.env.MAIL_BUCKET, keys);
    // The embedding is a copy of content the owner just deleted; it goes with it.
    await removeIndex(c.env, id);
    log.info("message_deleted", { actor: actorOf(c).email, messageId: id, r2Attempted: removed.attempted });
    return c.json({ deleted: true, r2ObjectsRemoved: removed.attempted - removed.failed.length });
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
    const headers = new Headers({
      "Content-Type": att.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName.replace(/"/g, "")}"`,
      "Content-Length": String(obj.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    return new Response(obj.body, { status: 200, headers });
  });
