import { promises as dns } from "node:dns";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { log } from "../lib/logging";
import { AuthOutcome, type VerifiedAuthEvidence } from "./auth";

/**
 * Receiver-side DKIM verification (MAILVAULT-SENDER-AUTH-V1). The only producer of
 * `cryptographic-verifier` evidence. It takes the raw RFC 822 bytes MailVault received, runs the
 * pinned mailauth verifier in strict mode with RSA-SHA1 refused, and reports each signature with
 * the d= domain it verified. Alignment with the visible From is judged later by assessAuth().
 */

export type TxtResolver = (name: string) => Promise<string[][]>;

export interface DkimLimits {
  /** DKIM-Signature fields a message may carry; a message with more is not verified at all. */
  maxSignatures: number;
  /** Distinct DNS names looked up per message. Signatures that share a key share one lookup. */
  maxDnsNames: number;
  dnsTimeoutMs: number;
  /** Whole-verification deadline; a verification still running then grants no pass. */
  deadlineMs: number;
  maxTxtRecords: number;
  maxTxtLength: number;
}

export const DKIM_LIMITS: DkimLimits = {
  maxSignatures: 8,
  maxDnsNames: 8,
  dnsTimeoutMs: 2_000,
  deadlineMs: 10_000,
  maxTxtRecords: 4,
  maxTxtLength: 4_096,
};

export interface VerifyDkimOptions {
  /** Key lookups. Omitted in production, where the Worker's node:dns resolver is used. */
  resolveTxt?: TxtResolver;
  limits?: Partial<DkimLimits>;
}

/** The fields of a mailauth 7.1.1 DKIM result that this module reads. */
interface DkimResult {
  signingDomain?: string;
  status: { result: string; testing?: boolean; underSized?: number };
}

// RFC 8601 "policy": local policy refused the signature (rsa-sha1, weak key). Never a pass.
const OUTCOME_BY_RESULT = new Map<string, AuthOutcome>([
  ["pass", AuthOutcome.Pass],
  ["fail", AuthOutcome.Fail],
  ["neutral", AuthOutcome.Neutral],
  ["none", AuthOutcome.None],
  ["temperror", AuthOutcome.TempError],
  ["permerror", AuthOutcome.PermError],
  ["policy", AuthOutcome.PermError],
]);

const DKIM_NAME = /^(?=.{1,253}$)[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const DOMAIN_NAME = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const UNICODE_DOMAIN = /^[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*$/u;
const DKIM_SIGNATURE_FIELD = "dkim-signature";

/**
 * Verifies the DKIM signatures of one message. Never throws, and never grants a pass it did not
 * verify: unknown results are dropped, and DNS or deadline failures come back as temperror or as
 * no evidence at all.
 */
export async function verifyDkim(
  raw: Uint8Array,
  options: VerifyDkimOptions = {},
): Promise<VerifiedAuthEvidence[]> {
  const limits: DkimLimits = { ...DKIM_LIMITS, ...options.limits };
  if (countDkimSignatures(raw) > limits.maxSignatures) {
    log.warn("mail_dkim_unverified", { reason: "too_many_signatures" });
    return [];
  }
  const resolver = boundedTxtResolver(options.resolveTxt ?? resolveWithNodeDns, limits);
  try {
    const verified = await withTimeout(
      dkimVerify(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
        strict: true,
        rejectRsaSha1: true,
        resolver,
      }),
      limits.deadlineMs,
      "EDEADLINE",
    );
    return (verified.results as DkimResult[]).flatMap((result) => {
      const item = normalize(result);
      return item ? [item] : [];
    });
  } catch (err) {
    log.warn("mail_dkim_unverified", {
      reason: codeOf(err) === "EDEADLINE" ? "deadline" : "verifier_error",
    });
    return [];
  }
}

/** DKIM-Signature fields in the header block, counted before mailauth parses anything. */
export function countDkimSignatures(raw: Uint8Array): number {
  let count = 0;
  let lineStart = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i < raw.length && raw[i] !== 0x0a) continue;
    const lineEnd = i > lineStart && raw[i - 1] === 0x0d ? i - 1 : i;
    if (lineEnd === lineStart) break;
    if (isDkimSignatureField(raw, lineStart, lineEnd)) count += 1;
    lineStart = i + 1;
  }
  return count;
}

function isDkimSignatureField(raw: Uint8Array, start: number, end: number): boolean {
  const name = DKIM_SIGNATURE_FIELD;
  if (end - start <= name.length) return false;
  for (let k = 0; k < name.length; k += 1) {
    // | 0x20 folds ASCII letters to lower case.
    if ((raw[start + k]! | 0x20) !== name.charCodeAt(k)) return false;
  }
  let j = start + name.length;
  while (j < end && (raw[j] === 0x20 || raw[j] === 0x09)) j += 1;
  return j < end && raw[j] === 0x3a;
}

/**
 * DNS for one verification: lookups are deduplicated by name and bounded in count, answer size
 * and time, and nothing is cached beyond this message. mailauth reads ENOTFOUND and ENODATA as
 * "no key"; every other failure code, including the limits above, is a DNS failure (temperror).
 */
export function boundedTxtResolver(
  resolveTxt: TxtResolver,
  limits: DkimLimits,
): (name: string, type: string) => Promise<string[][]> {
  const lookups = new Map<string, Promise<string[][]>>();
  return async (name, type) => {
    if (type !== "TXT") throw failure("EDNSTYPE");
    const key = name.toLowerCase();
    const known = lookups.get(key);
    if (known) return known;
    if (!DKIM_NAME.test(key)) throw failure("ENOTFOUND");
    if (lookups.size >= limits.maxDnsNames) throw failure("EDNSBUDGET");
    const lookup = withTimeout(
      (async () => checkAnswer(await resolveTxt(key), limits))(),
      limits.dnsTimeoutMs,
      "EDNSTIMEOUT",
    );
    lookups.set(key, lookup);
    return lookup;
  };
}

function checkAnswer(answer: unknown, limits: DkimLimits): string[][] {
  if (!Array.isArray(answer) || answer.length > limits.maxTxtRecords) throw failure("EDNSANSWER");
  for (const record of answer) {
    if (!Array.isArray(record) || record.some((chunk) => typeof chunk !== "string")) {
      throw failure("EDNSANSWER");
    }
    if (record.join("").length > limits.maxTxtLength) throw failure("EDNSANSWER");
  }
  return answer as string[][];
}

function normalize(result: DkimResult): VerifiedAuthEvidence | null {
  const mapped = OUTCOME_BY_RESULT.get(result.status.result);
  if (!mapped) return null;
  // A pass that does not cover the whole message says nothing about the rest: a testing (t=y)
  // key is treated as unsigned (RFC 6376 section 3.6.1), and an l= limit leaves bytes unsigned.
  const partial = result.status.testing === true || (result.status.underSized ?? 0) > 0;
  return {
    mechanism: "dkim",
    outcome: mapped === AuthOutcome.Pass && partial ? AuthOutcome.Neutral : mapped,
    domain: signingDomainOf(result.signingDomain),
    source: "cryptographic-verifier",
  };
}

/** The signing domain as a lower-case ASCII name, or null when it is not a usable domain. */
function signingDomainOf(value: string | undefined): string | null {
  const candidate = (value ?? "").trim().toLowerCase();
  if (!UNICODE_DOMAIN.test(candidate)) return null;
  try {
    const ascii = new URL(`http://${candidate}`).hostname;
    return DOMAIN_NAME.test(ascii) ? ascii : null;
  } catch {
    return null;
  }
}

const resolveWithNodeDns: TxtResolver = (name) => dns.resolveTxt(name);

function withTimeout<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure(code)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}
