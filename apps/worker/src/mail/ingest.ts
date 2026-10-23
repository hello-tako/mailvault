import type { Env } from "../env";
import { maxMessageBytes } from "../env";
import { sha256Hex, newId, nowIso } from "../lib/util";
import { sanitizeFilename } from "../lib/filename";
import { log } from "../lib/logging";
import { findActiveAliasByAddress } from "../db/aliases";
import { getDomainById } from "../db/domains";
import { isMessageDeletionTombstoned } from "../db/deletions";
import { listEnabledRules } from "../db/rules";
import { applyRules, NO_RULES, type AppliedRules } from "./rules";
import { insertMessage, findThreadRoot } from "../db/messages";
import type { InsertMessageInput, InsertAttachmentInput } from "../db/messages";
import {
  completeIngest,
  markInboundStagingCommitted,
  commitIngestRules,
  findIngestByDedupeKey,
  findIngestById,
  isIngestDeletionBlocked,
  ingestCoreComplete,
  reconcileIngestCore,
  beginInboundStaging,
  isInboundStagingWritable,
  finishInboundStaging,
  abandonInboundStaging,
  discardInboundStaging,
  unreferencedIngestKeys,
} from "../db/ingest";
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
import { assessAuth, type VerifiedAuthEvidence } from "./auth";
import { verifyDkim, type TxtResolver } from "./dkim";
import { AuthPolicy, AuthVerdict, type MessageAuth } from "@mailvault/shared";
import { extractOtp } from "./otp";
import { extractLinks } from "./links";
import { buildPreview, stripHtmlToText } from "./preview";
import { normalizeLookupAddress, splitAddress } from "./normalize";
import { indexIfEnabled, semanticEnabled } from "../lib/semantic";

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

/** DKIM key lookups. Omitted in production, where the Worker's node:dns resolver is used. */
export interface IngestOptions {
  resolveTxt?: TxtResolver;
}

const INBOUND_STAGING_LEASE_MS = 5 * 60 * 1000;

class InboundStagingFenced extends Error {
  constructor() {
    super("inbound_staging_fenced");
  }
}

async function deletedIngestDuplicate(job: IngestJob, env?: Env): Promise<IngestResult> {
  if (env?.VECTORIZE) await env.VECTORIZE.deleteByIds([job.messageId]);
  log.info("mail_delete_tombstone_duplicate", { messageId: job.messageId });
  return { status: "duplicate" };
}

/** The staged record: everything the commit needs, read back from R2 by key. */
interface StagedParse {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  receivedAt: string;
  headerDate: string | null;
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
  /** Verifier output, judged once at staging. Absent on records staged before DKIM was wired in. */
  verifiedAuthEvidence?: VerifiedAuthEvidence[];
}

async function ingestRecordCoreComplete(
  record: NonNullable<Awaited<ReturnType<typeof findIngestById>>>,
  db: D1Database,
  bucket: R2Bucket,
): Promise<boolean> {
  const [raw, parsedObject] = await Promise.all([
    bucket.head(record.rawKey),
    getObject(bucket, record.parsedKey),
  ]);
  if (!raw || !parsedObject) return false;
  let staged: StagedParse;
  try {
    staged = await parsedObject.json<StagedParse>();
  } catch {
    return false;
  }
  if (
    !Array.isArray(staged.attachments) ||
    staged.attachments.some((attachment) => !attachment.id)
  ) {
    return false;
  }
  for (const attachment of staged.attachments) {
    if (!(await bucket.head(attachment.r2Key))) return false;
  }
  return ingestCoreComplete(db, record, staged.attachments);
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
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array | null> {
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

/**
 * Bounded for D1 storage; the verdict is computed from the full evidence, not this copy. Verifier
 * results come first, so the bound cannot hide the evidence the verdict rests on.
 */
function toStoredAuth(a: ReturnType<typeof assessAuth>): MessageAuth {
  const evidence = [
    ...a.evidence.filter((item) => item.source !== "message-header"),
    ...a.evidence.filter((item) => item.source === "message-header"),
  ];
  return { ...a, reasons: a.reasons.map((r) => r.slice(0, 120)), evidence: evidence.slice(0, 8) };
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
  options: IngestOptions = {},
): Promise<StageResult> {
  const receivedAt = nowIso();
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
  if (await isMessageDeletionTombstoned(db, dedupeKey)) {
    log.info("mail_delete_tombstone_duplicate", { aliasId: alias.id });
    return { status: "duplicate", result: { status: "duplicate" } };
  }
  const existing = await findIngestByDedupeKey(db, dedupeKey);
  if (existing) {
    if (existing.status === "COMMITTED" && (await ingestRecordCoreComplete(existing, db, bucket))) {
      log.info("mail_duplicate", { aliasId: alias.id });
      return { status: "duplicate", result: { status: "duplicate" } };
    }
    return {
      status: "staged",
      keys: [],
      job: {
        v: 1,
        messageId: existing.id,
        dedupeKey: existing.dedupeKey,
        domainId: existing.domainId,
        aliasId: existing.aliasId,
        rawKey: existing.rawKey,
        parsedKey: existing.parsedKey,
        envelopeFrom: existing.envelopeFrom,
        envelopeTo: existing.envelopeTo,
      },
    };
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
  let headerDate: string | null = null;
  let parsedAttachments: {
    filename: string;
    contentType: string;
    contentId: string | null;
    bytes: Uint8Array;
  }[] = [];
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
    if (parsed.date) {
      const parsedDate = new Date(parsed.date);
      if (!Number.isNaN(parsedDate.getTime())) headerDate = parsedDate.toISOString();
    }
    parsedAttachments = parsed.attachments;
    authResults = parsed.authResults;
  } catch (err) {
    degraded = true;
    log.warn("mail_parse_failed", {
      aliasId: alias.id,
      error: err instanceof Error ? err.message : "parse_error",
    });
    headerTo = message.to;
  }

  // Judged before anything is stored: a spoofed message must never reach the owner
  // looking like a verified one, and its "code"/"verify link" are what a phisher forges.
  const verifiedAuthEvidence = await verifyDkim(bytes, { resolveTxt: options.resolveTxt });
  const auth = assessAuth({
    authResults,
    headerFrom,
    envelopeFrom: message.from,
    verifiedEvidence: verifiedAuthEvidence,
  });
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

  const attachmentRows: InsertAttachmentInput[] = parsedAttachments.map((attachment) => {
    const id = newId();
    const safeFilename = sanitizeFilename(attachment.filename);
    return {
      id,
      filename: attachment.filename,
      safeFilename,
      contentType: attachment.contentType,
      size: attachment.bytes.byteLength,
      r2Key: buildAttachmentKey(messageId, id, safeFilename),
      contentId: attachment.contentId,
    };
  });
  const writtenKeys = [rawKey, parsedKey, ...attachmentRows.map(({ r2Key }) => r2Key)];
  const job: IngestJob = {
    v: 1,
    messageId,
    dedupeKey,
    domainId: alias.domainId,
    aliasId: alias.id,
    rawKey,
    parsedKey,
    envelopeFrom: message.from,
    envelopeTo: message.to,
  };
  const leaseToken = newId();
  const manifestStarted = await beginInboundStaging(db, {
    messageId,
    dedupeKey,
    aliasId: alias.id,
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + INBOUND_STAGING_LEASE_MS).toISOString(),
    objectKeys: writtenKeys,
  });
  if (!manifestStarted) return { status: "duplicate", result: { status: "duplicate" } };

  const assertWritable = async () => {
    if (!(await isInboundStagingWritable(db, messageId, leaseToken))) {
      throw new InboundStagingFenced();
    }
  };
  try {
    await assertWritable();
    await putRaw(bucket, rawKey, bytes);
    await assertWritable();
    for (let i = 0; i < parsedAttachments.length; i += 1) {
      await assertWritable();
      const source = parsedAttachments[i]!;
      const key = attachmentRows[i]!.r2Key;
      await putAttachment(bucket, key, source.bytes, source.contentType);
      await assertWritable();
    }
    // The staged object is what the commit reads back, so it holds everything the
    // metadata row needs — including the headers the verdict was judged from.
    const staged: StagedParse = {
      subject,
      from: headerFrom,
      to: headerTo,
      cc: headerCc,
      receivedAt,
      headerDate,
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
      verifiedAuthEvidence,
    };
    await putParsed(bucket, parsedKey, staged);
    if (!(await finishInboundStaging(db, messageId, leaseToken))) {
      throw new InboundStagingFenced();
    }
  } catch (err) {
    if (err instanceof InboundStagingFenced) {
      await finishInboundStaging(db, messageId, leaseToken).catch(() => false);
    } else {
      await abandonInboundStaging(db, messageId, leaseToken).catch(() => {});
    }
    await deleteKeys(bucket, writtenKeys);
    if (err instanceof InboundStagingFenced) {
      log.info("mail_stage_fenced", { aliasId: alias.id });
      return { status: "duplicate", result: { status: "duplicate" } };
    }
    log.error("mail_stage_failed", {
      aliasId: alias.id,
      error: err instanceof Error ? err.message : "error",
    });
    throw err;
  }

  return {
    status: "staged",
    keys: writtenKeys,
    job,
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
export async function commitIngest(
  job: IngestJob,
  db: D1Database,
  bucket: R2Bucket,
  env?: Env,
): Promise<IngestResult> {
  if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId)) {
    return deletedIngestDuplicate(job, env);
  }
  let record = await findIngestById(db, job.messageId);
  if (record?.deletionPending) return deletedIngestDuplicate(job, env);
  const obj = await getObject(bucket, job.parsedKey);
  if (!obj) {
    log.error("mail_commit_missing", { messageId: job.messageId, aliasId: job.aliasId });
    throw new Error("staged_parse_missing");
  }
  const staged = await obj.json<StagedParse>();
  if (!(await bucket.head(job.rawKey))) throw new Error("staged_raw_missing");
  for (const attachment of staged.attachments) {
    if (!(await bucket.head(attachment.r2Key))) throw new Error("staged_attachment_missing");
  }

  const codes = extractOtp(
    `${staged.subject ?? ""}\n${staged.text ?? stripHtmlToText(staged.html ?? "")}`,
  );
  const links = extractLinks(staged.text ?? "", staged.html);
  const preview = buildPreview(staged.text, staged.html);
  const auth = toStoredAuth(
    assessAuth({
      authResults: staged.authResults,
      headerFrom: staged.from,
      envelopeFrom: job.envelopeFrom,
      // Staged before DKIM verification was wired in: nothing was verified, so nothing is trusted.
      verifiedEvidence: staged.verifiedAuthEvidence ?? [],
    }),
  );

  const insert: InsertMessageInput & { headerDate: string | null } = {
    id: job.messageId,
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
    receivedAt: staged.receivedAt,
    headerDate: staged.headerDate,
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

  if (record && record.dedupeKey !== job.dedupeKey) throw new Error("ingest_message_id_conflict");
  const wasCommitted = record?.status === "COMMITTED";
  if (wasCommitted && (await ingestCoreComplete(db, record!, staged.attachments))) {
    await markInboundStagingCommitted(db, job.messageId);
    return { status: "duplicate" };
  }
  if (!record) {
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
    let insertedId: string | null;
    try {
      insertedId = await insertMessage(db, insert);
    } catch (error) {
      if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
        return deletedIngestDuplicate(job, env);
      throw error;
    }
    record = await findIngestById(db, job.messageId);
    if (!record && insertedId === null) record = await findIngestByDedupeKey(db, job.dedupeKey);
  }
  if (!record) throw new Error("ingest_message_insert_incomplete");
  if (
    record.deletionPending ||
    (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
  ) {
    return deletedIngestDuplicate(job, env);
  }
  if (record.id !== job.messageId) {
    if (
      record.dedupeKey !== job.dedupeKey ||
      record.status !== "COMMITTED" ||
      !(await ingestRecordCoreComplete(record, db, bucket))
    ) {
      throw new Error("ingest_duplicate_in_progress");
    }
    const ownKeys = [
      job.rawKey,
      job.parsedKey,
      ...staged.attachments.map((attachment) => attachment.r2Key),
    ];
    const unreferenced = await unreferencedIngestKeys(db, ownKeys);
    await discardInboundStaging(db, job.messageId);
    await deleteKeys(bucket, unreferenced);
    log.info("mail_duplicate_race", { aliasId: job.aliasId });
    return { status: "duplicate" };
  }

  if (wasCommitted) {
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
    await reconcileIngestCore(db, job.messageId, staged.attachments, {
      subject: staged.subject,
      preview,
      sender: staged.from,
    });
    if (!(await ingestCoreComplete(db, record, staged.attachments))) {
      throw new Error("ingest_core_reconciliation_failed");
    }
    return { status: "stored", messageId: job.messageId, verdict: auth.verdict };
  }

  if (record.status !== "SEMANTIC_PENDING") {
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
    await reconcileIngestCore(db, job.messageId, staged.attachments, {
      subject: staged.subject,
      preview,
      sender: staged.from,
    });
    record = await findIngestById(db, job.messageId);
    if (!record) throw new Error("ingest_message_missing_after_core");
  }

  let filed: AppliedRules = NO_RULES;
  if (record.status === "RULES_PENDING") {
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
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
    }
    await commitIngestRules(db, job.messageId, filed);
    record = await findIngestById(db, job.messageId);
    if (!record) throw new Error("ingest_message_missing_after_rules");
    if (record.deletionPending) return deletedIngestDuplicate(job, env);
  }

  if (record.status === "SEMANTIC_PENDING") {
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
    const shouldIndex = Boolean(env && (await semanticEnabled(db)));
    if (
      shouldIndex &&
      (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
    ) {
      return deletedIngestDuplicate(job, env);
    }
    if (env && shouldIndex && !(await indexIfEnabled(env, job.messageId)))
      throw new Error("semantic_index_incomplete");
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
    await completeIngest(db, job.messageId);
    if (await isIngestDeletionBlocked(db, job.messageId, job.dedupeKey, job.aliasId))
      return deletedIngestDuplicate(job, env);
  }

  await markInboundStagingCommitted(db, job.messageId);
  log.info("mail_stored", {
    aliasId: job.aliasId,
    domainId: job.domainId,
    messageId: job.messageId,
    codes: codes.length,
    links: links.length,
    attachments: staged.attachments.length,
    degraded: staged.degraded,
    auth: auth.verdict,
    rule: filed.ruleId,
  });
  return { status: "stored", messageId: job.messageId, verdict: auth.verdict };
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
  options: IngestOptions = {},
): Promise<IngestResult> {
  const staged = await stageEmail(message, env, db, bucket, options);
  if (staged.status !== "staged") return staged.result;
  return commitIngest(staged.job, db, bucket, env);
}
