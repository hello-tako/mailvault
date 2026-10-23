# MAILVAULT-SENDER-AUTH-V1: verified DKIM at inbound ingest

Inbound DKIM is now verified cryptographically during staging, and that result decides `TRUSTED`.
SPF, DMARC and ARC are still not certified. This page defines what `TRUSTED`, `UNVERIFIED` and
`SPOOFED` mean now.

## Flow

```text
raw RFC 822 bytes (the bytes written to R2, unchanged)
  -> verifyDkim()                       apps/worker/src/mail/dkim.ts
  -> VerifiedAuthEvidence[]             source = cryptographic-verifier
  -> assessAuth({ verifiedEvidence })   apps/worker/src/mail/auth.ts (rules unchanged)
  -> stage decision: edge reject only for SPOOFED
  -> staged R2 record gains verifiedAuthEvidence
  -> commitIngest() writes verdict and auth_json to D1 from the staged record only
```

Verification runs once, in `stageEmail()`. `commitIngest()` never verifies again. A D1 failure, a
queue retry, a replay or a reconciliation therefore produces the same verdict and the same
`auth_json`, and does not query DNS.

## Verifier

- `mailauth@7.1.1` with the existing pnpm patch, called as
  `dkimVerify(bytes, { strict: true, rejectRsaSha1: true, resolver })`. Canonicalization, hashing
  and signature checks belong to mailauth and are not reimplemented here.
- The input is the exact bytes MailVault received. They are not parsed, normalized or re-serialized.
- Each DKIM-Signature yields one evidence item: `mechanism: dkim`, `source: cryptographic-verifier`,
  and `domain` set to the verified `d=` (lower-case ASCII). The outcome comes from mailauth's result:

| mailauth result                            | evidence outcome                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `pass`                                     | `pass`, except `neutral` for a testing key (`t=y`) or an `l=` tag that leaves body bytes unsigned |
| `fail`                                     | `fail`                                                                                            |
| `neutral` (no key, syntax error, skipped)  | `neutral`                                                                                         |
| `none` (message not signed)                | `none`                                                                                            |
| `temperror` (DNS failure)                  | `temperror`                                                                                       |
| `permerror`, `policy` (RSA-SHA1, weak key) | `permerror`                                                                                       |
| any other value                            | dropped; never coerced to `pass`                                                                  |

The `t=y` rule follows RFC 6376 section 3.6.1. The `l=` rule follows RFC 6376 section 8.2.

Import path: `mailauth/lib/dkim/verify`, the DKIM entry point of the same pinned file that the
compat suite runs. The package root also loads SPF, DMARC, ARC, BIMI, MTA-STS and the CLI, which
would take the bundle to 5043 KiB (see Bundle size).

## DNS

- Production uses `node:dns` `promises.resolveTxt()`. The generic `resolve()` is not used.
- `boundedTxtResolver` answers only `TXT` and fails closed for other types. It refuses names that
  cannot be DKIM names without querying. It deduplicates names within one message and keeps no
  cache beyond that message. Each lookup times out after 2 seconds. An answer with more than 4 TXT
  records, or with a record longer than 4096 characters, is refused.

| Bound                             | Value | Reason                                                                                                 |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| DKIM-Signature fields per message | 8     | Counted before mailauth parses. Over the limit, nothing is verified. Limits CPU and DNS amplification. |
| Distinct DNS names per message    | 8     | Signatures that share a key share one lookup.                                                          |
| Per-lookup timeout                | 2 s   | A slow resolver cannot hold the stage open.                                                            |
| Whole-verification deadline       | 10 s  | A verification still running at the deadline produces no evidence.                                     |
| TXT records per answer            | 4     |                                                                                                        |
| Characters per TXT record         | 4096  | Far above any DKIM key record in use.                                                                  |

## Alignment

Alignment is not reimplemented. `assessAuth()` compares each verified `d=` with the header From
using `registrableDomain()` and `domainsAlign()`, so relaxed subdomain alignment is unchanged.

- A valid signature from an unrelated domain is a pass that does not align, and the message is
  `UNVERIFIED`.
- Several signatures: one aligned pass is enough, and an unaligned pass does not cover an aligned
  failure. No "best-looking signature" rule applies.
- When the From domain cannot be established (for example a parse-degraded message), nothing
  aligns, so nothing is `TRUSTED`.

## What the verdicts mean

- **TRUSTED**: at least one verified DKIM pass whose `d=` aligns with the header From. No other path
  produces it.
- **UNVERIFIED**: anything else that is not `SPOOFED`. That covers missing or invalid signatures,
  unaligned passes, unsigned mail, RSA-SHA1, and every verifier or DNS failure. Infrastructure
  failures never become `SPOOFED`, and the message is still delivered.
- **SPOOFED**: unchanged. Only a verified, aligned DMARC failure produces it. A failed DKIM signature
  does not, and no verified DMARC producer exists, so inbound mail cannot produce `SPOOFED` yet.

`AuthPolicy.REJECT` is unchanged. Edge rejection still happens only for `SPOOFED`, so a missing,
failed or unaligned DKIM signature never causes a rejection.

## Observations are not evidence

`Authentication-Results` and `Authentication-Results-IANA` are sender-controlled. They are stored
as observations with `source: message-header` and never become verified evidence, even when the
named reporter is a receiver. The integration tests cover a forged aligned result combined with a
real unaligned signature.

## Storage and API

- `auth_json` evidence carries `source`: `message-header`, `cryptographic-verifier` or
  `trusted-runtime-metadata`. The shared schema reads a missing `source` as `message-header`, the
  conservative reading. A missing source is never read as trusted.
- Stored evidence is capped at 8 items. Verifier items come first, so the cap cannot hide the
  evidence a verdict rests on.
- No database migration is needed, because `auth_json` is JSON.
- Staged records written before this change have no `verifiedAuthEvidence`. They commit as
  `UNVERIFIED`.

## Bundle size

Measured with `pnpm --filter @mailvault/worker build` (dry run, unminified, as CI reports it):

| Build                                 | Upload      | Gzip        |
| ------------------------------------- | ----------- | ----------- |
| Before (foundation, no DKIM ingest)   | 1497.96 KiB | 313.18 KiB  |
| After, DKIM entry point (this change) | 3182.83 KiB | 774.40 KiB  |
| After, package root import (rejected) | 5043.22 KiB | 1125.41 KiB |

Delta for this change: +1684.87 KiB upload and +461.22 KiB gzip. The deploy job builds with
`--minify`; that build measures 1971.74 KiB upload and 654.37 KiB gzip (no minified baseline was
taken).

Nearly all of the delta is mailauth's own DKIM dependency closure. `lib/tools.js` requires `libmime`
(with `iconv-lite` and `encoding-japanese`, about 940 KiB unminified), `joi` and `tldts` 7, and the
verifier requires the `nodemailer` address parser. Trimming that means changing mailauth's require
graph, which this change does not do.

## Logging

Logged: event names, reason categories (`deadline`, `too_many_signatures`, `verifier_error`), counts
and the final verdict. Never logged: message bodies, OTPs, raw headers, signature bytes, DNS answers
or key material.

## Not certified

- SPF and DMARC: no independently verified SMTP source-IP or runtime provenance exists here.
- ARC: no verifier is wired in.
- Production deployment, D1 or R2 mutation and DNS changes: none were made by this work.

## Tests

- `test/unit/dkim.test.ts`: aligned RSA-SHA256 and Ed25519 passes; bit flip, body tamper, From
  tamper, wrong key, missing key, RSA-SHA1, testing key, partial `l=`; unaligned pass; forged header
  plus unaligned pass; multiple signatures in both directions; DNS error, timeout and deadline;
  signature-count bound; lookup dedupe; resolver bounds.
- `test/integration/sender-auth.integration.test.ts`: TRUSTED through staging and commit; no lookup
  after staging, through commit, queue retry, replay and a partial commit; DNS failure stored as
  `UNVERIFIED`; a legacy staged record without verifier output; forged header plus an unaligned real
  pass; the stored evidence bound.
- `test/compat/mailauth-workerd.test.ts`: unchanged; the same nine cases under workerd.
