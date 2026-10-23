import { describe, expect, it } from "vitest";
import { AuthVerdict } from "@mailvault/shared";
import {
  AuthOutcome,
  assessAuth,
  domainsAlign,
  registrableDomain,
  type AuthMechanism,
  type VerifiedAuthEvidence,
} from "../../src/mail/auth";

function verified(
  mechanism: AuthMechanism,
  outcome: AuthOutcome,
  domain: string,
): VerifiedAuthEvidence {
  return { mechanism, outcome, domain, source: "cryptographic-verifier" };
}

describe("sender authentication provenance", () => {
  it("does not trust a forged aligned pass from a sender-controlled header", () => {
    const assessment = assessAuth({
      authResults: [
        "attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      ],
      headerFrom: "Security <security@example.com>",
      envelopeFrom: "bounce@attacker.invalid",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.evidence[0]).toMatchObject({ source: "message-header", aligned: true });
    expect(assessment.alignedPass.dkim).toBe(false);
  });

  it("does not treat an untrusted forged DMARC failure as authoritative spoofing", () => {
    const assessment = assessAuth({
      authResults: ["attacker.invalid; dmarc=fail header.from=example.com"],
      headerFrom: "Security <security@example.com>",
      envelopeFrom: "bounce@attacker.invalid",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
  });

  it("does not trust a reporter name that resembles a receiver", () => {
    const assessment = assessAuth({
      authResults: [
        "cloudflare.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      ],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
  });

  it("trusts an aligned DKIM pass only when supplied as separately verified evidence", () => {
    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [verified("dkim", AuthOutcome.Pass, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@forwarder.invalid",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
    expect(assessment.alignedPass.dkim).toBe(true);
    expect(assessment.evidence[0]?.source).toBe("cryptographic-verifier");
  });

  it("trusts an aligned DMARC pass only when supplied as separately verified evidence", () => {
    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [verified("dmarc", AuthOutcome.Pass, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
    expect(assessment.alignedPass.dmarc).toBe(true);
  });

  it("uses a verified aligned DMARC failure as authoritative spoofing evidence", () => {
    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [verified("dmarc", AuthOutcome.Fail, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@attacker.invalid",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Spoofed);
  });

  it("keeps forwarded mail trusted when a verified aligned DKIM pass survives SPF failure", () => {
    const assessment = assessAuth({
      authResults: ["forwarder.invalid; spf=fail smtp.mailfrom=forwarder.invalid"],
      verifiedEvidence: [verified("dkim", AuthOutcome.Pass, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "forwarder@forwarder.invalid",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
    expect(assessment.envelopeMismatch).toBe(true);
  });

  it("does not trust an unaligned verified DKIM pass", () => {
    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [verified("dkim", AuthOutcome.Pass, "other.example")],
      headerFrom: "security@target.example",
      envelopeFrom: "bounce@other.example",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.alignedPass.dkim).toBe(false);
  });

  it("keeps a temporary verifier failure unverified despite forged aligned results", () => {
    const assessment = assessAuth({
      authResults: ["cloudflare.com; dkim=pass header.d=example.com"],
      verifiedEvidence: [verified("dkim", AuthOutcome.TempError, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.dkim).toBe(AuthOutcome.TempError);
  });

  it("discards an unknown evidence producer instead of crediting its aligned pass", () => {
    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [
        { ...verified("dkim", AuthOutcome.Pass, "example.com"), source: "message-header" },
      ] as unknown as VerifiedAuthEvidence[],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.evidence).toEqual([]);
  });

  it("keeps a verified DMARC failure authoritative despite a verified DKIM pass", () => {
    const assessment = assessAuth({
      authResults: ["cloudflare.com; dmarc=pass header.from=example.com"],
      verifiedEvidence: [
        verified("dkim", AuthOutcome.Pass, "example.com"),
        verified("dmarc", AuthOutcome.Fail, "example.com"),
      ],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Spoofed);
    expect(assessment.dmarc).toBe(AuthOutcome.Fail);
  });

  it("does not let forged failures override a separately verified aligned pass", () => {
    const assessment = assessAuth({
      authResults: [
        "cloudflare.com; dkim=fail header.d=example.com; dmarc=fail header.from=example.com",
      ],
      verifiedEvidence: [verified("dkim", AuthOutcome.Pass, "example.com")],
      headerFrom: "security@example.com",
      envelopeFrom: "bounce@example.com",
    });

    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
    expect(assessment.dkim).toBe(AuthOutcome.Pass);
  });

  it("keeps missing and malformed results unverified", () => {
    for (const authResults of [[], [";;; not an authentication result ;;;"]]) {
      const assessment = assessAuth({
        authResults,
        headerFrom: "security@example.com",
        envelopeFrom: "bounce@example.com",
      });
      expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    }
  });
});

describe("public suffix alignment", () => {
  it("separates tenants beneath private suffixes and suffixes absent from the former table", () => {
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("bob.github.io")).toBe("bob.github.io");
    expect(registrableDomain("tenant-a.onrender.com")).toBe("tenant-a.onrender.com");
    expect(registrableDomain("tenant-b.onrender.com")).toBe("tenant-b.onrender.com");
    expect(
      domainsAlign(
        registrableDomain("tenant-a.onrender.com"),
        registrableDomain("tenant-b.onrender.com"),
      ),
    ).toBe(false);
  });

  it("handles uncommon public suffixes, sibling domains, lookalikes, and relaxed subdomain alignment", () => {
    expect(registrableDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("mail.example.com.vn")).toBe("example.com.vn");
    expect(registrableDomain("mail.example.co.jp")).toBe("example.co.jp");
    expect(
      domainsAlign(registrableDomain("a.example.co.uk"), registrableDomain("b.example.co.uk")),
    ).toBe(true);
    expect(domainsAlign("a.example.co.uk", "b.example.co.uk")).toBe(false);
    expect(domainsAlign("example.co.uk", "example.co.uk.evil.com")).toBe(false);
    expect(domainsAlign("example.com", "notexample.com")).toBe(false);
  });

  it("normalizes IDN and punycode domains to the same registrable domain", () => {
    expect(registrableDomain("mail.bücher.de")).toBe("xn--bcher-kva.de");
    expect(
      domainsAlign(registrableDomain("mail.xn--bcher-kva.de"), registrableDomain("bücher.de")),
    ).toBe(true);

    const assessment = assessAuth({
      authResults: [],
      verifiedEvidence: [verified("dkim", AuthOutcome.Pass, "xn--bcher-kva.de")],
      headerFrom: "security@mail.bücher.de",
      envelopeFrom: "bounce@example.net",
    });
    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
  });
});
