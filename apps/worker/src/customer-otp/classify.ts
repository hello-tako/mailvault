import { AuthVerdict, ExtractedCodeSchema, MessageAuthSchema } from "@mailvault/shared";
import { z } from "zod";
import { domainsAlign, registrableDomain } from "../mail/auth";
import { extractOtp } from "../mail/otp";
import type { ProviderPolicy } from "./providers";

export function normalizeMailbox(value: string | null): string | null {
  if (!value || value.length > 500 || /[\r\n,;]/.test(value)) return null;
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/.exec(value.trim());
  const address = (match?.[1] ?? match?.[2])?.trim().toLowerCase();
  return address && /^[^\s@<>]+@[a-z0-9.-]+$/.test(address) ? address : null;
}

export function trustedSender(from: string | null, authJson: string | null, policy: ProviderPolicy): boolean {
  const address = normalizeMailbox(from);
  if (!address || !policy.headerFrom.includes(address) || !authJson || authJson.length > 16_384) return false;
  try {
    const auth = MessageAuthSchema.parse(JSON.parse(authJson));
    const fromDomain = address.split("@")[1]!;
    return auth.verdict === AuthVerdict.Trusted && auth.alignedPass.dkim && auth.evidence.some((item) =>
      item.mechanism === "dkim" && item.outcome === "pass" && item.aligned &&
      item.source === "cryptographic-verifier" && !!item.domain &&
      policy.dkimDomains.includes(item.domain) &&
      domainsAlign(registrableDomain(item.domain), registrableDomain(fromDomain)));
  } catch { return false; }
}

export function classifyLoginCode(subject: string, text: string, storedJson: string | null, policy: ProviderPolicy):
  { state: "found"; code: string } | { state: "pending" | "ambiguous" | "untrusted" } {
  if (!storedJson || storedJson.length > 8192 || subject.length > 500 || text.length > 65_536) return { state: "untrusted" };
  const content = `${subject}\n${text}`;
  if (policy.reject.test(content) || !policy.loginSubject.test(subject) || !policy.loginBody.test(text)) return { state: "pending" };
  try {
    const stored = z.array(ExtractedCodeSchema).max(6).parse(JSON.parse(storedJson));
    const extracted = extractOtp(content);
    const codes = new Set(extracted.filter((code) => code.kind === "numeric" &&
      policy.codeLengths.includes(code.length) && code.confidence >= policy.minimumConfidence &&
      /^[0-9]+$/.test(code.value) && code.value.length === code.length &&
      stored.some((item) => item.value === code.value && item.kind === code.kind &&
        item.length === code.length && item.confidence >= policy.minimumConfidence)).map((code) => code.value));
    if (codes.size > 1) return { state: "ambiguous" };
    return codes.size === 1 ? { state: "found", code: [...codes][0]! } : { state: "pending" };
  } catch { return { state: "untrusted" }; }
}
