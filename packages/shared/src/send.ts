import { z } from "zod";

/**
 * Sending. Most of these ceilings are Cloudflare's, not ours, and they are quoted so a
 * rejected compose can say which one was hit instead of passing an upstream error
 * through untranslated. The ones that are ours say so.
 */
// Ours, not Cloudflare's: Email Sending carries up to 25 MiB and inbound accepts 20 MiB, but
// a compose body is JSON with base64 inside, and 15 MiB of assembled message is already ~3x
// the practical single-file size the old 5 MiB ceiling allowed. Room to grow, still far from
// the wire cap.
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export const SEND_LIMITS = {
  /** Combined to + cc + bcc, as one message. */
  maxRecipients: 50,
  /** Subject is capped by Email Sending at 998 characters. */
  maxSubjectChars: 998,
  /** Whole message including body and attachments, measured in UTF-8 bytes. */
  maxTotalBytes: MAX_TOTAL_BYTES,
  /** Our own guard on how many addresses one person may compose at once. */
  maxDraftAddresses: 50,
  /** Our own guard on how many files one message may carry. Cloudflare counts bytes, not files. */
  maxAttachments: 8,
  /**
   * Base64 of a whole message's worth of bytes: four characters for every three, so this is the
   * ceiling on the *encoded* form. Not a limit of its own — a number a request can be measured
   * against before any of it is decoded, which is the only thing decoding costs.
   */
  maxTotalBase64Chars: Math.ceil(MAX_TOTAL_BYTES / 3) * 4,
} as const;

const Base64Content = z
  .string()
  .min(1)
  .max(SEND_LIMITS.maxTotalBase64Chars)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Expected base64");

/**
 * A file to send with a message. `content` is the file's bytes in base64, because that is the
 * only form a JSON request can carry — and the form the sending binding takes directly. The
 * Worker decodes it to keep its own copy of what left, and refuses the compose when the
 * assembled message would be bigger than one message is allowed to be.
 */
export const ComposeAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  /**
   * A MIME type as the browser reported it, syntax-checked so it cannot write a header line of
   * its own. A file whose type nobody recognises arrives as an empty string and is treated as
   * opaque bytes.
   */
  type: z
    .string()
    .trim()
    .max(120)
    .regex(/^$|^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
    .transform((v) => v || "application/octet-stream"),
  content: Base64Content,
});
export type ComposeAttachment = z.infer<typeof InlineAttachmentSchema>;

/** Show inside the message rather than riding under it (B3): the HTML body references the
 * file through the token, the worker carries it on the wire as an inline part. */
export const InlineAttachmentSchema = ComposeAttachmentSchema.extend({
  inline: z.boolean().optional(),
  /** The `cid:` name the body's markdown uses for this file, minted by the composer. */
  cidToken: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/, "cidToken must be a plain cid name")
    .optional(),
});

const AttachmentList = z
  .array(InlineAttachmentSchema)
  .max(SEND_LIMITS.maxAttachments)
  .optional();

const AddressList = z.array(z.string().trim().min(3).max(254)).max(SEND_LIMITS.maxDraftAddresses);

/**
 * A compose. `fromAddress` must be one of the owner's own ACTIVE aliases — the API never
 * accepts an address it has not seen in `aliases`, because "send as anybody" is precisely
 * what an open relay is.
 */
export const ComposeInputSchema = z.object({
  fromAddress: z.string().trim().min(3).max(254),
  to: AddressList.min(1),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  subject: z.string().max(SEND_LIMITS.maxSubjectChars).default(""),
  text: z.string().max(200_000).default(""),
  /** Optional. When present it is sanitised server-side the same way received HTML is. */
  html: z.string().max(400_000).optional(),
  fromName: z.string().max(120).optional(),
  /** Reply-To, when the owner wants answers somewhere other than the sending alias. */
  // One clean address, and nothing that could fold into another header line in the stored
  // .eml — CRLF in a header value is how stored records get smuggled extra headers.
  replyTo: z
    .string()
    .trim()
    .min(3)
    .max(254)
    .regex(/^[^@\r\n ]{1,64}@[^@\r\n ]{1,190}$/, "replyTo must be one email address")
    .optional(),
  /** Mail id this compose answers. Sets In-Reply-To/References and joins its thread. */
  replyToMessageId: z.string().min(1).optional(),
  attachments: AttachmentList,
});
export type ComposeInput = z.infer<typeof ComposeInputSchema>;

/**
 * A reply. Who it goes to and who it comes from are read from the message being answered,
 * never accepted from the client — otherwise the compose screen could aim a reply at an
 * address the owner never saw, or send as an alias that was never theirs.
 */
export const ReplyInputSchema = z.object({
  text: z.string().max(200_000).default(""),
  html: z.string().max(400_000).optional(),
  subject: z.string().max(SEND_LIMITS.maxSubjectChars).optional(),
  fromName: z.string().max(120).optional(),
  /** Extra recipients to bring in, beyond the one the message came from. */
  cc: AddressList.optional(),
  attachments: AttachmentList,
});
export type ReplyInput = z.infer<typeof ReplyInputSchema>;

/** Forwarding one stored message (B2): an intro in the owner's words, plus the original
 * either inlined as quoted text or riding along as the untouched .eml. */
export const ForwardInputSchema = z.object({
  fromAddress: z.string().trim().min(3).max(254),
  to: AddressList.min(1),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  subject: z.string().max(SEND_LIMITS.maxSubjectChars).optional(),
  intro: z.string().max(200_000).default(""),
  /** Attach the untouched original as message/rfc822 rather than quoting it inline. */
  attachOriginal: z.boolean().default(true),
});
export type ForwardInput = z.infer<typeof ForwardInputSchema>;

/** The compose-in-progress, saved server-side so it follows the owner between devices
 * (B4). One slot per composer: "compose", or "reply-<message id>". Address lines are kept
 * as typed — they are a draft, not a recipient list, and are validated only when sent. */
export const DraftInputSchema = z.object({
  id: z.string().trim().min(1).max(120),
  fromAddress: z.string().trim().max(254).optional(),
  to: z.string().max(2000).optional(),
  cc: z.string().max(2000).optional(),
  bcc: z.string().max(2000).optional(),
  subject: z.string().max(SEND_LIMITS.maxSubjectChars).optional(),
  text: z.string().max(200_000).optional(),
  replyToMessageId: z.string().min(1).optional(),
});

/** Autocomplete input: a fragment of an address or a display name, nothing more. */
export const RecipientQuerySchema = z.object({ q: z.string().trim().max(80).optional() });

/**
 * An address the owner has actually corresponded with, for the composer to suggest. Names and
 * addresses are their own mail — this is not a contact book, and nothing is collected from
 * anywhere else.
 */
export const RecipientSuggestionSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  lastSeen: z.string(),
  /** True when this mailbox sent to that address, not just received from it. */
  outgoing: z.boolean().default(false),
});
export type RecipientSuggestion = z.infer<typeof RecipientSuggestionSchema>;

/** What the owner gets back: enough to render the row without a second fetch. */
export const SendOutcomeSchema = z.object({
  id: z.string(),
  status: z.string(),
  providerMessageId: z.string().nullable(),
  delivered: z.array(z.string()),
  queued: z.array(z.string()),
  bounced: z.array(z.string()),
  suppressed: z.array(z.string()),
  error: z.string().nullable(),
});
export type SendOutcome = z.infer<typeof SendOutcomeSchema>;

/** The sending capability of one domain, as the compose screen needs to see it. */
export const SendingCapabilitySchema = z.object({
  domainId: z.string(),
  domainName: z.string(),
  sendingStatus: z.string(),
  /** True when MailVault can send as an alias on this domain right now. */
  canSend: z.boolean(),
  /** Why it cannot, in a key the UI translates. */
  reason: z.string().nullable(),
});
export type SendingCapability = z.infer<typeof SendingCapabilitySchema>;

/** Dry-run of the DNS Email Sending will write for a domain, before anyone confirms it. */
export const SendingPreviewSchema = z.object({
  domainId: z.string(),
  domainName: z.string(),
  alreadyEnabled: z.boolean(),
  records: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        content: z.string(),
        priority: z.number().optional(),
      }),
    )
    .default([]),
  /** Codes like `dmarc.multiple` / `dkim.conflict` straight from Cloudflare's preview. */
  issues: z.array(z.object({ code: z.string(), existing: z.string().nullable() })).default([]),
  /** True when a DMARC record already exists and enabling sending would change it. */
  dmarcConflict: z.boolean().default(false),
  checkedAt: z.string(),
});
export type SendingPreview = z.infer<typeof SendingPreviewSchema>;

export const EnableSendingInputSchema = z.object({
  /** Explicit confirmation that the domain's DMARC record will be created or replaced. */
  allowDmarcTakeover: z.boolean().default(false),
});
export type EnableSendingInput = z.infer<typeof EnableSendingInputSchema>;

/**
 * One Email Sending name inside a zone, as Cloudflare reports it. A zone can hold several, and
 * each carries its own `cf-bounce` records and its own DMARC policy — which is the whole reason
 * a domain may prefer to send through a subdomain rather than through itself.
 */
export const SendingNameSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  /** Cloudflare's id for the row, kept so state can be re-read and undone. */
  tag: z.string().nullable().default(null),
});
export type SendingName = z.infer<typeof SendingNameSchema>;

/**
 * Which name a domain's mail leaves under. `null` puts it back to sending as the domain itself.
 * Choosing a name writes no DNS and changes no receiving record; it only decides which
 * already-onboarded (or about-to-be) sending identity the compose screen may use.
 */
export const SetSendingViaInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(4)
    .max(254)
    .regex(/^[A-Za-z0-9.-]+$/)
    .nullable(),
});
export type SetSendingViaInput = z.infer<typeof SetSendingViaInputSchema>;
