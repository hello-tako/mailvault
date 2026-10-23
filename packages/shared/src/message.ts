import { z } from "zod";
import { AuthVerdict, MessageDirection, SendStatus } from "./enums";

/**
 * Message DTOs. `extractedCodes` / `verificationLinks` are stored in D1 as JSON
 * blobs; these schemas are the canonical shape for both persistence and the API.
 */

export const ExtractedCodeSchema = z.object({
  /** The code as it appeared (e.g. "593821" or "AB12-CD"). */
  value: z.string(),
  kind: z.enum(["numeric", "alphanumeric"]),
  length: z.number().int().positive(),
  /** 0..1 ranking used to pick the strongest candidate for the UI. */
  confidence: z.number().min(0).max(1),
  /** Short surrounding text that produced the match, for debugging/context. */
  context: z.string().max(200).optional(),
});
export type ExtractedCode = z.infer<typeof ExtractedCodeSchema>;

export const VerificationLinkSchema = z.object({
  /** The address exactly as the message carried it — what "open as sent" uses. */
  url: z.string().url(),
  hostname: z.string(),
  /**
   * Where the link actually goes when a click-through wrapper (`/CL0/https:%2F%2F…`) was
   * standing in front of it. Absent when `url` is already the destination, so rows stored
   * before this existed keep parsing.
   */
  destination: z.string().url().optional(),
  /** Human label derived from nearby anchor text / context, e.g. "Verify account". */
  label: z.string().max(160).default(""),
  /** 0..1 ranking from contextual keywords. */
  score: z.number().min(0).max(1).default(0),
  context: z.string().max(200).optional(),
});
export type VerificationLink = z.infer<typeof VerificationLinkSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  contentId: z.string().nullable().optional(),
  /** Authenticated, same-origin download path served by the Worker. */
  downloadPath: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Where an evidence item came from. Only `cryptographic-verifier` is receiver-verified. */
export const AuthEvidenceSourceSchema = z.enum([
  "message-header",
  "cryptographic-verifier",
  "trusted-runtime-metadata",
]);

/** One authentication result with our alignment judgement. */
export const AuthEvidenceSchema = z.object({
  mechanism: z.enum(["spf", "dkim", "dmarc"]),
  outcome: z.string(),
  domain: z.string().nullable(),
  aligned: z.boolean(),
  /** Rows stored before provenance existed carry none: they are the sender's own header claim. */
  source: AuthEvidenceSourceSchema.default("message-header"),
  reporter: z.string().nullable(),
});
export type AuthEvidence = z.infer<typeof AuthEvidenceSchema>;

/**
 * Sender authentication assessed at delivery time. A `pass` only counts as trusted when
 * the vouched-for domain aligns with the header From — the header itself is attacker
 * reachable, so `alignedPass` is the field the UI must trust, never `spf`/`dkim`.
 */
export const MessageAuthSchema = z.object({
  verdict: z.nativeEnum(AuthVerdict),
  spf: z.string().nullable(),
  dkim: z.string().nullable(),
  dmarc: z.string().nullable(),
  alignedPass: z.object({ spf: z.boolean(), dkim: z.boolean(), dmarc: z.boolean() }),
  envelopeMismatch: z.boolean().default(false),
  observed: z.boolean().default(false),
  reasons: z.array(z.string().max(120)).default([]),
  evidence: z.array(AuthEvidenceSchema).max(8).default([]),
});
export type MessageAuth = z.infer<typeof MessageAuthSchema>;

/** What happened to one destination of a sent message. */
export const MessageRecipientSchema = z.object({
  address: z.string(),
  list: z.enum(["to", "cc", "bcc"]),
  status: z.nativeEnum(SendStatus),
  /** SMTP reply code as the receiving server gave it, e.g. `550`. */
  smtpCode: z.string().nullable().default(null),
  /** The provider's own words — an SMTP line, so it is text and never a link. */
  detail: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type MessageRecipient = z.infer<typeof MessageRecipientSchema>;

/** Row shape for the inbox list (never carries full bodies — section 44). */
export const MessageSummarySchema = z.object({
  authVerdict: z.nativeEnum(AuthVerdict).default(AuthVerdict.Unverified),
  id: z.string(),
  aliasId: z.string(),
  aliasAddress: z.string(),
  aliasLabel: z.string().nullable(),
  domainName: z.string(),
  envelopeFrom: z.string(),
  headerFrom: z.string().nullable(),
  headerTo: z.string().nullable(),
  subject: z.string().nullable(),
  preview: z.string().nullable(),
  receivedAt: z.string(),
  headerDate: z.string().nullable().optional(),
  isRead: z.boolean(),
  /** The owner's own mark. No rule, filter or provider ever sets it. */
  starred: z.boolean().default(false),
  /** Out of the working list because a rule put it there. Never a deletion. */
  archived: z.boolean().default(false),
  ruleTag: z.string().nullable().default(null),
  hasAttachments: z.boolean(),
  attachmentCount: z.number().int().nonnegative(),
  /** Best OTP candidate, precomputed for the list badge. */
  primaryCode: z.string().nullable().optional(),
  codeCount: z.number().int().nonnegative().default(0),
  linkCount: z.number().int().nonnegative().default(0),
  /** `OUT` rows are mail the owner sent, kept in the same list as everything else. */
  direction: z.nativeEnum(MessageDirection).default(MessageDirection.In),
  /**
   * The first message of the conversation this belongs to. Denormalised so a thread is
   * one indexed lookup instead of a walk, and equal to the row's own id for mail that
   * started a conversation.
   */
  threadRootId: z.string().nullable().default(null),
  /** Only meaningful on an `OUT` row; received mail has no send state to report. */
  sendStatus: z.nativeEnum(SendStatus).nullable().default(null),
  cc: z.string().nullable().default(null),
  /**
   * How many messages share this row's thread. Only computed in conversation mode, where one
   * row stands for the whole conversation and the count is what tells you it is not one mail.
   */
  threadCount: z.number().int().nonnegative().optional(),
});
export type MessageSummary = z.infer<typeof MessageSummarySchema>;

/** Full message payload for the detail view. */
export const MessageDetailSchema = MessageSummarySchema.extend({
  providerMessageId: z.string().nullable(),
  rawSize: z.number().int().nonnegative(),
  extractedCodes: z.array(ExtractedCodeSchema).default([]),
  verificationLinks: z.array(VerificationLinkSchema).default([]),
  attachments: z.array(AttachmentSchema).default([]),
  /** Sanitized HTML ready for a sandboxed iframe (see SECURITY.md). */
  htmlBody: z.string().nullable(),
  /** Always-available plain-text fallback. */
  textBody: z.string().nullable(),
  /** Whether a parse failure occurred (raw .eml preserved regardless). */
  parseDegraded: z.boolean().default(false),
  /** Full authentication assessment, kept for the detail view's disclosure UI. */
  auth: MessageAuthSchema.nullable().default(null),
  /** Why a rule filed this message, in the words the rule had when it acted. */
  appliedRuleNote: z.string().nullable().default(null),
  /** Reply bookkeeping, so a conversation can be continued with correct headers. */
  inReplyTo: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  replyTo: z.string().nullable().default(null),
  /** Failure text for an `OUT` row that did not go; null when nothing went wrong. */
  sendError: z.string().nullable().default(null),
  /**
   * How one send reached each of its destinations. `sendStatus` on the row is the summary of
   * these, because a message to three people can arrive at one and bounce off two; only the
   * detail view pays the join, since the list badge needs the summary alone.
   */
  recipients: z.array(MessageRecipientSchema).default([]),
  /**
   * RFC 8058 unsubscribe material, stored verbatim from the sender. Rendering it at all is
   * gated on the message's authentication verdict — see `SECURITY.md` §6.3.
   */
  listUnsubscribe: z.string().nullable().default(null),
  /** True when the sender declared `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
  oneClickUnsubscribe: z.boolean().default(false),
});
export type MessageDetail = z.infer<typeof MessageDetailSchema>;

export const ReadFlagSchema = z.object({ isRead: z.boolean() });
export type ReadFlag = z.infer<typeof ReadFlagSchema>;
