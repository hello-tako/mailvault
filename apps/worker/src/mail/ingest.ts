import type { Env } from "../env";
import { maxMessageBytes } from "../env";
import { sha256Hex, newId, nowIso } from "../lib/util";
import { sanitizeFilename } from "../lib/filename";
import { log } from "../lib/logging";
import { findActiveAliasByAddress } from "../db/aliases";
import { getDomainById } from "../db/domains";
import { fileByRule, listEnabledRules, recordRuleHits } from "../db/rules";
import { applyRules, NO_RULES, type AppliedRules } from "./rules";
import { insertMessageWithDependents, dedupeKeyExists, findThreadRoot } from "../db/messages";
import type { InsertMessageInput, InsertAttachmentInput } from "../db/messages";
import {
  buildRawKey,
  buildParsedKey,
  buildAttachmentKey,
  putRaw,
  putParsed,
  putAttachment,
  getObject,
  deleteKeys,
} from "../storage/r2";
import { parseMime } from "./parse";
import { assessAuth } from "./auth";
import { AuthPolicy, AuthVerdict, type MessageAuth } from "@mailvault/shared";
import { extractOtp } from "./otp";
import { extractLinks } from "./links";
import { buildPreview, stripHtmlToText } from "./preview";
import { normalizeLookupAddress, splitAddress } from "./normalize";

export type IngestResult =
  | { status: "stored"; messageId: string; verdict: AuthVerdict }
  | { status: "duplicate" }
  | {
      status: "rejected";
      reason: "unknown_recipient" | "invalid_recipient" | "too_large" | "unauthenticated";
    };

/**
 * What crosses the ingest queue.
 *
 * Deliberately only R2 keys and SMTP addressing — no subject, no body, no code, no link.
 * A job that fails permanently parks in a dead-letter queue, and that queue is not a
 * place where somebody's mail content may end up living unauthenticated.
 */
export interface IngestJob {
  v: 1;
  messageId: string;
  dedupeKey: string;
  domainId: string;
  aliasId: string;
  rawKey: string;
  parsedKey: string;
  envelopeFrom: string;
  envelopeTo: string;
}

/** The staged record: everything the commit needs, read back from R2 by key. */
interface StagedParse {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  replyTo: string | null;
  listUnsubscribe: string | null;
  oneClickUnsubscribe: boolean;
  text: string | null;
  html: string | null;
  degraded: boolean;
  rawSize: number;
  authResults: string[];
  attachments: InsertAttachmentInput[];
}

export type StageResult =
  | { status: "rejected" | "duplicate"; result: IngestResult }
  | { status: "staged"; job: IngestJob; keys: string[] };

interface Rejectable {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
}

/** Read a raw MIME stream into a bounded buffer; bail (without buffering) past the cap. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Bounded for D1 storage; the verdict is computed from the full evidence, not this copy. */
function toStoredAuth(a: ReturnType<typeof assessAuth>): MessageAuth {
  return { ...a, reasons: a.reasons.map((r) => r.slice(0, 120)), evidence: a.evidence.slice(0, 8) };
}

/** The part a rule matches on: who sent it, not who they claim to be in the header. */
function senderDomainOf(envelopeFrom: string): string {
  return (envelopeFrom.split("@").pop() ?? "").toLowerCase();
}

/**
 * Stage one inbound message: validate the recipient, parse, judge the sender, and write
 * every R2 object. Returns the job that commits it.
 *
 * Split from the commit so the fragile part — the D1 write — can be retried by a queue
 * without depending on a delivery attempt that may already be over. The reject decisions
 * stay here, because this is the only place still able to tell the sending server "no".
 */
export async function stageEmail(
  message: Rejectable,
  env: Env,
  db: D1Database,
  bucket: R2Bucket,
): Promise<StageResult> {
  const recipient = normalizeLookupAddress(message.to);
  const { valid } = splitAddress(message.to);
  if (!valid || !recipient) {
    message.setReject("invalid recipient");
    log.warn("mail_rejected", { reason: "invalid_recipient" });
    return { status: "rejected", result: { status: "rejected", reason: "invalid_recipient" } };
  }

  const alias = await findActiveAliasByAddress(db, recipient);
  if (!alias) {
    // Unknown or disabled aliases are dropped — never auto-created (section 11).
    message.setReject("no mailbox for this address");
    log.info("mail_rejected", { reason: "unknown_recipient", recipient });
    return { status: "rejected", result: { status: "rejected", reason: "unknown_recipient" } };
  }

  const cap = maxMessageBytes(env);
  if (message.rawSize && message.rawSize > cap) {
    message.setReject("message too large");
    log.info("mail_rejected", { reason: "too_large", aliasId: alias.id });
    return { status: "rejected", result: { status: "rejected", reason: "too_large" } };
  }

  const bytes = await readCapped(message.raw, cap);
  if (!bytes) {
    message.setReject("message too large");
    log.info("mail_rejected", { reason: "too_large", aliasId: alias.id });
    return { status: "rejected", result: { status: "rejected", reason: "too_large" } };
  }

  const rawHex = await sha256Hex(bytes);
  // Dedupe key binds the envelope recipient to content so identical bodies BCC'd to
  // different aliases stay separate, while the same event redelivered dedupes.
  const dedupeKey = await sha256Hex(`${recipient}|${rawHex}`);
  if (await dedupeKeyExists(db, dedupeKey)) {
    log.info("mail_duplicate", { aliasId: alias.id });
    return { status: "duplicate", result: { status: "duplicate" } };
  }

  // Parse (malformed must not crash the Worker — section 16).
  let text: string | null = null;
  let html: string | null = null;
  let subject: string | null = null;
  let headerFrom: string | null = null;
  let headerTo: string | null = null;
  let headerCc: string | null = null;
  let providerMessageId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let replyTo: string | null = null;
  let listUnsubscribe: string | null = null;
  let oneClickUnsubscribe = false;
  let receivedAt = message.headers.get("date") || nowIso();
  let parsedAttachments: { filename: string; contentType: string; contentId: string | null; bytes: Uint8Array }[] = [];
  let authResults: string[] = [];
  let degraded = false;
  try {
    const parsed = await parseMime(bytes);
    text = parsed.text;
    html = parsed.html;
    subject = parsed.subject;
    headerFrom = parsed.headerFrom;
    headerTo = parsed.headerTo;
    headerCc = parsed.headerCc;
    providerMessageId = parsed.messageId;
    inReplyTo = parsed.inReplyTo;
    references = parsed.references;
    replyTo = parsed.replyTo;
    listUnsubscribe = parsed.listUnsubscribe;
    oneClickUnsubscribe = parsed.oneClickUnsubscribe;
    if (parsed.date) receivedAt = parsed.date;
    parsedAttachments = parsed.attachments;
    authResults = parsed.authResults;
  } catch (err) {
    degraded = true;
    log.warn("mail_parse_failed", { aliasId: alias.id, error: err instanceof Error ? err.message : "parse_error" });
    headerTo = message.to;
  }

  // Judged before anything is stored: a spoofed message must never reach the owner
  // looking like a verified one, and its "code"/"verify link" are what a phisher forges.
  const auth = assessAuth({ authResults, headerFrom, envelopeFrom: message.from });
  if (auth.verdict === AuthVerdict.Spoofed) {
    const domain = await getDomainById(db, alias.domainId);
    if (domain?.authPolicy === AuthPolicy.Reject) {
      message.setReject("sender authentication failed");
      log.warn("mail_rejected", { reason: "unauthenticated", aliasId: alias.id });
      return { status: "rejected", result: { status: "rejected", reason: "unauthenticated" } };
    }
  }

  const messageId = newId();
  const rawKey = buildRawKey(alias.domainId, alias.id, receivedAt, messageId);
  const parsedKey = buildParsedKey(messageId);

  const writtenKeys: string[] = [rawKey, parsedKey];
  const attachmentRows: InsertAttachmentInput[] = [];
  try {
    await putRaw(bucket, rawKey, bytes);
    // Independent objects, written together: one message with many files should not pay
    // a round trip per file.
    await Promise.all(
      parsedAttachments.map(async (a) => {
        const attId = newId();
        const safe = sanitizeFilename(a.filename);
        const key = buildAttachmentKey(messageId, attId, safe);
        await putAttachment(bucket, key, a.bytes, a.contentType);
        writtenKeys.push(key);
        attachmentRows.push({
          filename: a.filename,
          safeFilename: safe,
          contentType: a.contentType,
          size: a.bytes.byteLength,
          r2Key: key,
          contentId: a.contentId,
        });
      }),
    );
    // The staged object is what the commit reads back, so it holds everything the
    // metadata row needs — including the headers the verdict was judged from.
    const staged: StagedParse = {
      subject,
      from: headerFrom,
      to: headerTo,
      cc: headerCc,
      date: receivedAt,
      messageId: providerMessageId,
      inReplyTo,
      references,
      replyTo,
      listUnsubscribe,
      oneClickUnsubscribe,
      text,
      html,
      degraded,
      rawSize: bytes.byteLength,
      authResults,
      attachments: attachmentRows,
    };
    await putParsed(bucket, parsedKey, staged);
  } catch (err) {
    // Nothing is committed and no retry can find these keys, so clean up before the
    // delivery is attempted again from the top (section 14).
    await deleteKeys(bucket, writtenKeys);
    log.error("mail_stage_failed", { aliasId: alias.id, error: err instanceof Error ? err.message : "error" });
    throw err;
  }

  return {
    status: "staged",
    keys: writtenKeys,
    job: {
      v: 1,
      messageId,
      dedupeKey,
      domainId: alias.domainId,
      aliasId: alias.id,
      rawKey,
      parsedKey,
      envelopeFrom: message.from,
      envelopeTo: message.to,
    },
  };
}

/**
 * Commit a staged message: re-derive codes, links, preview and the verdict from the
 * staged parse (pure functions over the same bytes, so the record cannot disagree with
 * the judgement made at the edge) and write the metadata row plus its FTS entry.
 *
 * Throwing here is the retryable case, and the point of the split: the R2 objects stay
 * exactly where they are, so the redelivery works on the same input. Nothing is deleted
 * on failure — that is how a transient database error would turn into a lost message.
 */
export async function commitIngest(job: IngestJob, db: D1Database, bucket: R2Bucket): Promise<IngestResult> {
  const obj = await getObject(bucket, job.parsedKey);
  if (!obj) {
    log.error("mail_commit_missing", { messageId: job.messageId, aliasId: job.aliasId });
    throw new Error("staged_parse_missing");
  }
  const staged = await obj.json<StagedParse>();

  const codes = extractOtp(`${staged.subject ?? ""}\n${staged.text ?? stripHtmlToText(staged.html ?? "")}`);
  const links = extractLinks(staged.text ?? "", staged.html);
  const preview = buildPreview(staged.text, staged.html);
  const auth = toStoredAuth(
    assessAuth({ authResults: staged.authResults, headerFrom: staged.from, envelopeFrom: job.envelopeFrom }),
  );

  const insert: InsertMessageInput = {
    domainId: job.domainId,
    aliasId: job.aliasId,
    providerMessageId: staged.messageId,
    // The reply chain decides which conversation this belongs to; a message that quotes
    // nothing we have never seen starts its own.
    threadRootId: await findThreadRoot(db, [staged.inReplyTo, ...staged.references]),
    inReplyTo: staged.inReplyTo,
    references: staged.references,
    replyTo: staged.replyTo,
    cc: staged.cc,
    listUnsubscribe: staged.listUnsubscribe ? staged.listUnsubscribe.slice(0, 600) : null,
    oneClickUnsubscribe: staged.oneClickUnsubscribe,
    dedupeKey: job.dedupeKey,
    envelopeFrom: job.envelopeFrom,
    envelopeTo: job.envelopeTo,
    headerFrom: staged.from,
    headerTo: staged.to,
    subject: staged.subject ? staged.subject.slice(0, 500) : null,
    preview,
    receivedAt: staged.date,
    rawSize: staged.rawSize,
    rawR2Key: job.rawKey,
    parsedR2Key: job.parsedKey,
    hasAttachments: staged.attachments.length > 0,
    attachmentCount: staged.attachments.length,
    codes,
    links,
    authVerdict: auth.verdict,
    auth,
  };

  // One batch: the message, its attachment rows and its search entry land together, so a
  // crash between them can no longer leave a stored message that search cannot find.
  const insertedId = await insertMessageWithDependents(
    db,
    insert,
    staged.attachments,
    { subject: staged.subject, preview, sender: staged.from },
  );
  if (insertedId === null) {
    // Lost a dedupe race with a concurrent delivery of the same event; the objects we
    // staged for our own (never written) message id are ours to remove.
    await deleteKeys(bucket, [job.rawKey, job.parsedKey, ...staged.attachments.map((a) => a.r2Key)]);
    log.info("mail_duplicate_race", { aliasId: job.aliasId });
    return { status: "duplicate" };
  }

  // Rules run after the row exists: filing mail is organisation, and a rule that throws
  // must never cost the owner a message that already arrived.
  let filed: AppliedRules = NO_RULES;
  try {
    const rules = await listEnabledRules(db);
    if (rules.length > 0) {
      filed = applyRules(rules, {
        senderDomain: senderDomainOf(job.envelopeFrom),
        subject: staged.subject,
        aliasId: job.aliasId,
        domainId: job.domainId,
        hasCode: codes.length > 0,
        hasAttachment: staged.attachments.length > 0,
      });
      if (filed.ruleId) {
        await fileByRule(db, insertedId, filed);
        await recordRuleHits(db, filed.ruleIds);
      }
    }
  } catch (err) {
    log.warn("rule_application_failed", { messageId: insertedId, error: err instanceof Error ? err.message : "error" });
    filed = NO_RULES;
  }

  log.info("mail_stored", {
    aliasId: job.aliasId,
    domainId: job.domainId,
    messageId: insertedId,
    codes: codes.length,
    links: links.length,
    attachments: staged.attachments.length,
    degraded: staged.degraded,
    auth: auth.verdict,
    rule: filed.ruleId,
  });
  return { status: "stored", messageId: insertedId, verdict: auth.verdict };
}

/**
 * The two halves composed. Production runs them in separate invocations — stage in the
 * email handler, commit in the queue consumer — and this is the same code either way, so
 * a test that calls it exercises the real path rather than a parallel one.
 */
export async function ingestEmail(
  message: Rejectable,
  env: Env,
  db: D1Database,
  bucket: R2Bucket,
): Promise<IngestResult> {
  const staged = await stageEmail(message, env, db, bucket);
  if (staged.status !== "staged") return staged.result;
  return commitIngest(staged.job, db, bucket);
}
