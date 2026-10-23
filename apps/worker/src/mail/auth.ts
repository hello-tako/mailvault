import { AuthVerdict } from "@mailvault/shared";
import { getDomain } from "tldts";

/**
 * Sender authentication assessment (SPF / DKIM / DMARC).
 *
 * MIME Authentication-Results are sender-controlled and are retained only as observations.
 * Trust requires separate verified evidence; the Email Routing adapter currently has no
 * documented verified-authentication result to provide.
 */

export const AuthOutcome = {
  Pass: "pass",
  Fail: "fail",
  SoftFail: "softfail",
  Neutral: "neutral",
  None: "none",
  TempError: "temperror",
  PermError: "permerror",
} as const;
export type AuthOutcome = (typeof AuthOutcome)[keyof typeof AuthOutcome];

export type AuthMechanism = "spf" | "dkim" | "dmarc";
export type VerifiedAuthSource = "cryptographic-verifier" | "trusted-runtime-metadata";

export interface AuthEvidence {
  mechanism: AuthMechanism;
  outcome: AuthOutcome;
  /** Domain the result vouches for or was verified against. */
  domain: string | null;
  aligned: boolean;
  source: "message-header" | VerifiedAuthSource;
  /** Which `Authentication-Results` issuer reported it (e.g. `google.com`, `cloudflare.com`). */
  reporter: string | null;
}

/** Only an independently verified producer may supply this; raw MIME is never converted to it. */
export interface VerifiedAuthEvidence {
  mechanism: AuthMechanism;
  outcome: AuthOutcome;
  domain: string | null;
  source: VerifiedAuthSource;
}

export interface AuthAssessment {
  verdict: AuthVerdict;
  /** Verified outcomes when available, otherwise outcomes reported by the header. */
  spf: AuthOutcome | null;
  dkim: AuthOutcome | null;
  dmarc: AuthOutcome | null;
  /** Verified passes that vouch for the From domain. */
  alignedPass: Record<AuthMechanism, boolean>;
  evidence: AuthEvidence[];
  /** Envelope MAIL FROM domain is unrelated to the header From domain. */
  envelopeMismatch: boolean;
  /** No recognized authentication result was parsed. */
  observed: boolean;
  reasons: string[];
}

const OUTCOMES = new Set<string>(Object.values(AuthOutcome));
const VERIFIED_SOURCES = new Set<string>(["cryptographic-verifier", "trusted-runtime-metadata"]);

export function bareDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const fromAngle = /<\s*([^>\s]+@[^>\s]+)\s*>/.exec(value);
  let raw = (fromAngle?.[1] ?? value).trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at >= 0) raw = raw.slice(at + 1);
  raw = raw.replace(/^\.+|\.+$/g, "").trim();
  return raw || null;
}

export function registrableDomain(domain: string | null): string | null {
  if (!domain) return null;
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!normalized || !/^[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*$/u.test(normalized))
    return null;
  let asciiHostname: string;
  try {
    asciiHostname = new URL(`http://${normalized}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    getDomain(asciiHostname, {
      allowPrivateDomains: true,
      validateHostname: true,
    })?.toLowerCase() ?? null
  );
}

/** `child` equals `parent` or sits underneath it — DMARC relaxed-style alignment. */
export function domainsAlign(child: string | null, parent: string | null): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.endsWith(`.${parent}`);
}

function domainLabel(raw: string): string {
  const value = raw.trim().replace(/^"|"$/g, "");
  const at = value.indexOf("=");
  const candidate = at >= 0 ? value.slice(at + 1) : value;
  return (bareDomain(candidate) ?? candidate).toLowerCase();
}

function parseLine(line: string): {
  pss: string | null;
  pairs: Array<{ mech: string; outcome: AuthOutcome; value: string | null }>;
} {
  const parts = line
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const pss = parts.length > 0 ? bareDomain(parts[0]) : null;
  const pairs: Array<{ mech: string; outcome: AuthOutcome; value: string | null }> = [];
  for (const segment of parts.slice(1)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (!head) continue;
    const eq = head.indexOf("=");
    if (eq <= 0) continue;
    const mech = head.slice(0, eq).toLowerCase();
    const outcome = head.slice(eq + 1).toLowerCase();
    if (!OUTCOMES.has(outcome)) continue;
    let value: string | null = null;
    for (const token of tokens.slice(1)) {
      if (/^(d|header\.d|header\.i|header\.from|smtp\.mailfrom|dtcp|selector)=/i.test(token)) {
        value = token;
        break;
      }
    }
    pairs.push({ mech, outcome: outcome as AuthOutcome, value });
  }
  return { pss, pairs };
}

function collect(authResults: string[], fromDomain: string | null): AuthEvidence[] {
  const evidence: AuthEvidence[] = [];
  for (const line of authResults) {
    const { pss, pairs } = parseLine(line);
    for (const pair of pairs) {
      const vouched = pair.value ? domainLabel(pair.value) : pss;
      evidence.push({
        mechanism: (["spf", "dkim", "dmarc"].includes(pair.mech)
          ? pair.mech
          : "dkim") as AuthMechanism,
        outcome: pair.outcome,
        domain: vouched || null,
        aligned:
          !!vouched &&
          !!fromDomain &&
          domainsAlign(registrableDomain(vouched), registrableDomain(fromDomain)),
        source: "message-header",
        reporter: pss,
      });
    }
  }
  return evidence;
}

function collectVerified(
  evidence: VerifiedAuthEvidence[],
  fromDomain: string | null,
): AuthEvidence[] {
  return evidence.flatMap((item) => {
    if (
      !item ||
      !["spf", "dkim", "dmarc"].includes(item.mechanism) ||
      !OUTCOMES.has(item.outcome) ||
      !VERIFIED_SOURCES.has(item.source)
    )
      return [];
    const domain = item.domain ? bareDomain(item.domain) : null;
    return [
      {
        mechanism: item.mechanism,
        outcome: item.outcome,
        domain,
        aligned:
          !!domain &&
          !!fromDomain &&
          domainsAlign(registrableDomain(domain), registrableDomain(fromDomain)),
        source: item.source,
        reporter: null,
      },
    ];
  });
}

const BETTER: Record<string, number> = {
  [AuthOutcome.Pass]: 6,
  [AuthOutcome.Neutral]: 5,
  [AuthOutcome.SoftFail]: 4,
  [AuthOutcome.None]: 3,
  [AuthOutcome.TempError]: 2,
  [AuthOutcome.PermError]: 1,
  [AuthOutcome.Fail]: 0,
};

/** Prefer the most informative result within an evidence source; trust is assessed separately. */
function pick(list: AuthOutcome[]): AuthOutcome | null {
  if (list.length === 0) return null;
  const ranked = [...list].sort((a, b) => (BETTER[b] ?? 0) - (BETTER[a] ?? 0));
  return ranked[0] ?? null;
}

export function assessAuth(input: {
  authResults: string[];
  headerFrom: string | null;
  envelopeFrom: string | null;
  /** Independent verifier output only; this must never be populated from MIME headers. */
  verifiedEvidence?: VerifiedAuthEvidence[];
}): AuthAssessment {
  const fromDomain = bareDomain(input.headerFrom);
  const envelopeDomain = bareDomain(input.envelopeFrom);
  const headerEvidence = collect(input.authResults, fromDomain);
  const verifiedEvidence = collectVerified(input.verifiedEvidence ?? [], fromDomain);
  const evidence = [...headerEvidence, ...verifiedEvidence];
  const alignedPass: Record<AuthMechanism, boolean> = { spf: false, dkim: false, dmarc: false };

  for (const item of verifiedEvidence) {
    if (item.outcome === AuthOutcome.Pass && item.aligned) alignedPass[item.mechanism] = true;
  }

  const result = {} as Record<AuthMechanism, AuthOutcome | null>;
  for (const mechanism of ["spf", "dkim", "dmarc"] as const) {
    const verified = verifiedEvidence.filter((item) => item.mechanism === mechanism);
    const observed = headerEvidence.filter((item) => item.mechanism === mechanism);
    result[mechanism] = pick(
      (verified.length > 0 ? verified : observed).map((item) => item.outcome),
    );
    if (alignedPass[mechanism]) result[mechanism] = AuthOutcome.Pass;
  }

  const envelopeMismatch =
    !!fromDomain && !!envelopeDomain
      ? registrableDomain(fromDomain) !== registrableDomain(envelopeDomain)
      : false;

  const reasons: string[] = [];
  let verdict: AuthVerdict = AuthVerdict.Unverified;
  const trustedDmarcFailure = verifiedEvidence.some(
    (item) => item.mechanism === "dmarc" && item.outcome === AuthOutcome.Fail && item.aligned,
  );
  if (trustedDmarcFailure) {
    verdict = AuthVerdict.Spoofed;
    reasons.push("dmarc=fail");
  }
  if (!alignedPass.dmarc && !alignedPass.dkim && !alignedPass.spf) {
    if (verdict !== AuthVerdict.Spoofed) {
      reasons.push(
        headerEvidence.length > 0
          ? "kết quả xác thực chỉ đến từ header do người gửi cung cấp"
          : "không có kết quả xác thực đã được xác minh",
      );
    }
  } else if (verdict !== AuthVerdict.Spoofed) {
    verdict = AuthVerdict.Trusted;
    if (alignedPass.dmarc) reasons.push("dmarc pass, aligned");
    if (alignedPass.dkim) reasons.push("dkim pass, aligned");
    if (alignedPass.spf) reasons.push("spf pass, aligned");
  }
  if (envelopeMismatch) reasons.push("envelope from khác domain người gửi");

  return {
    verdict,
    spf: result.spf,
    dkim: result.dkim,
    dmarc: result.dmarc,
    alignedPass,
    evidence,
    envelopeMismatch,
    observed: evidence.length > 0,
    reasons,
  };
}
