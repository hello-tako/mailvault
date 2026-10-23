# Remediation audit matrix

Baseline: `vn-tak/mailvault`, repository ID `1409350639`, fetched upstream
`e966b67f0c56f5d5dab0c57d52e1927797e81d9b`, tree
`03ab55eb0a0d30835940c5ae6772bc9356d844f3`.
Working branch: `fix/mailvault-security-durability-remediation`.
Tracked starting tree was clean. Attachment directory is excluded from publication.
Local baseline: 23 Worker files / 264 tests and 13 Web files / 100 tests pass.
GitHub baseline run: 37683678217, success. No production mutations authorized.

Findings below are hypotheses until executable evidence confirms them. Final receipts
and residual limitations belong in REVIEW.md; this matrix records investigation scope.

| Area             | Existing design / code path            | Risk being reproduced                                              | Severity | Planned correction                                                              | Required evidence                                                                   |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sender auth      | `mail/auth.ts`, `mail/parse.ts`        | Raw A-R accepted on alignment alone                                | P0       | Provenance-gated evidence, maintained PSL, revoke legacy verdicts               | Forged aligned pass/fail, trusted adapter, PSL unit + ingest integration            |
| Ingest           | `mail/ingest.ts`, `db/messages.ts`     | Row insert followed by non-atomic dependent writes; dedupe cleanup | P0       | Canonical staged ID, resumable bounded reconciliation, ownership-safe cleanup   | Real D1/R2 failures at every boundary, redelivery/races/missing staging             |
| Domain removal   | `routes/domains.ts`, `0001_init.sql`   | Domain CASCADE after alias keep-mail                               | P0       | Reject forget while historical mail remains, database guard                     | Alias keep-mail → forget with R2/FTS retained                                       |
| Passkeys         | `routes/security.ts`, `db/security.ts` | Last-key Access-only recovery collapses second factor              | P1       | Step-up on every removal, explicit operator recovery                            | Takeover chain, enrollment, expiry/replay/hash-at-rest                              |
| Permanent delete | message/alias/domain/semantic routes   | Inconsistent step-up coverage                                      | P1       | Central irreversible-operation policy                                           | Missing/valid/expired grant on single/bulk/purge                                    |
| Provisioning     | `provisioning/*`, domain routes        | MX/catch-all takeover without strong auth; stale preflight         | P1       | Gate fresh actual conflicts before mutations                                    | Conflict/no-conflict/stale-conflict tests                                           |
| Deletion         | `db/messages.ts`, R2/Vectorize cleanup | Metadata removed before best-effort external deletes               | P1       | Durable cleanup jobs and hidden pending mail                                    | R2/Vector failure, retry, idempotent repeated and bulk deletion                     |
| Outbound         | `mail/send.ts`                         | New IDs per retry, orphan staging and duplicate sends              | P1       | Idempotency-key lifecycle, resumable pre-send writes, durable uncertain receipt | **RED confirmed**: eight real D1/R2 boundary tests in `outbound-durability.test.ts` |
| Arrival time     | `mail/parse.ts`, storage key builders  | MIME Date controls arrival ordering/path                           | P1       | Edge receipt time + separate header date                                        | 1970/2099/invalid/timezone fixtures                                                 |
| Recovery         | Queue DLQ + staged R2                  | No safe inspect/classify/replay workflow                           | P1       | Read-only default recovery tool, explicit replay                                | Dry-run classifications, bounded batches and redacted output                        |
| Governance       | upstream main metadata                 | `protected=false`; details API denied (403)                        | P2       | Recommended ruleset only, no settings mutation                                  | Read-only GitHub evidence; operator activation pending                              |
| Supply chain     | CI action tags                         | Mutable v4 refs                                                    | P2       | Verified immutable refs, controlled updates/audit                               | Lockfile install, vulnerability receipt, action ref validation                      |
| Deployment       | manual deploy CI                       | No schema gate before new Worker                                   | P2       | Read-only migration/schema gate before deploy                                   | Fresh/upgrade migration tests, dry-run                                              |
| Rollback         | Worker version rollback                | D1 is not rolled back                                              | P2       | Additive compatibility policy and query smoke tests                             | Previous query shapes against latest schema                                         |
| Public metadata  | tracked config/docs/history            | Production identifiers/inventory in public source                  | P2       | Classify secrets vs operational metadata; sanitized examples                    | Location-only tracked/history review; no rotation                                   |

Additional boundaries: Access/JWT → Worker, CSRF → mutation routes, WebAuthn → grants,
SMTP/raw headers → verdicts, staged R2 → queue/D1, D1 → R2/Vectorize, Cloudflare API
preflight → mutation, transport acceptance → local send receipt, push/DO → browser,
and CI/schema → production. No assertion of production certification is made.

## Final investigation disposition

All three baseline P0 findings reproduce in the baseline-compatible guards and pass
on remediation. The P1 sender-step-up, deletion, sending, arrival-time and DLQ findings
have executable coverage mapped in REVIEW.md. Additional inbound-staging regressions
reproduce missing durable intents, false alias purge completion and omitted recurring
cleanup; final implementation retains unknown writers rather than claiming success.

External completion bounds for R2/Vectorize, semantic-disable purge, and production
configuration/governance are **explicitly blocked/unknown**, not NOT_REPRODUCED and not
certified. The unrestricted push-destination primitive and browser HSTS/CSRF boundary
were reproduced locally and patched; no production private-network exploit was claimed.
No hypothesis is dismissed merely because a page-load probe or documentation looked safe.
