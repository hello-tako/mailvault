# Trusted inbound sender authentication: evidence and design decision

Research date: 2026-10-08. Result: **MAILVAULT_LOCAL_VERIFIER_DESIGN_READY**.
Architectural gate: **Outcome C — MAILVAULT_TRUSTED_RECEIVER_VERDICT_UNAVAILABLE**.
This is a design and regression-test PR, not a verifier implementation or production certification.

## Baseline and scope

Upstream main was fetched and matched certified merge commit
34e7da255fbea4af6e970623ba499c89e53fe022. PR #1 is merged; its independently
reviewed head was ecf1c0141311ffc08d266731c4b0d8006838f8d9. Main push CI
[37720818819](https://github.com/vn-tak/mailvault/actions/runs/37720818819) reports
verify SUCCESS and deploy SKIPPED on that exact merge SHA.

This branch changes tests and documentation only. No production adapter, dependency,
configuration, schema, migration, UI, or ingest algorithm is changed.
**LIVE INBOUND = UNVERIFIED** without separately verified evidence.
Migration 0016 remains authoritative: historical MIME-derived verdicts are not restored.

## Authoritative Cloudflare findings

The legacy Email Routing documentation now redirects to Email Service. References below
use the current canonical URLs, inspected on the research date.

| Question                                                         | Finding and boundary                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Cloudflare authenticate inbound mail?                       | **YES, documented admission checks.** Incoming mail must pass SPF or DKIM; failure of both is rejected. Email Routing also rejects according to the sender's DMARC policy [1]. Admission does not identify which mechanism passed, its domain, or alignment with the visible From. It cannot establish MailVault TRUSTED. |
| SPF, DKIM, DMARC verdict exposed to the Worker?                  | **NO documented field; live behavior UNPROVEN.** The documented message interface has no separate authentication result [2]. No adapter is justified.                                                                                                                                                                     |
| Original SMTP peer IP or HELO/EHLO exposed?                      | **NO documented field; live behavior UNPROVEN.** Neither appears in the documented interface or installed types [2, 3].                                                                                                                                                                                                   |
| Original MAIL FROM exposed separately from visible From?         | **YES.** message.from is the SMTP envelope MAIL FROM; message.to is envelope RCPT TO [2, 3]. This records the observed transaction, not proof that the claimed sender/domain was authenticated.                                                                                                                           |
| Runtime object and context?                                      | from, to, headers, raw, rawSize; methods setReject, forward, reply. Current docs additionally show canBeForwarded; installed types do not. env supplies bindings and ctx supplies waitUntil. None is documented as authenticated From-domain evidence [2, 3].                                                             |
| ARC available?                                                   | Cloudflare documents ARC support for forwarding [1], but no independently verified ARC result is exposed in the reviewed Worker interface. ARC presence alone is not trust.                                                                                                                                               |
| Cloudflare signatures on forwarded mail?                         | Cloudflare documents DKIM signatures for email.cloudflare.net and the recipient domain [1]. These authenticate Cloudflare's forwarding operation, not automatically the original RFC5322.From sender.                                                                                                                     |
| Inbound Authentication-Results inserted, rewritten, or stripped? | **UNPROVEN.** The reviewed sources give no inbound guarantee that attacker-supplied copies are removed, replaced, or isolated. Neither preservation nor stripping is asserted as a verified live fact. Reporter-name allowlisting is prohibited.                                                                          |
| Receiver-owned header guarantee?                                 | **UNPROVEN.** The platform-controlled header rules in [4] concern outbound sending APIs/SMTP, not inbound Worker delivery. They do not establish an inbound trust boundary.                                                                                                                                               |
| Does forward(headers) establish provenance?                      | No. Its custom-header restrictions concern headers supplied for forwarding [2], not removal of forged headers in the incoming MIME.                                                                                                                                                                                       |

Sources:

1. [Cloudflare Postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/),
   updated 2026-06-09: “Mail authentication requirement”, “DMARC enforcing”, DKIM and ARC sections.
2. [Email handler / Workers API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
   updated 2026-06-15: ForwardableEmailMessage, parameters, forwarding and reply constraints.
3. Installed official package **@cloudflare/workers-types 5.20260922.1**, index.d.ts,
   EmailMessage and ForwardableEmailMessage. The repository uses Workers compatibility date
   2026-07-02. The runtime/types discrepancy concerning canBeForwarded is recorded,
   not treated as an undocumented authentication field.
4. [Email headers](https://developers.cloudflare.com/email-service/reference/headers/),
   updated 2026-08-25: outbound allowlist/platform-controlled headers, not inbound sanitization.

No production receiver experiment was performed. **RUNTIME_PROVENANCE_UNVERIFIED**.
Local Miniflare validates application behavior with synthetic input; it cannot prove
Cloudflare's SMTP ingress/header ownership. Missing documentation is not proof that
Cloudflare never creates a header; it is sufficient reason not to trust one.

## Threat model and current executable boundary

The attacker controls MIME, display names, visible From, DKIM-Signature input, arbitrary
Authentication-Results/Authentication-Results-IANA, Received and claimed IP headers.
An aligned forged result claiming cloudflare.com is still an observation.
MIME parsing, admission to the Worker, forwarding eligibility, or envelope reporting
cannot manufacture VerifiedAuthEvidence.

Today, apps/worker/src/mail/ingest.ts stages parsed observations in R2 and calls
assessAuth again at commit without verifiedEvidence. The queue carries ingest references
and envelope values, not the mail body. Neither code path upgrades observations.
Pure assessor tests create explicit verifier fixtures; **these are not real DKIM verification**.

The current assessor credits aligned independently verified passes and gives an aligned
verified DMARC failure precedence over passes. Missing evidence, unaligned DKIM, unknown
producer, and a temporary error alone remain UNVERIFIED. A raw failure cannot override
verified evidence. A “fail” from a local DKIM check alone is not DMARC failure.

## Bounded local-verifier assessment

### DKIM first, but approve an implementation task separately

Technically feasible: Workers documents RSA PKCS#1 v1.5 and Ed25519 verification/import
in [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
Cryptographic primitives are not a complete DKIM verifier. Implementing correct
[RFC 6376](https://www.rfc-editor.org/rfc/rfc6376.html) canonicalization, signed-header
selection, repeated fields, body hashing, key/algorithm constraints, signature timestamps
and expiry, and [RFC 8463](https://www.rfc-editor.org/rfc/rfc8463.html) Ed25519 behavior
requires a reviewed library/wrapper and known-answer vectors in workerd.

Verify **original raw bytes**, before PostalMime decoding or reserialization. Require
a single unambiguous RFC5322.From mailbox; malformed/multiple From or unsafe signature
coverage must not authenticate the displayed sender. Reject weak/unsupported algorithms
and do not let a signature's body-length limit authenticate an unsigned appended body.
Bound multiple signatures; one valid aligned signature can suffice even when other
independent signatures are invalid or unaligned.

Candidate, **not selected or installed**:
[mailauth](https://github.com/postalsys/mailauth), version 7.1.1 from
[versioned npm metadata](https://registry.npmjs.org/mailauth/7.1.1), is MIT licensed,
requires Node >=22.19.0, and has ten direct dependencies. Its upstream documentation
supports DKIM/authentication and a custom DNS resolver.
[Versioned source](https://github.com/postalsys/mailauth/blob/v7.1.1/lib/tools.js)
defaults to dns.resolve and consumes the first TXT record; adapter review must handle
ambiguous/multiple records safely. Its default Node DNS dependency
and Node-oriented implementation are not proof of Workers compatibility.

Production Wrangler currently has no nodejs_compat flag; test/dev configuration does.
[Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
and [DNS support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/)
must be verified against the selected package, not inferred from passing Node tests.
A bounded compatibility spike must inspect transitive dependencies, audit the candidate,
test the exact production compatibility date, measure bundle/CPU/memory, and validate
RSA/Ed25519 and canonicalization vectors. Candidate vulnerability status is **UNVERIFIED**;
the existing lockfile audit does not cover an uninstalled candidate.

If it cannot run correctly inside Workers, prefer a narrowly authenticated adjacent
verifier service over cryptographic shims or a new general-purpose engine. Such a service
needs a separately approved privacy/deployment design; mail cannot be sent to an arbitrary
third party. Its response must bind the raw digest, canonical message ID, verification time,
policy/version and normalized results, authenticated independently of MIME.

### SPF, DMARC and ARC

**SPF_CANNOT_BE_RECONSTRUCTED_CORRECTLY_AT_EMAIL_WORKER_LAYER.**
[RFC 7208](https://www.rfc-editor.org/rfc/rfc7208.html) needs the SMTP connecting IP,
MAIL FROM and HELO/EHLO context. Envelope From alone is insufficient.
Never derive these from Received, X-Originating-IP or X-Forwarded-For.

DMARC consumes verified DKIM/SPF plus From alignment and policy, not a dmarc=pass string.
An aligned verified DKIM pass can establish a DMARC pass under the applicable alignment
mode and valid policy evaluation. When SPF is unavailable, non-passing DKIM cannot
establish a complete DMARC failure: return UNVERIFIED rather than invent SPOOFED.
DNS p=reject is policy, not proof of failure. Keep the maintained tldts private/public PSL
behavior and its sibling-domain tests for MailVault's current alignment assessment;
do not claim that helper alone implements a complete current DMARC policy evaluator.
[RFC 9989](https://www.rfc-editor.org/rfc/rfc9989.html), published May 2026,
obsoletes RFCs 7489/9091; section 4.10 defines DNS-tree-walk Organizational Domain
discovery, including policy/psd handling, instead of relying solely on a PSL.
An implementation must explicitly separate MailVault's requested PSL safeguards
from full current DMARC standards evaluation and budget policy-discovery DNS requests.

[ARC RFC 8617](https://www.rfc-editor.org/rfc/rfc8617.html) verification/trusted-sealer
policy is deferred. Forwarded original DKIM may survive; forwarding that breaks it
without separately trusted evidence remains UNVERIFIED.

### Proposed resource envelope (not implemented or benchmarked)

- Preserve the existing 20 MiB message cap. Verification may skip over-budget messages
  without expanding ingestion limits or rejecting otherwise acceptable mail.
- At most 64 KiB of authentication-relevant headers, five signature candidates,
  ten total DNS queries including bounded policy/key discovery, two concurrent queries,
  and 32 KiB per DNS response. Unfinished discovery yields UNVERIFIED, not a guessed pass/fail.
- Use HTTPS DNS-over-HTTPS to a fixed trusted resolver; safely combine TXT chunks,
  distinguish NXDOMAIN/no key, malformed/revoked key, timeout and SERVFAIL.
  Do not follow arbitrary DNS-derived HTTP URLs. DNS is part of the trust model;
  do not claim DNSSEC authenticity without resolver validation evidence.
- Three-second aggregate verification eligibility deadline. Abort outstanding fetches
  and discard late results; this is not a claim that an in-flight crypto primitive
  can be forcibly cancelled. CPU/memory bounds need workerd benchmarks and platform limits.
- Bounded positive key cache: at most 256 entries, no longer than DNS TTL or five minutes.
  Do not cache a temporary failure as a permanent failure or reuse expired evidence.
- DNS, parser, crypto errors, unsupported inputs and budget exhaustion produce
  UNVERIFIED with generic reason codes; they must not crash ingestion or reject mail.
  Logs may contain IDs, mechanism, source, verdict and generic reason only—no body,
  OTP, links, full headers, DKIM signatures, credentials or attachment names.

## Proposed evidence lifecycle and acceptance contract

These requirements are for the separate implementation, not capabilities shipped here.

1. Verification owns a narrow typed producer. MIME parsing cannot call a public “verified”
   constructor. Use an opaque/branded in-process type and a runtime-validated, versioned
   persistence representation; a TypeScript cast or source string is not a provenance guarantee.
2. Bind normalized evidence to raw SHA-256, canonical message ID, source, verification time,
   verifier/policy version, mechanism, result and signing/alignment domain. Compute cryptographic
   proof from the original bytes, not values claimed in a header.
3. Write the immutable receipt with trusted staged metadata under the existing manifest
   lifecycle **before** queue acceptance. Protect storage/service writes operationally.
   The queue carries the receipt/object reference, never mail content or credentials.
4. Commit validates schema and message/digest binding, then reuses the persisted assessment.
   No DNS re-verification on retry: a DNS/key change must not alter a previously staged verdict.
   Persist “verification unavailable” too; restart must not opportunistically upgrade it.
5. Partial D1 commit, queue replay and duplicate delivery retain the first canonical receipt.
   Do not overwrite it with a different message's proof merely because Message-ID matches.
   Conflicting same-message receipts fail closed; historical mail is not automatically reverified.
6. Normalize complete evidence before assessAuth. A valid second DKIM signature and a failed
   independent signature are not automatically a source conflict. Contradictory complete
   trusted assessments default to UNVERIFIED; only a receiver/verifier-owned **complete,
   high-confidence DMARC failure** may justify SPOOFED. Never choose the friendlier source.
7. Current toStoredAuth truncates evidence to eight entries after collecting MIME observations.
   A future verifier must prioritize/bound verified records so observation floods cannot erase
   provenance, and extend shared AuthEvidenceSchema to retain source/version as appropriate.
   This is an activation prerequisite, not an existing live-adapter fix claimed in this PR.

## Tests and product consequences

Focused suite: **2 files / 25 tests** (16 unit, 9 integration), including ten added cases.

| Threat/contract                                      | Executable coverage and limit                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aligned forged cloudflare.com results                | Integration uses security@target.example and aligned header.d/header.from; ordinary, mixed-case, folded and duplicate headers all remain UNVERIFIED, with alignedPass false.                                                                                           |
| Missing/untrusted/malformed observations             | Existing unit cases remain UNVERIFIED; new unknown-producer test rejects the invalid source. Full wire-metadata validation belongs to the unimplemented adapter.                                                                                                       |
| Aligned/unaligned DKIM; DMARC pass/fail              | Unit verifier fixtures prove assessor mapping: TRUSTED, UNVERIFIED, TRUSTED, SPOOFED respectively. They do not certify a cryptographic engine.                                                                                                                         |
| Temporary verifier failure; conflicting observations | Temporary error plus forged pass stays UNVERIFIED; verified DMARC failure wins over a verified DKIM pass; forged failures cannot override a verified aligned pass.                                                                                                     |
| Partial D1 commit, actual queue retry and replay     | Real Miniflare D1 trigger fails the final core update after message insertion. Queue retries, staged objects remain, then commit and replay retain identical UNVERIFIED/auth_json and one message row. No trusted-evidence persistence is claimed.                     |
| History and PSL                                      | Existing migration-0016 test revokes historical inbound trust, leaving outbound unchanged. Existing unit tests cover private suffixes, sibling domains, IDN and example.co.uk; full verifier acceptance must additionally include example.com.au and strict alignment. |

Separate verifier acceptance must cover RSA/Ed25519 known-answer vectors, simple/relaxed
body/header canonicalization, CRLF/empty-body edge cases, duplicates/folding, signed From,
multiple From/display-name tricks, IDN/trailing-dot/invalid domains, multiple signatures,
expiration, unsafe body-length coverage, DNS TXT chunks/ambiguous answers, revoked/weak keys,
timeouts, contradictory complete trusted evidence, observation floods, and trusted receipt
survival across retries, partial commits, dedupe and Worker restart with changing DNS.

Downstream behavior is unchanged: MessageRow hides inbound previews/codes without TRUSTED;
MessageDetail keeps OTP/links/attachments/body reveal and unsubscribe gated; send.ts retains
UNVERIFIED_PARENT/SPOOFED_PARENT reply refusal. Ingest auth-policy rejection, push and rules
are unchanged. Owner-configured rule effects and sender/subject text are existing explicit
boundaries, not authenticated channels. Any future activation must rerun the UI/push/rules/
reply/auth-policy matrix; this PR makes no UI change and does not unlock conveniences.

## Operator handoff, residuals and production receipt

No privileged access is required to adopt this design. If Cloudflare later claims receiver
metadata or sanitized auth headers, require a documented field/schema, ingress anti-forgery
guarantee and timing/persistence semantics before reconsidering Outcome A/B.

Optional **OPERATOR CHECK REQUIRED**, only if separately authorized:
resource: an isolated test Email Routing domain and test Worker; action: read-only inspection
of existing configuration and bounded synthetic delivery, with no production mutation.
Compare genuine/forged/duplicate auth fields at delivery, observe the documented runtime
keys and envelope metadata, and collect only redacted shape/result evidence.
Observed behavior alone is not an operational guarantee; obtain Cloudflare's documented
anti-forgery contract. Resource creation or sending experiments need separate authorization.

- **MERGE BLOCKER:** failed exact-head checks or missing independent review; no request to
  bypass protection or self-merge. Request vn-taphoanhatung for independent design review.
- **PRODUCTION BLOCKER for trusted sender features:** no proven receiver verdict or approved
  cryptographic verifier. No claim of sender authentication or production certification.
- **FOLLOW-UP:** approve the bounded compatibility/implementation task; carry forward the
  accepted remote R2/Vectorize completion, semantic purge and manifest/tombstone retention
  constraints. Sender/subject phishing text remains an acknowledged product residual.

Production Worker deploy: **NONE**. D1 migrations/mutations: **NONE**. R2 mutations: **NONE**.
DNS/MX changes: **NONE**. Email Routing/Sending changes: **NONE**. Access changes: **NONE**.
Secret changes/rotation: **NONE**. Production DLQ replay: **NONE**.
