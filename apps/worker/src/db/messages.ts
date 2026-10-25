import { visibleMessageSql } from "./visibility";
import type {
  Attachment,
  AuthVerdict,
  ExtractedCode,
  MessageAuth,
  MessageDetail,
  MessageListQuery,
  MessageSummary,
  SendStatus,
  VerificationLink,
} from "@mailvault/shared";
import {
  MessageDirection,
  parseSearchQuery,
  type MessageCounters,
} from "@mailvault/shared";
import { newId, nowIso } from "../lib/util";
import { listRecipients } from "./recipients";
import { parseJson, toMessageAuth, toMessageSummary } from "./mappers";
import type { AttachmentRow, MessageRow } from "./rows";

/**
 * The validated query plus whatever the caller resolved first. `semanticIds` comes from
 * Vectorize and is not something a client may send directly — it is looked up server-side
 * only when the owner has turned semantic search on.
 *
 * `direction` is optional here because an internal caller naming no direction means the
 * inbox, which is also what the API schema defaults to; the two must not disagree.
 */
export type ListInput = Omit<MessageListQuery, "direction" | "threaded" | "before"> & {
  direction?: MessageListQuery["direction"];
  threaded?: boolean;
  semanticIds?: string[];
  /**
   * Keyset cursor (`receivedAt|id` of the last row already shown). Only honoured for the
   * plain list: a search ranks rows and a threaded view partitions them, and in both a
   * "below this row" predicate would silently mean something else.
   */
  before?: { receivedAt: string; id: string };
};

export interface InsertMessageInput {
  id?: string;
  domainId: string;
  aliasId: string | null;
  providerMessageId: string | null;
  dedupeKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  headerFrom: string | null;
  headerTo: string | null;
  subject: string | null;
  preview: string | null;
  receivedAt: string;
  headerDate?: string | null;
  rawSize: number;
  rawR2Key: string;
  parsedR2Key: string | null;
  hasAttachments: boolean;
  attachmentCount: number;
  codes: ExtractedCode[];
  links: VerificationLink[];
  authVerdict: AuthVerdict;
  auth: MessageAuth | null;
  /** Omitted for received mail, where both default to the inbound shape. */
  direction?: MessageDirection;
  threadRootId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  replyTo?: string | null;
  cc?: string | null;
  sendStatus?: SendStatus | null;
  sendError?: string | null;
  listUnsubscribe?: string | null;
  oneClickUnsubscribe?: boolean;
}

export interface InsertAttachmentInput {
  /**
   * Minted here when absent. An outbound send passes its own because the object is written to
   * R2 before the row exists, and its key names this id.
   */
  id?: string;
  filename: string;
  safeFilename: string;
  contentType: string | null;
  size: number;
  r2Key: string;
  contentId: string | null;
}

function changes(res: { meta?: unknown }): number {
  return Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
}

/** Returns the new message id, or null when the dedupe_key already existed. */
export async function insertMessage(db: D1Database, m: InsertMessageInput): Promise<string | null> {
  const id = m.id ?? newId();
  try {
    await db
      .prepare(
        `INSERT INTO messages (
          id, domain_id, alias_id, provider_message_id, dedupe_key,
          envelope_from, envelope_to, header_from, header_to, subject, preview,
          received_at, raw_size, raw_r2_key, parsed_r2_key, has_attachments,
          attachment_count, is_read, extracted_codes_json, verification_links_json,
          auth_verdict, auth_json, created_at,
          direction, thread_root_id, in_reply_to, references_json, reply_to, cc,
          send_status, send_error, list_unsubscribe, list_unsubscribe_post, header_date
        ) VALUES (
          ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
          ?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34
        )`,
      )
      .bind(
        id,
        m.domainId,
        m.aliasId,
        m.providerMessageId,
        m.dedupeKey,
        m.envelopeFrom,
        m.envelopeTo,
        m.headerFrom,
        m.headerTo,
        m.subject,
        m.preview,
        m.receivedAt,
        m.rawSize,
        m.rawR2Key,
        m.parsedR2Key,
        m.hasAttachments ? 1 : 0,
        m.attachmentCount,
        // Sent mail is written as read: the owner just composed it.
        m.direction === MessageDirection.Out ? 1 : 0,
        JSON.stringify(m.codes),
        JSON.stringify(m.links),
        m.authVerdict,
        m.auth ? JSON.stringify(m.auth) : null,
        nowIso(),
        m.direction ?? MessageDirection.In,
        // A message that starts a conversation is that conversation. Filled in by the
        // caller when the thread is known, and back-filled below when it is not.
        m.threadRootId ?? id,
        m.inReplyTo ?? null,
        m.references && m.references.length > 0 ? JSON.stringify(m.references) : null,
        m.replyTo ?? null,
        m.cc ?? null,
        m.sendStatus ?? null,
        m.sendError ?? null,
        m.listUnsubscribe ?? null,
        // The header is stored as a flag rather than its text: the only value it may hold is
        // the one that means one-click, so a stored copy of the sender's wording adds nothing.
        m.oneClickUnsubscribe ? "List-Unsubscribe=One-Click" : null,
        m.headerDate ?? null,
      )
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed: messages.dedupe_key/i.test(msg)) return null;
    throw err;
  }
}

/**
 * The thread a reply belongs to: the newest message whose Message-ID appears in this
 * one's In-Reply-To or References, and that message's own root.
 *
 * Falls back to a fresh thread rather than guessing from the subject, because "Re: Invoice"
 * between two unrelated customers is not the same conversation, and merging them would put
 * one customer's mail where another can read it.
 */
export async function findThreadRoot(
  db: D1Database,
  refs: (string | null | undefined)[],
): Promise<string | null> {
  const ids = [...new Set(refs.filter((r): r is string => !!r))].slice(0, 20);
  if (ids.length === 0) return null;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const row = await db
    .prepare(
      `SELECT COALESCE(thread_root_id, id) AS root
       FROM messages m WHERE ${visibleMessageSql()} AND provider_message_id IN (${placeholders})
       ORDER BY received_at DESC LIMIT 1`,
    )
    .bind(...ids)
    .first<{ root: string }>();
  return row?.root ?? null;
}

/** Every message of one conversation, oldest first — the shape a thread view renders. */
export async function listThread(db: D1Database, rootId: string): Promise<MessageSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
       FROM messages m
       LEFT JOIN aliases a ON a.id = m.alias_id
       LEFT JOIN domains d ON d.id = m.domain_id
       WHERE (m.thread_root_id = ?1 OR m.id = ?1) AND ${visibleMessageSql()}
       ORDER BY m.received_at ASC, m.id ASC`,
    )
    .bind(rootId)
    .all<MessageRow>();
  return (results ?? []).map(toMessageSummary);
}

/**
 * How many messages have gone out since the UTC day began. Cloudflare's own
 * `/email/sending/limits` counter is not realtime — it did not move across three sends
 * when measured — so the daily budget has to be counted here to mean anything.
 */
export async function countSentSince(db: D1Database, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM outbound_jobs WHERE created_at >= ?1 AND (quota_charged=1 OR (state='STAGING' AND lease_expires_at > ?2))) +
      (SELECT COUNT(*) FROM messages m WHERE direction='OUT' AND received_at >= ?1
       AND COALESCE(send_status,'QUEUED') NOT IN ('FAILED','SUPPRESSED')
       AND NOT EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.message_id=m.id)) AS c`,
    )
    .bind(sinceIso, nowIso())
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/**
 * Keep the search index in step with a message. Delete-then-insert so a redelivered or
 * re-indexed message cannot leave duplicate index rows behind.
 */
export async function indexMessage(
  db: D1Database,
  messageId: string,
  text: { subject: string | null; preview: string | null; sender: string | null; body?: string | null },
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM messages_fts WHERE message_id = ?1`).bind(messageId),
    db
      .prepare(
        `INSERT INTO messages_fts (message_id, subject, preview, sender, body) VALUES (?1,?2,?3,?4,?5)`,
      )
      .bind(messageId, text.subject ?? "", text.preview ?? "", text.sender ?? "", text.body ?? ""),
  ]);
}

/**
 * One switch for the whole pile (plan C5): mark everything the current list query would
 * show as unread, read. The same filters the list builds decide the rows, so "mark all"
 * inside one mailbox or one search means exactly what the owner is looking at.
 */
export async function markAllRead(db: D1Database, query: ListInput): Promise<number> {
  const { where, params } = buildListFilters(query);
  const res = await db
    .prepare(
      `UPDATE messages SET is_read = 1
       WHERE is_read = 0 AND id IN (SELECT m.id ${SELECT_LIST} WHERE ${where})`,
    )
    .bind(...params)
    .run();
  return Number(res.meta.changes ?? 0);
}

export async function dedupeKeyExists(db: D1Database, dedupeKey: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM messages WHERE dedupe_key = ?1`)
    .bind(dedupeKey)
    .first<{ x: number }>();
  return !!row;
}

export async function insertAttachments(
  db: D1Database,
  messageId: string,
  attachments: InsertAttachmentInput[],
): Promise<void> {
  if (attachments.length === 0) return;
  const now = nowIso();
  const stmts = attachments.map((a) =>
    db
      .prepare(
        `INSERT INTO attachments (id, message_id, filename, safe_filename, content_type, size, r2_key, content_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        a.id ?? newId(),
        messageId,
        a.filename,
        a.safeFilename,
        a.contentType,
        a.size,
        a.r2Key,
        a.contentId,
        now,
      ),
  );
  await db.batch(stmts);
}

/**
 * FTS5 query syntax is part of the user's input: an unbalanced quote or a stray operator
 * is a syntax error, not a search. Keep only word-ish characters, quote each word, and
 * cap the token count.
 */
export function ftsMatch(raw: string, maxWords = 8): string {
  // A double-quoted stretch stays one FTS5 phrase ("big deal"), so a search for the
  // sentence finds the sentence; bare words still AND together as they always did (C12).
  const pieces = raw.toLowerCase().match(/"[^"]+"|[^\s]+/g) ?? [];
  return pieces
    .flatMap((piece) =>
      piece.length > 1 && piece.startsWith('"') && piece.endsWith('"')
        ? [piece]
        : piece.split(/[^a-z0-9@._-]+/),
    )
    // Whatever shape the input came in, what reaches FTS5 is a clean quoted token — a
    // stray quote can never become an unterminated string.
    .map((w) => w.replace(/^"+|"+$/g, ""))
    .filter(Boolean)
    .slice(0, maxWords)
    .map((w) => `"${w}"`)
    .join(" AND ");
}

function buildListFilters(query: ListInput): { where: string; params: unknown[]; rank: string } {
  const clauses: string[] = [visibleMessageSql()];
  const params: unknown[] = [];
  const push = (val: unknown) => {
    params.push(val);
    return params.length;
  };
  // Operators are re-read from `q` here rather than taken on trust from the caller: the same
  // string has to mean the same thing in the web app's chips and in the SQL, and only the
  // side that writes the query can guarantee that.
  const intent = parseSearchQuery(query.q);

  // Unread by tab, or by `is:unread` / `is:read` in the query. An explicit `is:read` outranks
  // the tab, which is how you find something you already answered while on the unread view.
  const unread = intent.unread ?? (query.filter === "unread" ? true : undefined);
  if (unread === true) clauses.push("m.is_read = 0");
  else if (unread === false) clauses.push("m.is_read = 1");

  const starred = query.starred ? query.starred === "true" : intent.starred ? true : undefined;
  if (starred !== undefined) clauses.push(`m.starred = ${starred ? 1 : 0}`);

  // Received and sent share the table, so a list says which side it wants — and wants it
  // explicitly, because "an inbox" is received mail. `all` is what a conversation view
  // uses; a thread without its own replies is not a thread.
  const direction = intent.direction ?? query.direction ?? "in";
  if (direction === "in") clauses.push("m.direction = 'IN'");
  else if (direction === "out") clauses.push("m.direction = 'OUT'");
  if (query.threadId) {
    const a = push(query.threadId);
    const b = push(query.threadId);
    clauses.push(`(m.thread_root_id = ?${a} OR m.id = ?${b})`);
  }
  // Rules file mail out of the working list; they never remove it. `all` is what the
  // archived view and any "show me everything" query uses.
  if (intent.filedOnly) clauses.push("m.archived = 1");
  else if (query.archived === "active") clauses.push("m.archived = 0");
  else if (query.archived === "archived") clauses.push("m.archived = 1");
  if (query.domainId) clauses.push(`m.domain_id = ?${push(query.domainId)}`);
  if (query.aliasId) clauses.push(`m.alias_id = ?${push(query.aliasId)}`);
  if (intent.after) clauses.push(`m.received_at >= ?${push(intent.after)}`);
  if (intent.before) clauses.push(`m.received_at <= ?${push(intent.before)}`);
  if (intent.hasAttachment) clauses.push("m.has_attachments = 1");
  // Chapter C12: the subject line as its own filter, and attachments by flavour.
  if (intent.subject) {
    clauses.push(`m.subject LIKE ?`);
    params.push(`%${intent.subject.replace(/[%_]/g, (c) => `\\${c}`)}%`);
  }
  if (intent.hasImage) {
    clauses.push(
      `EXISTS (SELECT 1 FROM attachments ai WHERE ai.message_id = m.id AND ai.content_type LIKE 'image/%')`,
    );
  }
  if (intent.hasPdf) {
    clauses.push(
      `EXISTS (SELECT 1 FROM attachments ap WHERE ap.message_id = m.id AND (ap.content_type = 'application/pdf' OR lower(ap.filename) LIKE '%.pdf'))`,
    );
  }

  if (intent.hasCode)
    clauses.push("(m.extracted_codes_json IS NOT NULL AND m.extracted_codes_json <> '[]')");
  // An address operator matches anywhere the address can be written, including the alias it
  // arrived at: `from:` on a shared alias is usually a search for the person behind it.
  for (const [raw, columns] of [
    [intent.from, ["m.envelope_from", "m.header_from"]],
    [intent.to, ["m.envelope_to", "m.header_to", "m.cc", "a.address"]],
  ] as const) {
    if (!raw) continue;
    const p = push(`%${raw}%`);
    clauses.push(
      `(${columns.map((col) => `lower(COALESCE(${col}, '')) LIKE ?${p}`).join(" OR ")})`,
    );
  }

  let rank = "0";
  if (intent.text) {
    // Text comes from the FTS index; codes and alias text from LIKE, so searching an
    // address or an OTP still finds mail stored before the index existed. A query with no
    // usable words produces an empty MATCH, which FTS5 rejects — so the index is only
    // consulted when there is something to look for in it.
    const match = ftsMatch(intent.text);
    const like = push(`%${intent.text.toLowerCase()}%`);
    const terms = [
      `lower(COALESCE(m.extracted_codes_json, '')) LIKE ?${like}`,
      `lower(COALESCE(a.address, m.envelope_to)) LIKE ?${like}`,
      `lower(COALESCE(a.label, '')) LIKE ?${like}`,
    ];
    if (match) {
      const a = push(match);
      const b = push(match);
      // bm25 is negative and lower is better; rows found only by LIKE get 0, so text
      // matches rank above code/alias matches and everything else stays newest-first.
      rank = `COALESCE((SELECT bm25(messages_fts) FROM messages_fts WHERE message_id = m.id AND messages_fts MATCH ?${a}), 0)`;
      terms.unshift(
        `EXISTS (SELECT 1 FROM messages_fts WHERE message_id = m.id AND messages_fts MATCH ?${b})`,
      );
    }
    // Semantic hits arrive as ids from Vectorize. They join the same result set rather
    // than replacing it, so a keyword match is never lost because the model disagreed.
    if (query.semanticIds && query.semanticIds.length > 0) {
      const placeholders = query.semanticIds.map((id) => `?${push(id)}`).join(", ");
      terms.push(`m.id IN (${placeholders})`);
    }
    clauses.push(`(${terms.join(" OR ")})`);
  }

  // Keyset pagination for the plain list: rows strictly below the cursor in list order.
  // Guarded against search/threaded views here rather than at the caller, because the
  // guard is exactly "would `received_at DESC, id DESC` still be the whole ordering".
  if (query.before && !intent.text && !query.threaded) {
    const at = push(query.before.receivedAt);
    const atAgain = push(query.before.receivedAt);
    const id = push(query.before.id);
    clauses.push(`(m.received_at < ?${at} OR (m.received_at = ?${atAgain} AND m.id < ?${id}))`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params, rank };
}

const SELECT_LIST = `
  FROM messages m
  LEFT JOIN aliases a ON a.id = m.alias_id
  LEFT JOIN domains d ON d.id = m.domain_id`;

/**
 * The list, either as delivered or collapsed to one row per conversation.
 *
 * Grouping is a window pass over the same filtered select rather than a second query shape,
 * so a search, a mailbox filter and an alias view all keep behaving the same way — and the
 * row that represents a thread is the *best-matching* one (search rank first, then newest),
 * not whichever happened to arrive first.
 */
export async function listMessages(
  db: D1Database,
  query: ListInput,
): Promise<{ items: MessageSummary[]; total: number }> {
  const { where, params, rank } = buildListFilters(query);
  const inner = `SELECT m.*, ${rank} AS rank, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
                 ${SELECT_LIST} ${where}`;
  const order = `rank ASC, received_at DESC, id DESC`;
  const limitAt = params.length + 1;

  if (query.threaded) {
    const countRow = await db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(m.thread_root_id, m.id)) AS c ${SELECT_LIST} ${where}`,
      )
      .bind(...params)
      .first<{ c: number }>();
    const { results } = await db
      .prepare(
        `SELECT * FROM (
           SELECT g.*, ROW_NUMBER() OVER w AS rn,
                  -- The size of the conversation, not of the current result: a search that
                  -- matched one message of a three-message thread still describes a thread of
                  -- three, which is what the badge on the row means. A correlated count is
                  -- exact and indexed, where a window over the filtered rows would drift with
                  -- every filter the owner applies.
                  (SELECT COUNT(*) FROM messages t
                     WHERE COALESCE(t.thread_root_id, t.id) = COALESCE(g.thread_root_id, g.id) AND ${visibleMessageSql("t")}) AS thread_count
           FROM (${inner}) g
           WINDOW w AS (PARTITION BY COALESCE(g.thread_root_id, g.id) ORDER BY ${order})
         )
         WHERE rn = 1
         ORDER BY ${order}
         LIMIT ?${limitAt} OFFSET ?${limitAt + 1}`,
      )
      .bind(...params, query.limit, query.offset)
      .all<MessageRow & { thread_count?: number }>();
    return {
      items: (results ?? []).map((r) => ({
        ...toMessageSummary(r),
        threadCount: Number(r.thread_count ?? 1),
      })),
      total: Number(countRow?.c ?? 0),
    };
  }

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS c ${SELECT_LIST} ${where}`)
    .bind(...params)
    .first<{ c: number }>();
  // The cursor page needs no OFFSET: the WHERE clause already starts it below the last
  // row of the previous page, so LIMIT alone is the whole page boundary.
  const paging = query.before && rank === "0" ? "" : ` OFFSET ?${limitAt + 1}`;
  const { results } = await db
    .prepare(`SELECT * FROM (${inner}) ORDER BY ${order} LIMIT ?${limitAt}${paging}`)
    .bind(...(query.before && rank === "0" ? [...params, query.limit] : [...params, query.limit, query.offset]))
    .all<MessageRow>();
  return { items: (results ?? []).map(toMessageSummary), total: Number(countRow?.c ?? 0) };
}

/**
 * Addresses this mailbox has actually exchanged mail with, newest first — the composer's
 * autocomplete. Both directions count: having written to somebody is a stronger signal than
 * having received from them, which is what `outgoing` is for.
 *
 * The unfiltered call (composer opening) is cached briefly in the isolate: it unions two
 * whole-table scans, mail changes it only by adding a correspondent, and two minutes of
 * staleness in an autocomplete beats a full scan on every open.
 */
let correspondentsCache: { at: number; rows: Awaited<ReturnType<typeof queryCorrespondents>> } | null = null;
const CORRESPONDENTS_TTL_MS = 120_000;

async function queryCorrespondents(
  db: D1Database,
  q: string | undefined,
  limit: number,
): Promise<{ address: string; name: string | null; lastSeen: string; outgoing: boolean }[]> {
  const like = q ? `%${q.toLowerCase()}%` : "%";
  const { results } = await db
    .prepare(
      `SELECT
         addr AS address,
         MAX(NULLIF(display_name, '')) AS name,
         MAX(seen_at) AS last_seen,
         MAX(CASE WHEN direction = 'OUT' THEN 1 ELSE 0 END) AS went_out
       FROM (
         SELECT lower(COALESCE(envelope_from, '')) AS addr, COALESCE(header_from, '') AS display_name,
                received_at AS seen_at, direction
           FROM messages m WHERE ${visibleMessageSql()} AND direction = 'IN' AND envelope_from IS NOT NULL
         UNION ALL
         SELECT lower(header_to), COALESCE(header_to, ''), received_at, direction
           FROM messages m WHERE ${visibleMessageSql()} AND direction = 'OUT' AND header_to IS NOT NULL
       )
       WHERE addr <> '' AND (addr LIKE ?1 OR display_name LIKE ?1)
       GROUP BY addr
       ORDER BY last_seen DESC
       LIMIT ?2`,
    )
    .bind(like, Math.min(Math.max(limit, 1), 25))
    .all<{ address: string; name: string | null; last_seen: string; went_out: number }>();
  return (
    (results ?? [])
      .map((r) => ({
        address: r.address,
        name: displayNameOf(r.name) ?? displayNameOf(r.address),
        lastSeen: r.last_seen,
        outgoing: r.went_out === 1,
      }))
      // A sent message records its recipients as one header, so a row naming several of them is
      // not a single address and cannot be suggested as one.
      .filter((r) => r.address.includes("@") && !r.address.includes(","))
  );
}

export async function listCorrespondents(
  db: D1Database,
  q: string | undefined,
  limit = 8,
): Promise<{ address: string; name: string | null; lastSeen: string; outgoing: boolean }[]> {
  const clamp = Math.min(Math.max(limit, 1), 25);
  if (!q) {
    const hit =
      correspondentsCache && Date.now() - correspondentsCache.at < CORRESPONDENTS_TTL_MS ? correspondentsCache : null;
    if (hit) return hit.rows.slice(0, clamp);
    const rows = await queryCorrespondents(db, undefined, 25);
    correspondentsCache = { at: Date.now(), rows };
    return rows.slice(0, clamp);
  }
  return queryCorrespondents(db, q, clamp);
}

/** `"Name <a@b>"` → `Name`; a bare address has no display name. */
function displayNameOf(raw: string | null): string | null {  if (!raw) return null;
  const bracketed = /^([^<]*)<[^>]+>$/.exec(raw.trim());
  if (bracketed) return (bracketed[1] ?? "").replace(/^"|"$/g, "").trim() || null;
  return raw.includes("@") ? null : raw.trim() || null;
}

export async function getMessageRow(db: D1Database, id: string): Promise<MessageRow | null> {
  return db
    .prepare(
      `SELECT m.*, a.label AS alias_label, a.address AS alias_address, d.name AS domain_name
       FROM messages m
       LEFT JOIN aliases a ON a.id = m.alias_id
       LEFT JOIN domains d ON d.id = m.domain_id
       WHERE m.id = ?1 AND ${visibleMessageSql()}`,
    )
    .bind(id)
    .first<MessageRow>();
}

export async function getMessageAttachments(
  db: D1Database,
  messageId: string,
): Promise<Attachment[]> {
  const { results } = await db
    .prepare(`SELECT att.* FROM attachments att JOIN messages m ON m.id=att.message_id WHERE att.message_id = ?1 AND ${visibleMessageSql()} ORDER BY att.size DESC`)
    .bind(messageId)
    .all<AttachmentRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type ?? "application/octet-stream",
    size: Number(r.size),
    contentId: r.content_id,
    downloadPath: `/api/messages/${messageId}/attachments/${r.id}`,
  }));
}

export async function getMessageDetail(
  db: D1Database,
  id: string,
): Promise<(MessageDetail & { parsedR2Key: string | null }) | null> {
  const row = await getMessageRow(db, id);
  if (!row) return null;
  const summary = toMessageSummary(row);
  // Two independent reads of one message, asked for together: half the latency between
  // "opened" and "readable", same answers.
  const [attachments, recipients] = await Promise.all([getMessageAttachments(db, id), listRecipients(db, id)]);
  return {
    ...summary,
    // Only the detail view pays for this: the list badge shows the message-level summary,
    // which is a column rather than a join.
    recipients,
    appliedRuleNote: row.applied_rule_note ?? null,
    providerMessageId: row.provider_message_id,
    rawSize: Number(row.raw_size),
    extractedCodes: parseJson<ExtractedCode[]>(row.extracted_codes_json, []),
    verificationLinks: parseJson<VerificationLink[]>(row.verification_links_json, []),
    attachments,
    htmlBody: null, // filled by the route from R2 parsed content + sanitization
    textBody: null,
    parseDegraded: !row.parsed_r2_key,
    auth: toMessageAuth(row),
    inReplyTo: row.in_reply_to ?? null,
    references: parseJson<string[]>(row.references_json, []),
    parsedR2Key: row.parsed_r2_key ?? null,
    replyTo: row.reply_to ?? null,
    sendError: row.send_error ?? null,
    listUnsubscribe: row.list_unsubscribe ?? null,
    oneClickUnsubscribe: row.list_unsubscribe_post != null,
  };
}

export async function setMessageRead(db: D1Database, id: string, isRead: boolean): Promise<number> {
  return setFlag(db, [id], "is_read", isRead ? 1 : 0);
}

/**
 * The three message flags a multi-select can move, mapped from a fixed vocabulary rather
 * than from anything a caller sends — an interpolation of a column name here would be a SQL
 * injection with extra steps.
 */
const FLAG_COLUMNS = {
  is_read: "is_read",
  starred: "starred",
  archived: "archived",
} as const;
export type FlagColumn = keyof typeof FLAG_COLUMNS;

/**
 * Set one flag on many messages in a single statement.
 *
 * The `<> value` guard keeps the count honest: it returns rows whose flag actually moved,
 * so re-marking something already marked does not report work that did not happen, and no
 * row is rewritten for nothing.
 */
export async function setFlag(
  db: D1Database,
  ids: string[],
  column: FlagColumn,
  value: 0 | 1,
): Promise<number> {
  if (ids.length === 0) return 0;
  const col = FLAG_COLUMNS[column];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const res = await db
    .prepare(
      `UPDATE messages SET ${col} = ?${ids.length + 1} WHERE id IN (${placeholders}) AND ${visibleMessageSql("messages")} AND ${col} <> ?${ids.length + 1}`,
    )
    .bind(...ids, value)
    .run();
  return changes(res);
}

/** Flags for several messages at once, returning the keys of everything removed. */
export async function deleteMessages(
  db: D1Database,
  ids: string[],
): Promise<{ removed: number; keys: string[] }> {
  if (ids.length === 0) return { removed: 0, keys: [] };
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
  const [stored, attached] = await db.batch([
    db
      .prepare(`SELECT raw_r2_key, parsed_r2_key FROM messages WHERE id IN (${placeholders})`)
      .bind(...ids),
    db.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders})`).bind(...ids),
  ]);
  const rows = (stored?.results ?? []) as { raw_r2_key: string; parsed_r2_key: string | null }[];
  if (rows.length === 0) return { removed: 0, keys: [] };
  const keys = new Set<string>();
  for (const r of rows) {
    keys.add(r.raw_r2_key);
    if (r.parsed_r2_key) keys.add(r.parsed_r2_key);
  }
  for (const a of (attached?.results ?? []) as { r2_key: string }[]) keys.add(a.r2_key);

  await db.batch([
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids),
    db.prepare(`DELETE FROM messages_fts WHERE message_id IN (${placeholders})`).bind(...ids),
  ]);
  return { removed: rows.length, keys: [...keys] };
}

/**
 * Tab and mailbox badges, in one pass over `messages`.
 *
 * Counted here rather than derived from the page the owner is looking at: "3 unread" has to
 * mean three unread messages, not three of the fifty currently listed, or the number is a
 * lie the moment anything is filtered.
 */
export async function messageCounters(db: D1Database, domainId?: string): Promise<MessageCounters> {
  // Eight small counts in one batch, each an index seek on its tab's filter, instead of
  // one aggregate that reads every row: a badge should not have to walk the whole table
  // to know its number. The visibility fence main added stays in every branch — deleted-
  // pending mail is not unread mail.
  const scope = domainId ? " AND m.domain_id = ?1" : "";
  const bind = domainId ? [domainId] : [];
  const count = (where: string) =>
    db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${visibleMessageSql()} AND (${where})${scope}`).bind(...bind);
  const [inboxTotal, inboxUnread, sentTotal, sentUnread, starredTotal, starredUnread, filedTotal, filedUnread, perMailbox] =
    await db.batch([
      count(`m.direction = 'IN' AND m.archived = 0`),
      count(`m.direction = 'IN' AND m.archived = 0 AND m.is_read = 0`),
      count(`m.direction = 'OUT'`),
      count(`m.direction = 'OUT' AND m.is_read = 0`),
      count(`m.starred = 1`),
      count(`m.starred = 1 AND m.is_read = 0`),
      count(`m.archived = 1`),
      count(`m.archived = 1 AND m.is_read = 0`),
      db
        .prepare(
          `SELECT domain_id, COUNT(*) AS unread FROM messages m
           WHERE ${visibleMessageSql()} AND m.direction = 'IN' AND m.archived = 0 AND m.is_read = 0${scope}
           GROUP BY domain_id`,
        )
        .bind(...bind),
    ]);
  const of = (r: unknown): number => Number((r as { results?: { c?: number }[] } | undefined)?.results?.[0]?.c ?? 0);

  return {
    inbox: { total: of(inboxTotal), unread: of(inboxUnread) },
    sent: { total: of(sentTotal), unread: of(sentUnread) },
    starred: { total: of(starredTotal), unread: of(starredUnread) },
    filed: { total: of(filedTotal), unread: of(filedUnread) },
    mailboxes: ((perMailbox as { results?: { domain_id: string; unread: number }[] })?.results ?? []).map((r) => ({
      domainId: r.domain_id,
      unread: Number(r.unread),
    })),
  };
}

export async function getRawKeysForMessage(db: D1Database, id: string): Promise<string[]> {
  const set = new Set<string>();
  const msg = await db
    .prepare(`SELECT raw_r2_key, parsed_r2_key FROM messages WHERE id = ?1`)
    .bind(id)
    .first<{ raw_r2_key: string; parsed_r2_key: string | null }>();
  if (msg) {
    set.add(msg.raw_r2_key);
    if (msg.parsed_r2_key) set.add(msg.parsed_r2_key);
  }
  const atts = await db
    .prepare(`SELECT r2_key FROM attachments WHERE message_id = ?1`)
    .bind(id)
    .all<{ r2_key: string }>();
  for (const a of atts.results ?? []) set.add(a.r2_key);
  return [...set];
}

/** Deletes the message, its index entry (attachments cascade via FK) and returns its R2 keys to purge. */
export async function deleteMessage(db: D1Database, id: string): Promise<string[]> {
  const keys = await getRawKeysForMessage(db, id);
  const [res] = await db.batch([
    db.prepare(`DELETE FROM messages WHERE id = ?1`).bind(id),
    db.prepare(`DELETE FROM messages_fts WHERE message_id = ?1`).bind(id),
  ]);
  return changes(res as { meta?: unknown }) === 0 ? [] : keys;
}

export async function findAttachment(
  db: D1Database,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  return db
    .prepare(`SELECT att.* FROM attachments att JOIN messages m ON m.id=att.message_id WHERE att.id = ?1 AND att.message_id = ?2 AND ${visibleMessageSql()}`)
    .bind(attachmentId, messageId)
    .first<AttachmentRow>();
}
