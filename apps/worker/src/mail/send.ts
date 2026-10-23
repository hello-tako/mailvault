import {
  AuthVerdict,
  MessageDirection,
  SEND_LIMITS,
  SendingStatus,
  SendStatus,
  type ComposeAttachment,
  type SendOutcome,
} from "@mailvault/shared";
import type { Env } from "../env";
import { maxSendsPerDay } from "../env";
import { badRequest } from "../lib/errors";
import { sanitizeFilename } from "../lib/filename";
import { log } from "../lib/logging";
import { newId, sha256Hex } from "../lib/util";
import { writeMetric } from "../lib/metrics";
import { findActiveAliasByAddress } from "../db/aliases";
import { getDomainById } from "../db/domains";
import {
  findThreadRoot,
  getMessageRow,
  indexMessage,
  insertAttachments,
  insertMessage,
} from "../db/messages";
import type { InsertAttachmentInput, InsertMessageInput } from "../db/messages";
import {
  beginOutboundR2Write,
  beginDispatch,
  cancelOutboundStaging,
  completeOutboundStaging,
  finishOutbound,
  releaseOutbound,
  registerOutboundStaging,
  reserveOutbound,
  settleOutboundR2Writes,
  type OutboundJob,
} from "../db/outbound";
import { failAllRecipients, recordRecipients } from "../db/recipients";
import type { MessageRow } from "../db/rows";
import {
  buildAttachmentKey,
  buildParsedKey,
  buildRawKey,
  putAttachment,
  putParsed,
  putRaw,
} from "../storage/r2";
import { addressesOf, normalizeLookupAddress, splitAddress } from "./normalize";
import { buildPreview } from "./preview";
import { buildOutboundMime } from "./mime";

/** The compose request as the caller stated it, before anything is looked up. */
export interface OutboundRequest {
  idempotencyKey?: string;
  fromAddress: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  fromName?: string;
  replyTo?: string;
  /** Mail id being answered. Drives In-Reply-To/References and the thread it joins. */
  replyToMessageId?: string;
  /** Files as the compose screen read them: base64, with the name the owner's file had. */
  attachments?: ComposeAttachment[];
}

export type SendResult =
  { ok: true; outcome: SendOutcome } | { ok: false; code: string; message: string };

/**
 * The payload goes to the binding as the runtime's own `EmailMessageBuilder`, not as a local
 * lookalike. That is what makes `from: { name, email }`, `cc`, `bcc`, `replyTo` and `headers`
 * checked against the contract Cloudflare documents rather than against a paraphrase of it —
 * an earlier version of this file carried a hand-written interface and a cast, because the
 * installed types described only the raw-MIME form of `send()`.
 */
export function sendIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw badRequest(
      "A stable Idempotency-Key header (16–128 safe characters) is required for sending.",
    );
  }
  return value;
}

async function dispatch(email: SendEmail, request: EmailMessageBuilder): Promise<EmailSendResult> {
  return email.send(request);
}

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The request carries a file as base64; the vault keeps what that decodes to. */
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Why a send was refused, before any of it is written down. */
type SendFailure = { code: string; message: string };

/** One file, ready to go out and ready to be kept. */
interface PreparedFile {
  /** The caller's entry, kept whole so the record knows the name the file actually had. */
  input: ComposeAttachment;
  /**
   * The name written into the MIME headers and into the R2 key. `lib/filename`'s safest form,
   * because a name is the one part of a file the sender picks and a header is where a chosen
   * string can start writing lines of its own.
   */
  safeName: string;
  bytes: Uint8Array;
}

/**
 * Read the files a compose carries, refusing the ones that cannot be sent.
 *
 * Only readability is judged here. Size is judged on the assembled message further down, which
 * is the only measurement that means anything: base64 adds a third to every file, and the
 * ceiling counts the bodies and the headers as well.
 */
function prepareFiles(
  list: ComposeAttachment[] | undefined,
): { ok: true; files: PreparedFile[] } | { ok: false; refusal: SendFailure } {
  if ((list?.length ?? 0) > SEND_LIMITS.maxAttachments) {
    return {
      ok: false,
      refusal: {
        code: "TOO_MANY_ATTACHMENTS",
        message: `At most ${SEND_LIMITS.maxAttachments} files per message.`,
      },
    };
  }
  // The same rule as the assembled measurement below, taken on the cheapest number available:
  // files that cannot fit even before the text is added are refused here, so a request built to
  // be impossible never pays for decoding itself.
  if ((list ?? []).reduce((n, a) => n + a.content.length, 0) > SEND_LIMITS.maxTotalBase64Chars) {
    return {
      ok: false,
      refusal: { code: "TOO_LARGE", message: "Those files are more than one message can hold." },
    };
  }
  const files: PreparedFile[] = [];
  for (const a of list ?? []) {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(a.content);
    } catch {
      return {
        ok: false,
        refusal: {
          code: "BAD_ATTACHMENT",
          message: `${a.filename} did not arrive as readable file content.`,
        },
      };
    }
    files.push({ input: a, safeName: sanitizeFilename(a.filename), bytes });
  }
  return { ok: true, files };
}

/** Normalise, drop duplicates across to/cc/bcc, and reject anything not an address. */
function cleanList(
  list: string[] | undefined,
  seen: Set<string>,
): { ok: true; addresses: string[] } | { ok: false; bad: string } {
  const addresses: string[] = [];
  for (const raw of list ?? []) {
    const normalized = normalizeLookupAddress(raw);
    if (!normalized || !splitAddress(normalized).valid) return { ok: false, bad: raw };
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(normalized);
  }
  return { ok: true, addresses };
}

/**
 * Send one message as one of the owner's aliases.
 *
 * Three things hold this together. The `From` may only be an ACTIVE alias that already
 * exists in this mailbox — an address nobody created cannot send, which is what keeps this
 * endpoint from being an open relay. The message is written down *before* it goes, so a send
 * that succeeds while D1 is unhappy cannot produce mail the owner sent and never sees again.
 * And the domain must have Email Sending enabled, because Cloudflare refuses to sign for a
 * `From` it has not been told about.
 */
export async function sendOutbound(
  req: OutboundRequest,
  env: Env,
  db: D1Database,
  bucket: R2Bucket,
): Promise<SendResult> {
  const from = normalizeLookupAddress(req.fromAddress);
  if (!from || !splitAddress(from).valid)
    return fail("BAD_ADDRESS", "The sender address is not valid.");

  const alias = await findActiveAliasByAddress(db, from);
  if (!alias) {
    return fail(
      "UNKNOWN_SENDER",
      `${from} is not one of your active aliases. Create it before sending from it.`,
    );
  }

  const domain = await getDomainById(db, alias.domainId);
  if (!domain) return fail("UNKNOWN_SENDER", "That alias has no domain.");
  if (domain.sendingStatus !== SendingStatus.Enabled) {
    return fail(
      "SENDING_DISABLED",
      `${domain.name} is not enabled for sending yet. Enable Email Sending for that domain first.`,
    );
  }

  // The alias authorises the send; the *sending name* is what Cloudflare signed for. When the
  // domain sends through one of its zone's subdomains, the local part carries over unchanged —
  // it came from the owner's own alias row, so there is nothing here for a request to choose —
  // and the answer is pointed back at the address that actually receives.
  const via = domain.sendingVia;
  const sendingAddress = via ? `${splitAddress(from).local}@${via}` : from;
  const replyTo = req.replyTo ?? (via ? from : undefined);

  const seen = new Set<string>();
  const lists: { to: string[]; cc: string[]; bcc: string[] } = { to: [], cc: [], bcc: [] };
  for (const key of ["to", "cc", "bcc"] as const) {
    const cleaned = cleanList(req[key], seen);
    if (!cleaned.ok) return fail("BAD_ADDRESS", `${cleaned.bad} is not a valid address.`);
    lists[key] = cleaned.addresses;
  }
  if (lists.to.length === 0)
    return fail("NO_RECIPIENTS", "A message needs at least one recipient in To.");
  const recipientCount = lists.to.length + lists.cc.length + lists.bcc.length;
  if (recipientCount > SEND_LIMITS.maxRecipients) {
    return fail(
      "TOO_MANY_RECIPIENTS",
      `At most ${SEND_LIMITS.maxRecipients} recipients per message, counting to, cc and bcc.`,
    );
  }

  const parent = req.replyToMessageId ? await getMessageRow(db, req.replyToMessageId) : null;
  if (req.replyToMessageId && !parent)
    return fail("NOT_FOUND", "The message being answered no longer exists.");
  if (parent && isUntrustedIncoming(parent)) {
    return fail(
      parent.auth_verdict === AuthVerdict.Spoofed ? "SPOOFED_PARENT" : "UNVERIFIED_PARENT",
      parent.auth_verdict === AuthVerdict.Spoofed
        ? "That message failed sender authentication, so answering it would write to an impostor."
        : "That sender is not authenticated, so answering could write to an impostor.",
    );
  }

  const baseSubject = (req.subject || parent?.subject || "").slice(0, SEND_LIMITS.maxSubjectChars);
  const subject =
    parent && baseSubject && !/^re:/i.test(baseSubject) ? `Re: ${baseSubject}` : baseSubject;
  if (!req.text.trim() && !req.html?.trim()) return fail("EMPTY_BODY", "Write something first.");

  const prepared = prepareFiles(req.attachments);
  if (!prepared.ok) return fail(prepared.refusal.code, prepared.refusal.message);
  const files = prepared.files;

  const inReplyTo = parent?.provider_message_id ?? null;
  const references = [
    ...readReferences(parent?.references_json),
    ...(inReplyTo ? [inReplyTo] : []),
  ];
  const key = await sha256Hex(req.idempotencyKey ?? newId());
  const hash = await sha256Hex(
    JSON.stringify({
      from,
      sendingAddress,
      lists,
      subject,
      text: req.text,
      html: req.html ?? null,
      fromName: req.fromName ?? null,
      replyTo: replyTo ?? null,
      parent: req.replyToMessageId ?? null,
      attachments: req.attachments ?? [],
    }),
  );
  const { job, lease } = await reserveOutbound(db, key, hash, maxSendsPerDay(env));
  if (!job) return fail("DAILY_LIMIT", "The daily send budget is exhausted.");
  if (job.request_hash !== hash)
    return fail("IDEMPOTENCY_CONFLICT", "That send key was already used for different content.");
  if (job.state !== "STAGING") return replayOutbound(db, job, lists);
  if (!lease)
    return fail("SEND_IN_PROGRESS", "That send is still being prepared. Retry with the same key.");
  const messageId = job.message_id;
  const sentAt = job.created_at;
  try {
    const preview = buildPreview(req.text, req.html ?? null);
    const rawKey = buildRawKey(domain.id, alias.id, sentAt, messageId);
    const parsedKey = buildParsedKey(messageId);

    // Written down before it goes, and measured here rather than guessed at: the only size that
    // decides whether Cloudflare accepts this message is the whole of it — headers, both bodies,
    // and every file with base64's third added on top.
    const rawBytes = new TextEncoder().encode(
      buildOutboundMime({
        from: sendingAddress,
        fromName: req.fromName,
        to: lists.to,
        cc: lists.cc,
        bcc: lists.bcc,
        replyTo,
        subject,
        text: req.text,
        html: req.html,
        // Our own id: Email Sending assigns the final Message-ID on the wire, so this is
        // the composed record rather than a transcript of the bytes that left.
        messageId: `${messageId}@${via ?? domain.name}`,
        date: new Date(sentAt),
        inReplyTo,
        references,
        attachments: files.map((f) => ({
          filename: f.safeName,
          contentType: f.input.type,
          contentBase64: f.input.content,
        })),
      }),
    );
    if (rawBytes.byteLength > SEND_LIMITS.maxTotalBytes) {
      await finishOutbound(db, key, "FAILED", null, "TOO_LARGE");
      return fail(
        "TOO_LARGE",
        `This message would be ${megabytes(rawBytes.byteLength)}, and one message may be at most ${megabytes(SEND_LIMITS.maxTotalBytes)} counting its files.`,
      );
    }

    const threadRoot =
      (await findThreadRoot(db, [inReplyTo, ...references])) ??
      parent?.thread_root_id ??
      parent?.id ??
      null;

    const attachmentRows: InsertAttachmentInput[] = files.map((f, index) => {
      const attachmentId = `${messageId}-attachment-${index}`;
      const key = buildAttachmentKey(messageId, attachmentId, f.safeName);
      return {
        id: attachmentId,
        filename: f.input.filename,
        safeFilename: f.safeName,
        contentType: f.input.type,
        size: f.bytes.byteLength,
        r2Key: key,
        contentId: null,
      };
    });
    const stagedKeys = [rawKey, ...attachmentRows.map((row) => row.r2Key), parsedKey];
    if (!(await registerOutboundStaging(db, key, lease, alias.id, stagedKeys))) {
      await cancelOutboundStaging(db, key, lease);
      return fail("SEND_DELETED", "This send or its alias was deleted before staging began.");
    }
    if (!(await beginOutboundR2Write(db, key, lease))) {
      await cancelOutboundStaging(db, key, lease);
      await releaseOutbound(db, key, lease);
      return fail("SEND_DELETED", "This send or its alias was deleted before staging began.");
    }

    await putRaw(bucket, rawKey, rawBytes);
    for (const [index, f] of files.entries()) {
      await putAttachment(bucket, attachmentRows[index]!.r2Key, f.bytes, f.input.type);
    }
    await putParsed(bucket, parsedKey, { text: req.text, html: req.html ?? null, degraded: false });
    if (!(await settleOutboundR2Writes(db, key, lease)))
      throw new Error("Outbound staging ownership was lost during R2 writes");

    const insertedId = await insertMessage(db, {
      id: messageId,
      domainId: domain.id,
      aliasId: alias.id,
      providerMessageId: null,
      dedupeKey: `out|${messageId}`,
      envelopeFrom: sendingAddress,
      envelopeTo: [...lists.to, ...lists.cc, ...lists.bcc].join(", "),
      headerFrom: req.fromName ? `${req.fromName} <${sendingAddress}>` : sendingAddress,
      headerTo: [...lists.to, ...lists.cc].join(", "),
      subject: subject.slice(0, 500),
      preview,
      receivedAt: sentAt,
      rawSize: rawBytes.byteLength,
      rawR2Key: rawKey,
      parsedR2Key: parsedKey,
      hasAttachments: attachmentRows.length > 0,
      attachmentCount: attachmentRows.length,
      codes: [],
      links: [],
      // Our own mail is authenticated by definition: Email Sending signs it with this
      // domain's DKIM key and asserts this domain in SPF.
      authVerdict: AuthVerdict.Trusted,
      auth: null,
      direction: MessageDirection.Out,
      // Null means "this message is the conversation" and lets the insert use the row's own
      // id — the local id here names the R2 objects, not the row.
      threadRootId: threadRoot,
      inReplyTo,
      references,
      replyTo: replyTo ?? null,
      cc: lists.cc.length > 0 ? lists.cc.join(", ") : null,
      sendStatus: SendStatus.Preparing,
      sendError: null,
    } satisfies InsertMessageInput);

    const storedId = insertedId ?? messageId;
    if (!insertedId) {
      const existing = await getMessageRow(db, messageId);
      if (!existing || existing.raw_r2_key !== rawKey || existing.parsed_r2_key !== parsedKey) {
        throw badRequest("Outbound staging ownership mismatch");
      }
    }
    // The bytes were already put; these rows are what makes them reachable again, through the
    // same authenticated download route that serves received attachments.
    await insertAttachments(db, storedId, attachmentRows);
    if (!(await completeOutboundStaging(db, key, lease)))
      throw new Error("Outbound staging manifest could not be completed");
    await indexMessage(db, storedId, {
      subject,
      preview,
      // Sent mail is found by who it went to, since there is no external sender to match.
      sender: [...lists.to, ...lists.cc].join(", "),
    });
    // Every destination starts as `queued` here rather than appearing only when it reports
    // back, so a message whose recipients never answer still shows who it was addressed to.
    await recordRecipients(db, storedId, lists);

    let response: { messageId: string } | { error: Error };
    const extraHeaders = replyHeaders(inReplyTo, references);
    // The safe name again rather than the owner's original: this is the copy that reaches another
    // provider's parser, and the content is handed over exactly as it arrived, already base64.
    const wireAttachments: EmailAttachment[] = files.map((f) => ({
      disposition: "attachment",
      filename: f.safeName,
      type: f.input.type,
      content: f.input.content,
    }));
    // Last, after every policy has been checked: "this server cannot send" must never be the
    // reason given for a message that was refused because it should not have been sent at all.
    if (!env.EMAIL) {
      await finishOutbound(db, key, "FAILED", null, "BINDING_MISSING");
      await setSendResult(
        db,
        storedId,
        null,
        SendStatus.Failed,
        "BINDING_MISSING: no send_email binding on this deployment",
      );
      return fail(
        "BINDING_MISSING",
        "This server has no sending configured, so mail cannot leave the vault.",
      );
    }
    await beginDispatch(db, key, lease, storedId);
    try {
      response = await dispatch(env.EMAIL, {
        from: req.fromName ? { email: sendingAddress, name: req.fromName } : sendingAddress,
        to: lists.to,
        subject,
        text: req.text,
        ...(req.html ? { html: req.html } : {}),
        ...(lists.cc.length > 0 ? { cc: lists.cc } : {}),
        ...(lists.bcc.length > 0 ? { bcc: lists.bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
        ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
      });
    } catch (err) {
      response = { error: err instanceof Error ? err : new Error(String(err)) };
    }

    if ("error" in response) {
      const code = (response.error as Error & { code?: string }).code;
      // Only a documented explicit refusal proves non-acceptance; network errors do not.
      if (code !== "E_RECIPIENT_SUPPRESSED") {
        log.warn("mail_send_acceptance_unknown", { messageId: storedId });
        return unknownOutcome(storedId);
      }
      await finishOutbound(db, key, "FAILED", null, code);
      await setSendResult(db, storedId, null, SendStatus.Suppressed, code);
      writeMetric(env, "sending", { outcome: "failed", reason: code });
      log.warn("mail_send_refused", { messageId: storedId });
      return fail(code, "Cloudflare refused a suppressed recipient.");
    }

    // The binding resolves once Email Sending has accepted the message. What the recipient's
    // server then did is a separate fact, and it arrives later as a delivery event — see
    // `mail/delivery.ts`, which is what moves this row off `queued`.
    await finishOutbound(db, key, "ACCEPTED", response.messageId.replace(/^<|>$/g, ""), null);
    await setSendResult(db, storedId, response.messageId, SendStatus.Queued, null);
    writeMetric(env, "sending", { outcome: "accepted" });
    log.info("mail_sent", { messageId: storedId, recipients: recipientCount });
    return {
      ok: true,
      outcome: {
        id: storedId,
        status: SendStatus.Queued,
        providerMessageId: response.messageId,
        delivered: [],
        queued: [...lists.to, ...lists.cc, ...lists.bcc],
        bounced: [],
        suppressed: [],
        error: null,
      },
    };
  } catch (error) {
    await releaseOutbound(db, key, lease);
    throw error;
  }
}

function unknownOutcome(id: string): SendResult {
  return {
    ok: true,
    outcome: {
      id,
      status: SendStatus.Unknown,
      providerMessageId: null,
      delivered: [],
      queued: [],
      bounced: [],
      suppressed: [],
      error: "Provider acceptance is unknown. Do not resend; operator reconciliation is required.",
    },
  };
}

async function replayOutbound(
  db: D1Database,
  job: OutboundJob,
  lists: { to: string[]; cc: string[]; bcc: string[] },
): Promise<SendResult> {
  if (job.state === "DELETED")
    return fail("SEND_DELETED", "This send was deleted and cannot be replayed.");
  if (job.state === "DISPATCHING") return unknownOutcome(job.message_id);
  if (job.state === "FAILED")
    return fail(
      job.error_code ?? "SEND_FAILED",
      "This send was refused. It will not be redispatched.",
    );
  const existing = await getMessageRow(db, job.message_id);
  if (!existing) return fail("SEND_DELETED", "This send no longer exists and cannot be recreated.");
  // Reconcile a receipt failure without moving later delivery events backwards.
  await db
    .prepare(
      `UPDATE messages SET provider_message_id=COALESCE(provider_message_id,?2),
    send_status=CASE WHEN send_status IN ('UNKNOWN','PREPARING') THEN 'QUEUED' ELSE send_status END,
    send_error=CASE WHEN send_status IN ('UNKNOWN','PREPARING') THEN NULL ELSE send_error END WHERE id=?1`,
    )
    .bind(job.message_id, job.provider_message_id)
    .run();
  return {
    ok: true,
    outcome: {
      id: job.message_id,
      status: SendStatus.Queued,
      providerMessageId: job.provider_message_id,
      delivered: [],
      queued: [...lists.to, ...lists.cc, ...lists.bcc],
      bounced: [],
      suppressed: [],
      error: null,
    },
  };
}

function isUntrustedIncoming(row: MessageRow): boolean {
  return row.direction === MessageDirection.In && row.auth_verdict !== AuthVerdict.Trusted;
}

function readReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function replyHeaders(inReplyTo: string | null, references: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
  if (references.length > 0) headers["References"] = references.map((r) => `<${r}>`).join(" ");
  return headers;
}

/**
 * The provider's id is stored bare — `a@b`, not `<a@b>` — because that is the shape received
 * mail records, and threading resolves a reply by matching the two. Anything that made them
 * differ would leave every answered thread silently split in two.
 */
async function setSendResult(
  db: D1Database,
  id: string,
  rawProviderMessageId: string | null,
  status: SendStatus,
  error: string | null,
): Promise<void> {
  const providerMessageId = rawProviderMessageId?.replace(/^<|>$/g, "") ?? null;
  await db
    .prepare(
      `UPDATE messages SET provider_message_id = ?2, send_status = ?3, send_error = ?4 WHERE id = ?1`,
    )
    .bind(id, providerMessageId, status, error)
    .run();
  // A send the transport refused never produces a delivery event, so this is the only place
  // that can say so. Without it the destinations would sit at `queued` forever on a message
  // that is plainly marked as failed.
  if (error && (status === SendStatus.Failed || status === SendStatus.Suppressed)) {
    await failAllRecipients(db, id, status, error);
  }
}

function fail(code: string, message: string): SendResult {
  return { ok: false, code, message };
}

/**
 * Answer one stored message.
 *
 * Both ends come from the row rather than the request: the sender is the alias the message
 * arrived on (or was sent from), and the recipient is whoever the message itself named —
 * `Reply-To` first, because that is the address its author asked for answers, then `From`.
 * Taking either from the client would let a crafted row aim a reply at somebody who never
 * appears in the conversation. Files are the exception, and the harmless one: a reply carries
 * whatever the owner attaches to it, under the same size and count rules as a new compose.
 */
export async function sendReply(
  parentId: string,
  req: {
    idempotencyKey?: string;
    text: string;
    html?: string;
    subject?: string;
    fromName?: string;
    cc?: string[];
    attachments?: ComposeAttachment[];
  },
  env: Env,
  db: D1Database,
  bucket: R2Bucket,
): Promise<SendResult> {
  const parent = await getMessageRow(db, parentId);
  if (!parent) return fail("NOT_FOUND", "That message is gone.");

  const from = parent.alias_address ?? "";
  if (!from) {
    return fail(
      "NO_ALIAS",
      "This mail has no alias of its own any more, so there is no address to answer from. Send a new message instead.",
    );
  }

  const ourAlias = normalizeLookupAddress(from);
  const candidates =
    parent.direction === MessageDirection.Out
      ? addressesOf(parent.header_to)
      : addressesOf(parent.reply_to ?? parent.header_from ?? parent.header_to);
  const to = candidates.filter((a) => a !== ourAlias);
  if (to.length === 0) {
    return fail(
      "NO_TARGET",
      "There is nobody to answer on this message — its sender address is unusable.",
    );
  }

  return sendOutbound(
    {
      idempotencyKey: req.idempotencyKey,
      fromAddress: from,
      to,
      cc: req.cc,
      subject: (req.subject ?? parent.subject ?? "").slice(0, SEND_LIMITS.maxSubjectChars),
      text: req.text,
      html: req.html,
      fromName: req.fromName,
      replyToMessageId: parentId,
      attachments: req.attachments,
    },
    env,
    db,
    bucket,
  );
}
