import { z } from "zod";
import {
  MailStatus,
  RoutingStatus,
  CatchAllStatus,
  ConflictType,
  PreflightClassification,
  AuthPolicy,
  SendingStatus,
} from "./enums";

/**
 * Domain DTOs. A `Domain` row is a Cloudflare zone that MailVault tracks.
 * Discovery (list from Cloudflare) and provisioning (enable mail) are separate
 * concerns — a discovered zone is inert until the owner explicitly enables it.
 */

export const ConflictDetailsSchema = z.object({
  type: z.nativeEnum(ConflictType),
  message: z.string(),
  /** Existing MX records that would be disturbed (host + priority). */
  mxRecords: z
    .array(z.object({ exchange: z.string(), priority: z.number(), ttl: z.number().optional() }))
    .optional(),
  /** Foreign catch-all destination description, when relevant. */
  catchAll: z
    .object({
      actionType: z.string().optional(),
      destination: z.string().optional(),
    })
    .optional(),
});
export type ConflictDetails = z.infer<typeof ConflictDetailsSchema>;

export const DomainSchema = z.object({
  id: z.string(),
  cloudflareZoneId: z.string(),
  cloudflareAccountId: z.string().nullable(),
  name: z.string(),
  zoneStatus: z.string(),
  zoneType: z.string(),
  mailStatus: z.nativeEnum(MailStatus),
  routingStatus: z.nativeEnum(RoutingStatus),
  catchAllStatus: z.nativeEnum(CatchAllStatus),
  conflictType: z.nativeEnum(ConflictType),
  conflictDetails: ConflictDetailsSchema.nullable(),
  /** How this domain handles mail whose sender failed authentication. */
  authPolicy: z.nativeEnum(AuthPolicy).default(AuthPolicy.Warn),
  /**
   * Whether Email Sending is onboarded for the name this domain sends under — `sendingVia`
   * when one is set, the domain itself otherwise. Tracked apart from the receiving state
   * because the two have separate DNS records and separate owner confirmations.
   */
  sendingStatus: z.nativeEnum(SendingStatus).default(SendingStatus.Unknown),
  /**
   * The Email Sending name this domain's mail leaves as, when it is not the domain's own.
   * Aliases stay on `name` — that is where mail is received and answered — while the sending
   * records, including the DMARC policy, sit on a subdomain nobody else uses.
   */
  sendingVia: z.string().nullable().default(null),
  /** Cloudflare's sending-subdomain tag, kept so the state can be re-read and undone. */
  sendingTag: z.string().nullable().default(null),
  sendingCheckedAt: z.string().nullable().default(null),
  lastCheckedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Domain = z.infer<typeof DomainSchema>;

/** Outcome of one drift sweep over the domains MailVault already trusts. */
export const DriftReportSchema = z.object({
  checked: z.number().int().nonnegative(),
  ok: z.array(z.string()),
  drifted: z.array(z.string()),
  restored: z.array(z.string()),
  failed: z.array(z.string()),
});
export type DriftReport = z.infer<typeof DriftReportSchema>;

/** Minimal info about a Cloudflare zone returned by discovery, before it is stored. */
export const DiscoveredZoneSchema = z.object({
  cloudflareZoneId: z.string(),
  cloudflareAccountId: z.string().nullable(),
  name: z.string(),
  status: z.string(),
  type: z.string(),
  account: z
    .object({ id: z.string().nullable(), name: z.string().nullable() })
    .nullable()
    .optional(),
});
export type DiscoveredZone = z.infer<typeof DiscoveredZoneSchema>;

export const PreflightResultSchema = z.object({
  domainId: z.string().nullable(),
  zoneId: z.string(),
  name: z.string(),
  classification: z.nativeEnum(PreflightClassification),
  safeToProvision: z.boolean(),
  conflict: ConflictDetailsSchema.nullable(),
  checkedAt: z.string(),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export const ProvisionOutcomeSchema = z.object({
  domainId: z.string(),
  zoneId: z.string(),
  name: z.string(),
  status: z.nativeEnum(MailStatus),
  ok: z.boolean(),
  error: z.string().nullable(),
  steps: z.array(
    z.object({
      step: z.string(),
      ok: z.boolean(),
      detail: z.string().nullable().optional(),
    }),
  ),
});
export type ProvisionOutcome = z.infer<typeof ProvisionOutcomeSchema>;

/** POST /api/domains/sync|preflight|provision bodies. */
export const DomainIdsBodySchema = z.object({
  zoneIds: z.array(z.string().min(1)).min(1, "Select at least one domain"),
});
export type DomainIdsBody = z.infer<typeof DomainIdsBodySchema>;

/** Dangerous-action confirmation wrapper for takeover operations. */
export const ConfirmationTokenSchema = z.object({
  confirm: z.literal(true, {
    error: "Explicit confirmation required for destructive action",
  }),
});
