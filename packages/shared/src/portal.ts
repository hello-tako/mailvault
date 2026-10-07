import { z } from "zod";

/**
 * Portal links: what the owner hands to a buyer.
 *
 * A link carries one random token, so it is scoped to one alias, dies on its own, and can be
 * withdrawn without touching the mailbox. The bounds below are shared because both sides have
 * to agree: the Worker rejects what is outside them, and the owner's screen offers defaults
 * inside them, so a link that can be made is a link that can be used.
 */

/** Shorter than a buyer needs to paste a code; longer than an order should stay open. */
export const PORTAL_TTL_MIN_MINUTES = 5;
export const PORTAL_TTL_MAX_MINUTES = 10080;
export const PORTAL_TTL_DEFAULT_MINUTES = 60;
export const PORTAL_MAX_VIEWS_CAP = 1000;
export const PORTAL_LABEL_MAX_LENGTH = 80;

export const CreatePortalLinkSchema = z.object({
  ttlMinutes: z
    .number()
    .int()
    .min(PORTAL_TTL_MIN_MINUTES)
    .max(PORTAL_TTL_MAX_MINUTES)
    .default(PORTAL_TTL_DEFAULT_MINUTES),
  /** Absent means unlimited looks until the time runs out. */
  maxViews: z.number().int().min(1).max(PORTAL_MAX_VIEWS_CAP).nullish(),
  label: z.string().max(PORTAL_LABEL_MAX_LENGTH).nullish(),
});
export type CreatePortalLinkInput = z.input<typeof CreatePortalLinkSchema>;

export const PortalGrantSchema = z.object({
  id: z.string(),
  aliasId: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  maxViews: z.number().int().nullable(),
  views: z.number().int().nonnegative(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type PortalGrant = z.infer<typeof PortalGrantSchema>;

/** A row that is expired or exhausted is dead without being revoked, so "still opens" is computed. */
export const PortalLinkSchema = PortalGrantSchema.extend({ active: z.boolean() });
export type PortalLink = z.infer<typeof PortalLinkSchema>;

/** The token appears in this response once and is never stored in a readable form anywhere. */
export const PortalLinkCreatedSchema = z.object({
  grant: PortalGrantSchema,
  token: z.string(),
  url: z.string().url(),
});
export type PortalLinkCreated = z.infer<typeof PortalLinkCreatedSchema>;
