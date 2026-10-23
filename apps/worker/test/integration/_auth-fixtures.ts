/** Trusted rows in integration fixtures represent evidence supplied outside MIME. */
export function verifiedDkimPassFixture(domain: string): string {
  return JSON.stringify({
    verdict: "TRUSTED",
    spf: null,
    dkim: "pass",
    dmarc: null,
    alignedPass: { spf: false, dkim: true, dmarc: false },
    envelopeMismatch: false,
    observed: true,
    reasons: ["test fixture: independently verified DKIM pass"],
    evidence: [
      {
        mechanism: "dkim",
        outcome: "pass",
        domain,
        aligned: true,
        reporter: null,
        source: "cryptographic-verifier",
      },
    ],
  });
}
