import { describe, expect, it } from "vitest";
import { AuthVerdict } from "@mailvault/shared";
import {
  AuthOutcome,
  assessAuth,
  bareDomain,
  domainsAlign,
  registrableDomain,
} from "../../src/mail/auth";

const NETFLIX_AR =
  "mx.netflix.com; spf=pass (domain: netflix.com) smtp.mailfrom=returns.netflix.com; dkim=pass header.d=netflix.com; dmarc=pass (p=none dis=none) header.from=netflix.com";

function assess(authResults: string[], headerFrom: string, envelopeFrom: string) {
  return assessAuth({ authResults, headerFrom, envelopeFrom });
}

describe("sender-auth evidence provenance", () => {
  it("records an aligned pass from the message but does not trust its provenance", () => {
    const a = assess([NETFLIX_AR], "Netflix <no-reply@netflix.com>", "bounce@returns.netflix.com");
    expect(a.verdict).toBe(AuthVerdict.Unverified);
    expect(a.dmarc).toBe(AuthOutcome.Pass);
    expect(a.dkim).toBe(AuthOutcome.Pass);
    expect(a.alignedPass.dmarc).toBe(false);
    expect(a.envelopeMismatch).toBe(false);
  });

  it("does NOT trust a self-authored Authentication-Results header", () => {
    // Alignment does not make a sender-authored result trustworthy.
    const a = assess(
      ["evil.example; spf=pass smtp.mailfrom=evil.example; dkim=pass header.d=evil.example"],
      "Netflix <security@genuine-netflix-verify.com>",
      "spam@evil.example",
    );
    expect(a.verdict).not.toBe(AuthVerdict.Trusted);
    expect(a.dkim).toBe(AuthOutcome.Pass); // reported as observed...
    expect(a.evidence[0]?.aligned).toBe(false);
    expect(a.alignedPass.dkim).toBe(false);
  });

  it("does not treat an untrusted dmarc=fail as authoritative spoofing", () => {
    const a = assess(
      [
        "mailer.x; dkim=pass header.d=other.org; dmarc=fail (p=reject dis=none) header.from=netflix.com",
      ],
      "Netflix <security@netflix.com>",
      "bounce@mailer.x",
    );
    expect(a.verdict).toBe(AuthVerdict.Unverified);
    expect(a.dmarc).toBe(AuthOutcome.Fail);
  });

  it("does not trust raw forwarded results even when DKIM is aligned", () => {
    const a = assess(
      [
        "forwarder.example; spf=fail smtp.mailfrom=netflix.com",
        "mx.googleapis.com; dkim=pass header.d=netflix.com; dmarc=pass header.from=netflix.com",
      ],
      "Netflix <no-reply@netflix.com>",
      "me@forwarder.example",
    );
    expect(a.verdict).toBe(AuthVerdict.Unverified);
    expect(a.spf).toBe(AuthOutcome.Fail); // reported honestly, but not the trust signal
    expect(a.envelopeMismatch).toBe(true);
  });

  it("reports unverified, never spoofed, when Cloudflare gave us no results at all", () => {
    const a = assess([], "someone@example.com", "someone@example.com");
    expect(a.verdict).toBe(AuthVerdict.Unverified);
    expect(a.observed).toBe(false);
  });

  it("survives malformed header values", () => {
    const a = assess(
      [";;; totally not rfc 8601 ;;;", "mx; spf=weird smtp.mailfrom="],
      "x@example.com",
      "y@example.com",
    );
    expect(a.evidence.length).toBeLessThanOrEqual(1);
    expect(a.verdict).toBe(AuthVerdict.Unverified);
  });
});

describe("domain comparison", () => {
  it("aligns subdomains and rejects look-alikes", () => {
    expect(domainsAlign("mail.netflix.com", "netflix.com")).toBe(true);
    expect(domainsAlign("netflix.com", "netflix.com")).toBe(true);
    expect(domainsAlign("notnetflix.com", "netflix.com")).toBe(false);
    expect(domainsAlign("netflix.com.evil.org", "netflix.com")).toBe(false); // look-alike trap
    expect(domainsAlign("evil.netflix.com", "netflix.co")).toBe(false);
  });

  it("keeps multi-part public suffixes intact", () => {
    expect(registrableDomain("mail.antexvn.com.vn")).toBe("antexvn.com.vn");
    expect(registrableDomain("mail.example.co.jp")).toBe("example.co.jp");
    expect(registrableDomain("www.abitovn.com")).toBe("abitovn.com");
    expect(registrableDomain("localhost")).toBeNull();
  });

  it("reads a domain out of display names and angle brackets", () => {
    expect(bareDomain('"Netflix" <no-reply@netflix.com>')).toBe(
      "no-reply@netflix.com".split("@")[1],
    );
    expect(bareDomain("  ")).toBeNull();
    expect(bareDomain(null)).toBeNull();
  });
});
