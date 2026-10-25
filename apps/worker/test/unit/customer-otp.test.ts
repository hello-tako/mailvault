import { describe, expect, it } from "vitest";
import { extractOtp } from "../../src/mail/otp";
import { assessAuth } from "../../src/mail/auth";
import { classifyLoginCode, normalizeMailbox, trustedSender } from "../../src/customer-otp/classify";
import { OtpRpcRequestSchema } from "../../src/customer-otp/contracts";
import { providerPolicy, DENIED_PURPOSE, type ProviderPolicy } from "../../src/customer-otp/providers";

export const syntheticPolicy: ProviderPolicy = {
  providerKey: "synthetic", enabled: true, headerFrom: ["login@example.test"], dkimDomains: ["example.test"],
  loginSubject: /^Your sign-in code$/, loginBody: /^Use this code to sign in \d{6}(?:\n|$)/,
  reject: DENIED_PURPOSE, codeLengths: [6], minimumConfidence: 1, maxCodeAgeSeconds: 120, maxMessages: 20,
};
const subject = "Your sign-in code", body = "Use this code to sign in 593821";
const stored = JSON.stringify(extractOtp(`${subject}\n${body}`));
const auth = () => assessAuth({ authResults: [], headerFrom: "login@example.test", envelopeFrom: "login@example.test",
  verifiedEvidence: [{ mechanism: "dkim", outcome: "pass", domain: "example.test", source: "cryptographic-verifier" }] });

describe("customer OTP classification and trust", () => {
  it("selects exactly one high-confidence login code", () => expect(classifyLoginCode(subject, body, stored, syntheticPolicy)).toEqual({ state: "found", code: "593821" }));
  it.each(["Password reset", "Account recovery", "Changed password", "billing invoice", "cancel payment", "密码重置", "パスワード復旧", "Khôi phục mật khẩu"])("rejects purpose %s", (purpose) => {
    const text = `${body}\n${purpose}`;
    expect(classifyLoginCode(subject, text, JSON.stringify(extractOtp(`${subject}\n${text}`)), syntheticPolicy).state).toBe("pending");
  });
  it("rejects digits and order numbers without reviewed login template", () => expect(classifyLoginCode("Order 593821", "593821", stored, syntheticPolicy).state).toBe("pending"));
  it("fails ambiguous when two codes compete", () => {
    const text = `${body}\nUse this code to sign in 482716`;
    expect(classifyLoginCode(subject, text, JSON.stringify(extractOtp(`${subject}\n${text}`)), syntheticPolicy).state).toBe("ambiguous");
  });
  it.each(["{", "null", "{}", '[{"value":593821}]', '[{"value":"593821","kind":"numeric","length":6,"confidence":2}]'])("rejects malformed stored data", (json) => expect(classifyLoginCode(subject, body, json, syntheticPolicy).state).toBe("untrusted"));
  it("requires code corroboration by extraction", () => expect(classifyLoginCode(subject, body, "[]", syntheticPolicy).state).toBe("pending"));
  it("requires body-wide classification without truncation", () => expect(classifyLoginCode(subject, "x".repeat(65537), stored, syntheticPolicy).state).toBe("untrusted"));
  it("accepts independently verified aligned allowed DKIM", () => expect(trustedSender("Provider <login@example.test>", JSON.stringify(auth()), syntheticPolicy)).toBe(true));
  it.each(["message-header", "trusted-runtime-metadata"])("does not trust %s claims", (source) => {
    const value = auth(); value.evidence[0]!.source = source as typeof value.evidence[number]["source"];
    expect(trustedSender("login@example.test", JSON.stringify(value), syntheticPolicy)).toBe(false);
  });
  it.each(["UNVERIFIED", "SPOOFED"])("rejects verdict %s", (verdict) => expect(trustedSender("login@example.test", JSON.stringify({ ...auth(), verdict }), syntheticPolicy)).toBe(false));
  it("rejects wrong sender", () => expect(trustedSender("other@example.test", JSON.stringify(auth()), syntheticPolicy)).toBe(false));
  it("rejects wrong signing domain", () => { const value = auth(); value.evidence[0]!.domain = "other.test"; expect(trustedSender("login@example.test", JSON.stringify(value), syntheticPolicy)).toBe(false); });
  it("rejects SPF alone even if verdict trusted", () => { const value = auth(); value.evidence[0]!.mechanism = "spf"; expect(trustedSender("login@example.test", JSON.stringify(value), syntheticPolicy)).toBe(false); });
  it("does not infer trust from Authentication-Results", () => {
    const value = assessAuth({ authResults: ["mx.test; dkim=pass header.d=example.test"], headerFrom: "login@example.test", envelopeFrom: "login@example.test" });
    expect(trustedSender("login@example.test", JSON.stringify(value), syntheticPolicy)).toBe(false);
  });
  it.each(["a@example.test, login@example.test", "login@example.test\n", "a <login@example.test>;b", "a <login@example.test> <other@test>"])("rejects ambiguous mailbox %s", (mailbox) => expect(normalizeMailbox(mailbox)).toBe(null));
  it("keeps all real providers disabled including unknown/prototype keys", () => {
    for (const name of ["muse", "synthetic", "constructor", "__proto__", "unknown"]) expect(providerPolicy(name)).toBe(null);
  });
  it("enforces the strict bounded signed input schema", () => expect(OtpRpcRequestSchema.safeParse({ v: 1, aliasId: "victim", email: "extra@test" }).success).toBe(false));
});
