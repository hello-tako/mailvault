import { z } from "zod";
import { MessageSummarySchema } from "./message";
import { MailStatus } from "./enums";

/** Structured error envelope returned by every API failure (section 30/47). */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ErrorCodes = {
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  Validation: "VALIDATION_ERROR",
  Conflict: "CONFLICT",
  RateLimited: "RATE_LIMITED",
  UpstreamCloudflare: "CLOUDFLARE_API_ERROR",
  Internal: "INTERNAL_ERROR",
  BadOrigin: "BAD_ORIGIN",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Cursor-free offset pagination — sufficient at personal scale. */
export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  total: z.number().int().nonnegative(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export function paginated<T>(items: T[], page: Pagination) {
  return { items, ...page };
}
export type Paginated<T> = { items: T[] } & Pagination;

export const MessageFilter = {
  All: "all",
  Unread: "unread",
} as const;

export const MessageListQuerySchema = z.object({
  filter: z.enum([MessageFilter.All, MessageFilter.Unread]).default(MessageFilter.All),
  /**
   * Which side of a rule's filing to look at. `active` is the working list and the
   * default, so archiving something takes it out of the way without removing it.
   */
  archived: z.enum(["active", "archived", "all"]).default("active"),
  domainId: z.string().min(1).optional(),
  aliasId: z.string().min(1).optional(),
  /**
   * Inbox, Sent, or both. Defaults to received mail because that is what an inbox is,
   * and a conversation view asks for `all` explicitly rather than every list having to
   * filter sent mail out again.
   */
  direction: z.enum(["in", "out", "all"]).default("in"),
  /** Every message of one thread, oldest first when combined with `all`. */
  threadId: z.string().min(1).optional(),
  /**
   * The starred tab asks for `true`. Absent means "starred or not", because a list that
   * deliberately hides marked mail is not a view anybody wants.
   */
  starred: z.enum(["true", "false"]).optional(),
  /**
   * Collapse each conversation to its newest message, the way a mailbox list reads. Off by
   * default so a search or an alias view still shows every hit individually.
   */
  threaded: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Full-text search over subject, preview and sender, plus an exact match on OTP codes. */
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /**
   * Keyset cursor for the plain (unsearched, unthreaded) list: `receivedAt|id` of the
   * last row of the previous page. Page N then costs an index seek rather than a walk
   * past everything before it, which is what OFFSET cannot help doing. Ignored whenever
   * the query is a search or a threaded view — those keep offset semantics.
   */
  before: z.string().max(120).optional(),
});
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

/**
 * What a multi-select can do to the messages it names. Every one of these is reversible
 * except `delete`, which is why delete is the only action the UI asks you to confirm.
 *
 * There is no spam/junk action on purpose: this mailbox receives only at addresses the
 * owner created, so "junk" would mean "the alias I chose to hand over is misbehaving", and
 * the answer to that is to disable the alias, which is a decision with a visible place.
 */
export const BulkMessageAction = {
  Read: "read",
  Unread: "unread",
  Star: "star",
  Unstar: "unstar",
  Archive: "archive",
  Unarchive: "unarchive",
  Delete: "delete",
} as const;
export type BulkMessageAction = (typeof BulkMessageAction)[keyof typeof BulkMessageAction];

/** 200 ids is the same ceiling the list page size uses, and keeps one D1 statement bounded. */
export const BulkMessageInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(Object.values(BulkMessageAction) as [BulkMessageAction, ...BulkMessageAction[]]),
});
export type BulkMessageInput = z.infer<typeof BulkMessageInputSchema>;

export const BulkMessageResultSchema = z.object({
  action: z.nativeEnum(BulkMessageAction),
  /** Rows the database actually changed, which is not always the number clicked. */
  affected: z.number().int().nonnegative(),
  /** Only `delete` reports this: R2 objects the purge asked for, whether or not each one went. */
  r2ObjectsRemoved: z.number().int().nonnegative().default(0),
});
export type BulkMessageResult = z.infer<typeof BulkMessageResultSchema>;

export const CountSchema = z.object({
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type Count = z.infer<typeof CountSchema>;

/**
 * Tab and mailbox badges. Deliberately its own small endpoint rather than extra fields on
 * every list response: the counters are scoped to the whole mailbox, not to the page you
 * happen to be looking at, so they stay the same while paging and while a filter changes.
 */
export const MessageCountersSchema = z.object({
  inbox: CountSchema,
  sent: CountSchema,
  starred: CountSchema,
  filed: CountSchema,
  mailboxes: z.array(z.object({ domainId: z.string(), unread: z.number().int().nonnegative() })).default([]),
});
export type MessageCounters = z.infer<typeof MessageCountersSchema>;

/**
 * One domain as the owner sees it: a mailbox with its own mail in it. Counts come
 * straight from `messages`, so a mailbox can never claim mail it does not have.
 */
export const MailboxStatSchema = z.object({
  domainId: z.string(),
  name: z.string(),
  mailStatus: z.nativeEnum(MailStatus),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  lastReceivedAt: z.string().nullable(),
});
export type MailboxStat = z.infer<typeof MailboxStatSchema>;

export const DashboardStatsSchema = z.object({
  activeDomains: z.number().int().nonnegative(),
  totalDomains: z.number().int().nonnegative(),
  totalAliases: z.number().int().nonnegative(),
  unreadMessages: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  recentMessages: z.array(MessageSummarySchema).default([]),
  mailboxes: z.array(MailboxStatSchema).default([]),
});
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

/**
 * A registered passkey as the owner sees it. The credential id and public key are
 * verification material and are never returned.
 */
export const PasskeySchema = z.object({
  id: z.string(),
  deviceLabel: z.string().nullable(),
  transports: z.array(z.string()).nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Passkey = z.infer<typeof PasskeySchema>;

/**
 * One sender domain that has written to more than one of the owner's aliases — i.e. the
 * address was reused, or resold, across services.
 */
export const AddressReuseSchema = z.object({
  senderDomain: z.string(),
  aliases: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});
export type AddressReuse = z.infer<typeof AddressReuseSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  time: z.string(),
  checks: z
    .object({
      d1: z.enum(["ok", "error"]),
      r2: z.enum(["ok", "error"]),
      token: z.enum(["ok", "error", "unset"]),
    })
    .partial(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Result of one push sweep. Deliberately carries no message content. */
export const PushOutcomeSchema = z.object({
  sent: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.enum(["not-configured", "no-subscribers"]).optional(),
});
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;
