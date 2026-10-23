/**
 * Enumerations and status lifecycles shared across worker, web, and DB layers.
 * Values are stored in D1 as TEXT, so keep them stable and uppercase.
 */

/** Lifecycle of a domain inside MailVault (the state machine, section 8/13). */
export const MailStatus = {
  Discovered: "DISCOVERED",
  Preflight: "PREFLIGHT",
  Conflict: "CONFLICT",
  Provisioning: "PROVISIONING",
  Verifying: "VERIFYING",
  Ready: "READY",
  Failed: "FAILED",
  Disabled: "DISABLED",
} as const;
export type MailStatus = (typeof MailStatus)[keyof typeof MailStatus];

/** Cloudflare Email Routing enablement status mirrored from the API. */
export const RoutingStatus = {
  Unknown: "UNKNOWN",
  Unconfigured: "UNCONFIGURED",
  Misconfigured: "MISCONFIGURED",
  Ready: "READY",
} as const;
export type RoutingStatus = (typeof RoutingStatus)[keyof typeof RoutingStatus];

/** Whether our catch-all rule is installed and pointing at our Worker. */
export const CatchAllStatus = {
  Unknown: "UNKNOWN",
  NotConfigured: "NOT_CONFIGURED",
  Ours: "OURS",
  Foreign: "FOREIGN",
} as const;
export type CatchAllStatus = (typeof CatchAllStatus)[keyof typeof CatchAllStatus];

/** Classification returned by a preflight check (section 7). */
export const PreflightClassification = {
  ReadyToProvision: "READY_TO_PROVISION",
  AlreadyConfigured: "ALREADY_CONFIGURED",
  MxConflict: "MX_CONFLICT",
  CatchAllConflict: "CATCH_ALL_CONFLICT",
  ZoneInactive: "ZONE_INACTIVE",
  UnsupportedZone: "UNSUPPORTED_ZONE",
  ApiPermissionError: "API_PERMISSION_ERROR",
  ProvisioningError: "PROVISIONING_ERROR",
} as const;
export type PreflightClassification =
  (typeof PreflightClassification)[keyof typeof PreflightClassification];

export const ConflictType = {
  None: "NONE",
  Mx: "MX",
  CatchAll: "CATCH_ALL",
  /** Config was changed outside MailVault so mail no longer reaches its Worker. */
  Drift: "DRIFT",
} as const;
export type ConflictType = (typeof ConflictType)[keyof typeof ConflictType];

/** Alias receive-state. Delete is a hard delete, not a status. */
export const AliasStatus = {
  Active: "ACTIVE",
  Disabled: "DISABLED",
} as const;
export type AliasStatus = (typeof AliasStatus)[keyof typeof AliasStatus];

/** How a new alias local-part is produced (section 21). */
export const LocalPartMode = {
  Random: "random",
  ServiceRandom: "service_random",
  Custom: "custom",
} as const;
export type LocalPartMode = (typeof LocalPartMode)[keyof typeof LocalPartMode];

/** Sender-authentication verdict recorded on a message (SPF/DKIM/DMARC assessment). */
export const AuthVerdict = {
  Trusted: "TRUSTED",
  Unverified: "UNVERIFIED",
  Spoofed: "SPOOFED",
} as const;
export type AuthVerdict = (typeof AuthVerdict)[keyof typeof AuthVerdict];

/** What MailVault does with a message whose sender authentication failed. */
export const AuthPolicy = {
  Off: "OFF",
  Warn: "WARN",
  Reject: "REJECT",
} as const;
export type AuthPolicy = (typeof AuthPolicy)[keyof typeof AuthPolicy];

/** Which way a message travelled. Sent mail lives in the same list as received mail. */
export const MessageDirection = {
  In: "IN",
  Out: "OUT",
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

/**
 * Outcome of a send, as reported by Email Sending. `queued` is normal for a large message
 * or a recipient that accepts asynchronously, so it is a state and not a warning.
 *
 * `DEFERRED` is the one value that is never final — the provider is still retrying — which
 * is why the list badge must not present it as a failure. `COMPLAINED` is not a delivery
 * problem either: the message arrived and the recipient reported it as spam, so it is kept
 * per recipient rather than as the message's own status.
 */
export const SendStatus = {
  Preparing: "PREPARING",
  Unknown: "UNKNOWN",
  Queued: "QUEUED",
  Deferred: "DEFERRED",
  Delivered: "DELIVERED",
  Bounced: "BOUNCED",
  Rejected: "REJECTED",
  Suppressed: "SUPPRESSED",
  Failed: "FAILED",
  Complained: "COMPLAINED",
} as const;
export type SendStatus = (typeof SendStatus)[keyof typeof SendStatus];

/** Statuses an Email Sending delivery event can report, mapped to ours. */
export const DeliveryEventStatus = {
  Delivered: "delivered",
  Deferred: "deferred",
  Bounced: "bounced",
  Failed: "failed",
  Rejected: "rejected",
  Complained: "complained",
} as const;
export type DeliveryEventStatus = (typeof DeliveryEventStatus)[keyof typeof DeliveryEventStatus];

/**
 * Whether this domain may be used as a `From`. Independent of receiving: Email Sending
 * writes its own DNS records, so a domain can receive and still not be allowed to send.
 */
export const SendingStatus = {
  Unknown: "UNKNOWN",
  Disabled: "DISABLED",
  Enabled: "ENABLED",
} as const;
export type SendingStatus = (typeof SendingStatus)[keyof typeof SendingStatus];
