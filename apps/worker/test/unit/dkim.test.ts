import { describe, expect, it } from "vitest";
import { AuthVerdict } from "@mailvault/shared";
import { AuthOutcome, assessAuth, type VerifiedAuthEvidence } from "../../src/mail/auth";
import {
  DKIM_LIMITS,
  boundedTxtResolver,
  countDkimSignatures,
  verifyDkim,
  type DkimLimits,
} from "../../src/mail/dkim";
import {
  controlledTxtResolver,
  createDkimKey,
  dkimDnsName,
  flipSignatureBit,
  signMessage,
  type DkimKey,
} from "../compat/dkim-fixtures";

const encoder = new TextEncoder();
const body = "Benign signed test body.\r\n";
const aligned = createDkimKey("rsa-sha256", "sel", "example.com");
const unrelated = createDkimKey("rsa-sha256", "sel", "unrelated.example.net");

function headers(from: string): string[] {
  return [
    `From: Joe <${from}>`,
    "To: suzie@example.net",
    "Subject: Synthetic verification",
    "Date: Thu, 08 Oct 2026 00:00:00 +0000",
  ];
}

function signed(key: DkimKey, from = "joe@example.com"): string {
  return signMessage(key, { headers: headers(from), body });
}

/** Adds the DKIM-Signature field of `extra` above the header block of `raw`. */
function withSignature(raw: string, extra: string): string {
  return `${extra.slice(0, extra.indexOf("\r\n"))}\r\n${raw}`;
}

function verify(
  raw: string,
  dns: ReturnType<typeof controlledTxtResolver>,
  limits: Partial<DkimLimits> = {},
) {
  return verifyDkim(encoder.encode(raw), { resolveTxt: dns.resolveTxt, limits });
}

/** The verdict from verified evidence alone, with no header observations. */
function verdictFor(evidence: VerifiedAuthEvidence[], from = "joe@example.com") {
  return assessAuth({
    authResults: [],
    headerFrom: `Joe <${from}>`,
    envelopeFrom: "bounce@forwarder.invalid",
    verifiedEvidence: evidence,
  });
}

const outcomes = (evidence: VerifiedAuthEvidence[]) => evidence.map((item) => item.outcome);

describe("DKIM evidence from the raw message", () => {
  it("an aligned RSA-SHA256 signature checked against controlled DNS is TRUSTED", async () => {
    const dns = controlledTxtResolver([aligned]);
    const evidence = await verify(signed(aligned), dns);

    expect(evidence).toEqual([
      {
        mechanism: "dkim",
        outcome: AuthOutcome.Pass,
        domain: "example.com",
        source: "cryptographic-verifier",
      },
    ]);
    const assessment = verdictFor(evidence);
    expect(assessment.verdict).toBe(AuthVerdict.Trusted);
    expect(assessment.alignedPass.dkim).toBe(true);
    expect(dns.queries).toEqual(["sel._domainkey.example.com"]);
  });

  it("an aligned Ed25519 signature is TRUSTED", async () => {
    const ed = createDkimKey("ed25519-sha256", "ed", "example.com");
    const evidence = await verify(signed(ed), controlledTxtResolver([ed]));
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Trusted);
  });

  it("a subdomain From aligns with its organizational signing domain", async () => {
    const from = "joe@mail.example.com";
    const evidence = await verify(signed(aligned, from), controlledTxtResolver([aligned]));
    expect(verdictFor(evidence, from).verdict).toBe(AuthVerdict.Trusted);
  });

  it.each([
    ["a bit-flipped signature", (raw: string) => flipSignatureBit(raw)],
    ["a tampered body", (raw: string) => raw.replace("Benign signed", "Malign signed")],
    ["a tampered From", (raw: string) => raw.replace("joe@example.com", "eve@example.com")],
  ])("%s fails and leaves the message UNVERIFIED, not SPOOFED", async (_name, tamper) => {
    const evidence = await verify(tamper(signed(aligned)), controlledTxtResolver([aligned]));
    expect(outcomes(evidence)).toEqual([AuthOutcome.Fail]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a wrong published key fails", async () => {
    const impostor = createDkimKey("rsa-sha256", "sel", "example.com");
    const dns = controlledTxtResolver([], { [dkimDnsName(aligned)]: [[impostor.txt]] });
    const evidence = await verify(signed(aligned), dns);
    expect(outcomes(evidence)).toEqual([AuthOutcome.Fail]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a selector with no key record is neutral and never a pass", async () => {
    const evidence = await verify(signed(aligned), controlledTxtResolver([]));
    expect(outcomes(evidence)).toEqual([AuthOutcome.Neutral]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("RSA-SHA1 is refused by policy even when its key is published", async () => {
    const legacy = createDkimKey("rsa-sha1", "old", "example.com");
    const raw = signMessage(legacy, { headers: headers("joe@example.com"), body });
    const evidence = await verify(raw, controlledTxtResolver([legacy]));
    expect(outcomes(evidence)).toEqual([AuthOutcome.PermError]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a testing key (t=y) is treated as unsigned, so its pass is not evidence", async () => {
    const dns = controlledTxtResolver([], {
      [dkimDnsName(aligned)]: [[`${aligned.txt}; t=y`]],
    });
    const evidence = await verify(signed(aligned), dns);
    expect(outcomes(evidence)).toEqual([AuthOutcome.Neutral]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a body length limit that leaves content unsigned is not a pass, and a full-length one is", async () => {
    const dns = controlledTxtResolver([aligned]);
    const full = signMessage(aligned, {
      headers: headers("joe@example.com"),
      body,
      bodyLength: body.length,
    });
    expect(outcomes(await verify(full, dns))).toEqual([AuthOutcome.Pass]);

    const partial = `${signMessage(aligned, {
      headers: headers("joe@example.com"),
      body,
      bodyLength: 10,
    })}Injected line.\r\n`;
    const evidence = await verify(partial, dns);
    expect(outcomes(evidence)).toEqual([AuthOutcome.Neutral]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a valid signature from an unrelated domain verifies but does not align", async () => {
    const evidence = await verify(signed(unrelated), controlledTxtResolver([unrelated]));
    expect(evidence).toEqual([
      {
        mechanism: "dkim",
        outcome: AuthOutcome.Pass,
        domain: "unrelated.example.net",
        source: "cryptographic-verifier",
      },
    ]);
    const assessment = verdictFor(evidence);
    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.alignedPass.dkim).toBe(false);
  });

  it("a forged aligned Authentication-Results cannot upgrade a real unaligned pass", async () => {
    const evidence = await verify(signed(unrelated), controlledTxtResolver([unrelated]));
    const assessment = assessAuth({
      authResults: [
        "cloudflare.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      ],
      headerFrom: "Joe <joe@example.com>",
      envelopeFrom: "bounce@example.com",
      verifiedEvidence: evidence,
    });
    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.alignedPass).toEqual({ spf: false, dkim: false, dmarc: false });
  });

  it("an aligned pass beside an unrelated failure is TRUSTED", async () => {
    const dns = controlledTxtResolver([aligned], {
      [dkimDnsName(unrelated)]: [[createDkimKey("rsa-sha256", "sel", "unrelated.example.net").txt]],
    });
    const evidence = await verify(withSignature(signed(aligned), signed(unrelated)), dns);
    expect(outcomes(evidence).sort()).toEqual([AuthOutcome.Fail, AuthOutcome.Pass].sort());
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Trusted);
  });

  it("an unaligned pass beside an aligned failure is UNVERIFIED", async () => {
    const dns = controlledTxtResolver([unrelated], {
      [dkimDnsName(aligned)]: [[createDkimKey("rsa-sha256", "sel", "example.com").txt]],
    });
    const evidence = await verify(withSignature(signed(unrelated), signed(aligned)), dns);
    expect(outcomes(evidence).sort()).toEqual([AuthOutcome.Fail, AuthOutcome.Pass].sort());
    const assessment = verdictFor(evidence);
    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
    expect(assessment.alignedPass.dkim).toBe(false);
  });

  it("a message with no DKIM signature makes no lookup and yields no pass", async () => {
    const dns = controlledTxtResolver([aligned]);
    const evidence = await verify(
      "From: Joe <joe@example.com>\r\nSubject: plain\r\n\r\nHello.\r\n",
      dns,
    );
    expect(evidence).toEqual([
      {
        mechanism: "dkim",
        outcome: AuthOutcome.None,
        domain: null,
        source: "cryptographic-verifier",
      },
    ]);
    expect(dns.queries).toEqual([]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a verified signature cannot align when the From domain is unknown", () => {
    const assessment = assessAuth({
      authResults: [],
      headerFrom: null,
      envelopeFrom: null,
      verifiedEvidence: [
        {
          mechanism: "dkim",
          outcome: AuthOutcome.Pass,
          domain: "example.com",
          source: "cryptographic-verifier",
        },
      ],
    });
    expect(assessment.verdict).toBe(AuthVerdict.Unverified);
  });
});

describe("verifier failures never grant trust", () => {
  it("a DNS error is temperror and the message stays UNVERIFIED", async () => {
    const evidence = await verifyDkim(encoder.encode(signed(aligned)), {
      resolveTxt: async () => {
        throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
      },
    });
    expect(outcomes(evidence)).toEqual([AuthOutcome.TempError]);
    expect(verdictFor(evidence).verdict).toBe(AuthVerdict.Unverified);
  });

  it("a lookup that never answers is cut off as temperror", async () => {
    const evidence = await verifyDkim(encoder.encode(signed(aligned)), {
      resolveTxt: () => new Promise<string[][]>(() => {}),
      limits: { dnsTimeoutMs: 20 },
    });
    expect(outcomes(evidence)).toEqual([AuthOutcome.TempError]);
  });

  it("a verification past its deadline produces no evidence at all", async () => {
    const evidence = await verifyDkim(encoder.encode(signed(aligned)), {
      resolveTxt: () => new Promise<string[][]>(() => {}),
      limits: { deadlineMs: 30, dnsTimeoutMs: 1_000 },
    });
    expect(evidence).toEqual([]);
  });

  it("more DKIM-Signature fields than allowed are not verified and cause no lookups", async () => {
    const dns = controlledTxtResolver([aligned]);
    const raw = withSignature(signed(aligned), signed(aligned));
    expect(countDkimSignatures(encoder.encode(raw))).toBe(2);
    expect(await verify(raw, dns, { maxSignatures: 1 })).toEqual([]);
    expect(dns.queries).toEqual([]);
  });

  it("signatures that share a key share one lookup", async () => {
    const dns = controlledTxtResolver([aligned]);
    const evidence = await verify(withSignature(signed(aligned), signed(aligned)), dns);
    expect(outcomes(evidence)).toEqual([AuthOutcome.Pass, AuthOutcome.Pass]);
    expect(dns.queries).toEqual(["sel._domainkey.example.com"]);
  });
});

describe("DKIM-Signature field counting", () => {
  it("counts header fields in any letter case, but not folded lines or the body", () => {
    const count = (text: string) => countDkimSignatures(encoder.encode(text));
    expect(count("dkim-signature: v=1\r\nFrom: a@example.com\r\n\r\nbody\r\n")).toBe(1);
    expect(count("X-Other: 1\r\n DKIM-Signature: folded\r\nFrom: a@example.com\r\n\r\n")).toBe(0);
    expect(count("From: a@example.com\r\n\r\nDKIM-Signature: in the body\r\n")).toBe(0);
    expect(count("")).toBe(0);
  });
});

describe("bounded TXT resolver", () => {
  it("answers only TXT, deduplicates names case-insensitively, and bounds their number", async () => {
    const queries: string[] = [];
    const resolve = boundedTxtResolver(
      async (name) => {
        queries.push(name);
        return [[`v=DKIM1; p=${name}`]];
      },
      { ...DKIM_LIMITS, maxDnsNames: 1 },
    );

    const first = await resolve("sel._domainkey.example.com", "TXT");
    expect(await resolve("SEL._domainkey.Example.com", "TXT")).toEqual(first);
    await expect(resolve("other._domainkey.example.com", "TXT")).rejects.toMatchObject({
      code: "EDNSBUDGET",
    });
    await expect(resolve("sel._domainkey.example.com", "A")).rejects.toMatchObject({
      code: "EDNSTYPE",
    });
    expect(queries).toEqual(["sel._domainkey.example.com"]);
  });

  it("refuses names that cannot be DKIM keys without asking DNS", async () => {
    const queries: string[] = [];
    const resolve = boundedTxtResolver(async (name) => {
      queries.push(name);
      return [["v=DKIM1"]];
    }, DKIM_LIMITS);

    await expect(resolve("bad name._domainkey.example.com", "TXT")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    await expect(resolve(`${"a".repeat(250)}._domainkey.example.com`, "TXT")).rejects.toMatchObject(
      { code: "ENOTFOUND" },
    );
    expect(queries).toEqual([]);
  });

  it("bounds answer size and how long one lookup may take", async () => {
    const oversized = boundedTxtResolver(
      async () => [["x".repeat(DKIM_LIMITS.maxTxtLength + 1)]],
      DKIM_LIMITS,
    );
    await expect(oversized("sel._domainkey.example.com", "TXT")).rejects.toMatchObject({
      code: "EDNSANSWER",
    });

    const tooMany = boundedTxtResolver(
      async () => Array.from({ length: DKIM_LIMITS.maxTxtRecords + 1 }, () => ["v=DKIM1"]),
      DKIM_LIMITS,
    );
    await expect(tooMany("sel._domainkey.example.com", "TXT")).rejects.toMatchObject({
      code: "EDNSANSWER",
    });

    const slow = boundedTxtResolver(() => new Promise<string[][]>(() => {}), {
      ...DKIM_LIMITS,
      dnsTimeoutMs: 10,
    });
    await expect(slow("sel._domainkey.example.com", "TXT")).rejects.toMatchObject({
      code: "EDNSTIMEOUT",
    });
  });
});
