import { z } from "zod";
import { AliasStatus, LocalPartMode } from "./enums";

/**
 * Alias rules. Local parts are intentionally conservative: only `a-z 0-9 . _ -`,
 * never leading/trailing separators, no consecutive dots, max 64 chars. This is a
 * deliberate subset of RFC 5321 — we do not support quoting or exotic syntax.
 */
export const LOCAL_PART_MAX_LENGTH = 64;
export const LABEL_MAX_LENGTH = 120;
export const NOTES_MAX_LENGTH = 1000;
/** System-reserved local parts that could collide with future control addresses. */
export const RESERVED_LOCAL_PARTS = [
  "postmaster",
  "abuse",
  "admin",
  "administrator",
  "root",
  "webmaster",
  "hostmaster",
  "mailer-daemon",
  "daemon",
  "noreply",
  "no-reply",
  "support",
  "security",
];

const LOCAL_PART_ALLOWED = /^[a-z0-9._-]+$/;

export function isValidLocalPart(localPart: string): boolean {
  if (localPart.length === 0 || localPart.length > LOCAL_PART_MAX_LENGTH) return false;
  if (!LOCAL_PART_ALLOWED.test(localPart)) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".")) return false;
  if (localPart.startsWith("-") || localPart.endsWith("-")) return false;
  if (localPart.startsWith("_") || localPart.endsWith("_")) return false;
  if (localPart.includes("..")) return false;
  if (RESERVED_LOCAL_PARTS.includes(localPart)) return false;
  return true;
}

/** Lowercase + trim a user-supplied local part before validation. */
export function normalizeLocalPartInput(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * The wording of each reason, so the same rule can speak the reader's language. English is
 * the default because the Worker validates in English; the app passes its own phrases so the
 * live message under the input matches the rest of the screen.
 */
export interface LocalPartPhrases {
  empty: string;
  tooLong: (max: number, actual: number) => string;
  badChar: (ch: string) => string;
  doubleDot: string;
  startsWith: string;
  endsWith: string;
  reserved: (value: string) => string;
}

export const EN_LOCAL_PART: LocalPartPhrases = {
  empty: "Enter the name you want before the @",
  tooLong: (max, actual) => `At most ${max} characters (this is ${actual})`,
  badChar: (ch) => `“${ch}” is not allowed — use letters a-z, numbers, dot, dash or underscore`,
  doubleDot: "No two dots in a row",
  startsWith: "Cannot start with a dot, dash or underscore",
  endsWith: "Cannot end with a dot, dash or underscore",
  reserved: (value) => `“${value}” is reserved for system addresses`,
};

/**
 * Why a name typed by a person will not work, phrased so they can fix it. Null means the
 * normalized name is acceptable.
 *
 * The input is normalized first, so `Tung` is not an error — it becomes `tung`. Everything
 * else the old single "Invalid local part" message hid is named separately here, because
 * the previous behaviour was a 400 with no way to know what to change.
 */
export function localPartProblem(raw: string, phrases: LocalPartPhrases = EN_LOCAL_PART): string | null {
  const value = normalizeLocalPartInput(raw);
  if (!value) return phrases.empty;
  if (value.length > LOCAL_PART_MAX_LENGTH) return phrases.tooLong(LOCAL_PART_MAX_LENGTH, value.length);
  const bad = value.match(/[^a-z0-9._-]/);
  if (bad) return phrases.badChar(bad[0] as string);
  if (value.includes("..")) return phrases.doubleDot;
  if (/^[._-]/.test(value)) return phrases.startsWith;
  if (/[._-]$/.test(value)) return phrases.endsWith;
  if (RESERVED_LOCAL_PARTS.includes(value)) return phrases.reserved(value);
  return null;
}

/** True when the normalized name is usable. */
export function isUsableLocalPartInput(raw: string): boolean {
  return localPartProblem(raw) === null;
}

/** Turn an arbitrary service name (e.g. "GitHub HQ!") into a safe prefix ("github-hq"). */
export function sanitizeServicePrefix(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .replace(/[-._]{2,}/g, "-")
    .slice(0, 30);
}

export const AliasSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  domainName: z.string().optional(),
  localPart: z.string(),
  address: z.string(),
  label: z.string().nullable(),
  notes: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  status: z.nativeEnum(AliasStatus),
  messageCount: z.number().int().nonnegative().optional(),
  unreadCount: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Alias = z.infer<typeof AliasSchema>;

/**
 * A person's input, normalized before it is judged: `Tung` is not a mistake to be rejected,
 * it is `tung`. The reason that comes back is the one they can act on, and the route stores
 * the normalized value so the address can never be unreachable because of its case.
 */
const customLocalPart = z
  .string()
  .transform(normalizeLocalPartInput)
  .superRefine((value, ctx) => {
    const problem = localPartProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

const servicePrefix = z
  .string()
  .min(1)
  .max(30)
  .transform((v) => sanitizeServicePrefix(v))
  .refine((v) => v.length > 0 && isValidLocalPart(`${v}-x`), {
    message: "Service label produces an invalid prefix",
  });

export const CreateAliasSchema = z.discriminatedUnion("mode", [
  z.object({
    domainId: z.string().min(1),
    mode: z.literal(LocalPartMode.Random),
    label: z.string().max(LABEL_MAX_LENGTH).nullish(),
  }),
  z.object({
    domainId: z.string().min(1),
    mode: z.literal(LocalPartMode.ServiceRandom),
    service: servicePrefix,
    label: z.string().max(LABEL_MAX_LENGTH).nullish(),
  }),
  z.object({
    domainId: z.string().min(1),
    mode: z.literal(LocalPartMode.Custom),
    localPart: customLocalPart,
    label: z.string().max(LABEL_MAX_LENGTH).nullish(),
  }),
]);
export type CreateAliasInput = z.input<typeof CreateAliasSchema>;
export type CreateAliasParsed = z.output<typeof CreateAliasSchema>;

/** PATCH /api/aliases/:id — every field is optional; at least one must be sent. */
export const UpdateAliasSchema = z
  .object({
    label: z.string().max(LABEL_MAX_LENGTH).nullable().optional(),
    notes: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type UpdateAliasInput = z.infer<typeof UpdateAliasSchema>;

/** What has arrived at one alias — the timeline on its detail page. */
export const AliasStatsSchema = z.object({
  messages: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  firstReceivedAt: z.string().nullable(),
  lastReceivedAt: z.string().nullable(),
  senders: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })).default([]),
});
export type AliasStats = z.infer<typeof AliasStatsSchema>;

export const AliasDetailSchema = z.object({ alias: AliasSchema, stats: AliasStatsSchema });
export type AliasDetail = z.infer<typeof AliasDetailSchema>;

/**
 * One row of an aliases export, and everything an import may add: the address, a label,
 * and the note that says where it was used. Status, pinning and archive state are
 * deliberately absent — an import decides what exists, not how the owner has arranged it.
 */
export const AliasExportRowSchema = z.object({
  address: z.string().min(3).max(254),
  label: z.string().max(LABEL_MAX_LENGTH).nullable().optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).nullable().optional(),
});
export type AliasExportRow = z.infer<typeof AliasExportRowSchema>;

export const ImportAliasesInputSchema = z.object({
  aliases: z.array(AliasExportRowSchema).min(1).max(500),
});
export type ImportAliasesInput = z.infer<typeof ImportAliasesInputSchema>;

/** What an import did, so the screen can say exactly what happened rather than "done". */
export const ImportAliasesResultSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invalid: z.array(z.string()).default([]),
});
export type ImportAliasesResult = z.infer<typeof ImportAliasesResultSchema>;

/** DELETE /api/aliases/:id — `purgeMessages` also removes its stored mail. */
export const DeleteAliasSchema = z.object({
  purgeMessages: z.boolean().default(false),
});
export type DeleteAliasInput = z.infer<typeof DeleteAliasSchema>;
