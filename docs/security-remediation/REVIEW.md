# MailVault independent review package

## Scope and status

This package is a code-remediation review, **not production certification**. The target
remains a private, single-owner mailbox on Workers/D1/R2/Queues; no tenancy redesign,
production deployment, remote migration, DNS/routing change, secret rotation, or
production replay was performed. Local gates and explicit unresolved P1 boundaries
are recorded below; this package is not a claim that remote purge completion is proven.

Repository authority is upstream `vn-tak/mailvault`, repository ID `1409350639`, default
branch `main`. The supplied baseline was fetched and found unchanged at the final
pre-publication fetch. The work branch is `fix/mailvault-security-durability-remediation`.
See `AUDIT.md` for starting main/tree and baseline counts. Final source-control identity
and ahead/behind/cleanliness belong in the accompanying post-commit receipt; a document
cannot contain its own final commit hash.

## Findings and executable evidence

“Reproduced” means the unsafe behavior was observed by a regression before its fix,
not that production was exploited. All injections below use synthetic fixtures locally.
The original regressions are retained; test assumptions were updated only where the
intended contract changed (step-up, asynchronous deletion, receiver timestamps,
idempotency headers, or verifier-owned sender evidence).

| Finding                            | Severity / reproduction           | Root cause and remediation                                                                                                                                                                                            | Regression evidence / remaining boundary                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forged aligned sender results      | P0, reproduced                    | Raw MIME A-R credited as receiver evidence. `mail/auth.ts` now separates observations from verifier-owned evidence; raw reporter strings never establish trust. Maintained `tldts` PSL replaces the hand table.       | `unit/sender-auth.test.ts`, `integration/sender-auth.integration.test.ts`: forged aligned pass/fail, IANA header, trusted adapter, forwarded DKIM, malformed/missing evidence, private/uncommon suffixes, sibling/IDN alignment. The live receiver has **no verified verdict adapter**; inbound mail is intentionally `UNVERIFIED`, not authenticated. |
| Partial ingest/dedupe content loss | P0, reproduced                    | Random row identity plus dependent writes and duplicate cleanup. Canonical queued ID, core batch, retryable rule/semantic states, ownership-checked duplicate cleanup.                                                | `integration/ingest-durability.test.ts`: real D1/R2 failures before/after insert, attachments, FTS, rules and semantic work; same-job/concurrent/true-duplicate delivery; missing staging; retry preserves objects and one canonical row.                                                                                                              |
| Domain removal cascade             | P0, reproduced                    | Domain FK cascades after alias keep-mail. API refuses forget while historical mail remains; migration guard also rejects direct domain deletion.                                                                      | `integration/lifecycle.test.ts`: alias keep-mail → forget; raw/attachment/FTS survive, foreign keys remain valid. No implicit domain purge was added.                                                                                                                                                                                                  |
| Last-passkey takeover              | P1, reproduced                    | Access-only last-key removal enabled attacker enrollment. All removals require grants and revoke grants; options/verification both recheck enrollment authorization.                                                  | `integration/step-up-security.test.ts`, `integration/api.test.ts`: takeover chain, last key, hashed/expired grants, purpose-bound consumed challenge, tampering/replay. Real browser WebAuthn E2E supplements mocked verifier boundary tests.                                                                                                          |
| Missing destructive step-up        | P1, reproduced                    | Single/bulk deletion and related irreversible routes differed. Shared `security/irreversible.ts` enforces grant policy.                                                                                               | Step-up integration matrix covers single/bulk, semantic purge, alias/domain and policy controls. `web/lib/api.test.ts` has RED/GREEN for the DELETE grant; `e2e/security-hardening.spec.ts` exercises real registration/assertion, 403→202 deletion, 404 detail, hidden row, last-key removal and no localStorage grant.                               |
| MX/catch-all takeover              | P1, reproduced                    | Client conflict flags/stale preflight could precede writes. Fresh server conflict decisions and whole-selection preauthorization run before mutation.                                                                 | `unit/provisioner.test.ts`, `integration/step-up-security.test.ts`: foreign MX/catch-all need grants; actual no-conflict provisioning does not; stale flags and unknown/unselected domains fail safely. Cloudflare calls are injected, not real DNS.                                                                                                   |
| Non-durable deletion               | P1, reproduced                    | Metadata removed before best-effort external cleanup. Durable indexed jobs/tombstones retain keys, hide pending mail, retry external failure, and expose failed/retry states.                                         | `integration/lifecycle.test.ts`: R2/Vector failure/retry, single/bulk/alias, repeated DELETE, mailbox/search/dashboard/attachment visibility, deleted-job redelivery. 200 IDs are chunked below D1's 100-bind ceiling. In-flight writer fencing is separately reviewed below.                                                                          |
| Outbound partial recovery          | P1, reproduced                    | Fresh attempts created IDs/staging and ambiguous acceptance could resend. Stable idempotency key/hash, canonical ID, durable lifecycle and quota reservation; uncertain dispatch is never automatically redispatched. | `integration/outbound-durability.test.ts`: every staging/D1 boundary, concurrent keys, accepted-response/receipt failure, provider rejection, quota and deleted-mail replay. `e2e/sending.spec.ts` loses the accepted response and retries the same key with one visible message. No real SMTP recipient was contacted.                                |
| Sender-controlled arrival          | P1, reproduced                    | MIME Date controlled ordering/raw partition. Edge timestamp now owns `received_at`; valid MIME Date is separate `header_date`.                                                                                        | Ingest durability tests: 1970, 2099, invalid date, extreme zones. Migration uses old `created_at` as an explicitly approximate historical receipt, not a reconstructed exact arrival.                                                                                                                                                                  |
| DLQ recovery gap                   | P1, confirmed missing workflow    | New key-only recovery CLI defaults to non-leasing peek/read classification; explicit replay preserves the source DLQ.                                                                                                 | `unit/ingest-dlq.test.ts`: bounded classification, no default mutation/content logging, canonical partial retry, explicit replay. Live Cloudflare replay was **not** performed. Ambiguous enqueue may retain staged objects for reconciliation.                                                                                                        |
| Arbitrary push egress              | Additional P1, reproduced         | Authenticated subscription could target arbitrary HTTPS hosts. Restrict supported provider endpoints, reject credentials/non-443/other hosts, and reject redirects before sending VAPID authorization.                | `unit/push.test.ts`: destination policy and network-call behavior. Private-network reachability on real Workers was not tested; the unrestricted destination primitive is addressed in code.                                                                                                                                                           |
| Inbox stale after deletion         | Additional regression, reproduced | Reading-pane deletion navigated without reloading list data. Detail now notifies parent after accepted deletion.                                                                                                      | Security E2E RED observed DELETE 202 + GET 404 + old visible row; GREEN asserts that row is gone.                                                                                                                                                                                                                                                      |
| Unprotected main                   | P2, confirmed read-only           | Branch endpoint reported `protected=false`; rulesets were empty. No settings mutation authorized.                                                                                                                     | `OPERATIONS.md` recommends PR approvals, mandatory verify check, restricted production dispatch and reviewed migrations. Protection details returned 403; production environment policy is unverified.                                                                                                                                                 |
| Mutable action refs                | P2, confirmed                     | CI/rollback actions now use verified immutable upstream commits; Dependabot and prod audit added.                                                                                                                     | Official commit lookups and local action-ref format check; lockfile install and dependency-audit receipt.                                                                                                                                                                                                                                              |
| Schema-before-code and rollback    | P2, confirmed gap                 | Read-only ledger gate precedes deployment; remote migrations remain separate operator actions. Rollback requires main ref, explicit acknowledgement, production environment and validated version ID.                 | `unit/schema-gate.test.ts`, `integration/migrations.test.ts`: fail-closed malformed/missing receipt; clean and upgrade D1 with `foreign_key_check`; prior query shapes parse on new schema, **not** a guarantee old code is safe. Pre-hardening rollback can reintroduce sender trust flaws.                                                           |
| Public operational metadata        | P2, observed                      | Public config includes account/domain inventory identifiers, not automatically credentials. No high-confidence secret signature found in available tracked head.                                                      | `BOUNDARIES.md` location-only scan. Checkout history was shallow; older history/other refs and remote production secrets were not inspected. No rotation was performed.                                                                                                                                                                                |

Test paths in the table are relative to `apps/worker/test/` unless prefixed `web/` or
`e2e/`; web paths are relative to `apps/web/src/` or `apps/web/` respectively.

## Migration receipt and deployment constraints

Only new migration files are added; shipped `0001`–`0012` remain unchanged.

- `0013_ingest_lifecycle.sql`: sender header date, receiver-time historical normalization,
  resumable ingest states and progress timestamps; old rows retain core data.
- `0014_durable_deletions.sql`: pending visibility, indexed durable cleanup/tombstones,
  domain-delete guard and deleted-message resurrection guard.
- `0015_outbound_jobs.sql`: outbound canonical idempotency, leases, acceptance and
  durable quota records that outlive deleted mail.
- `0016_revoke_legacy_sender_auth.sql`: invalidates historical **inbound** verdicts and
  unproven assessment JSON; outbound records are not reclassified.
- `0017_semantic_index_leases.sql`: renewable semantic-writer markers used by cleanup.
- `0018_outbound_staging_manifest.sql`: outbound write intent, writer fences,
  uncertainty and alias-purge insert protection.
- `0019_inbound_staging_manifest.sql`: per-object inbound intent, alias/message fences,
  retained tombstones and settled-snapshot cleanup confirmation.

The deployment schema gate reads the ledger; it does not apply migrations. Migration
SQL can change data and requires separately authorized operator backup/recovery and
rollout. D1 is never rolled back by Worker-version traffic rollback. Follow
`OPERATIONS.md`; do not deploy a pre-hardening Worker merely because old SELECTs parse.

## Verification receipt

The primary ran the final local checks on 2026-10-08 (synthetic fixtures only):

| Gate                | Command                                   | Observed result                                                                |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Locked dependencies | `pnpm install --frozen-lockfile`          | PASS                                                                           |
| Typecheck           | `pnpm typecheck`                          | PASS                                                                           |
| Lint                | `pnpm lint`                               | PASS                                                                           |
| Worker/Web          | `pnpm -r test`                            | 33 Worker files / 370 tests; 17 Web files / 106 tests; no failures/skips       |
| Built SPA + browser | `pnpm test:e2e`                           | 60 PASS, no failures/skips; Chromium desktop/mobile, same-origin local workerd |
| Worker bundle       | `pnpm --filter @mailvault/worker build`   | PASS, Wrangler deploy **dry-run** only                                         |
| Web bundle          | `pnpm build:web`                          | PASS                                                                           |
| Dependency audit    | `pnpm audit --prod --json`                | 0 info/low/moderate/high/critical advisories                                   |
| Schema/migrations   | migration integration + local schema gate | fresh/upgrade 2/2; schema tests 12/12; ledger 19/19; `foreign_key_check` empty |

Schema commands run locally:

```sh
pnpm --filter @mailvault/worker exec vitest run test/integration/migrations.test.ts test/unit/schema-gate.test.ts
cd apps/worker
node scripts/check-schema.mjs
pnpm exec wrangler d1 execute mail-vault-db --local --config wrangler.dev.jsonc --command 'PRAGMA foreign_key_check; SELECT count(*) AS migrations FROM d1_migrations;' --json
```

A source change requires a new receipt. Local
logs and synthetic RED/GREEN receipts are in ignored `.hoplite/evidence/`; they are not
production logs. Initial baseline was 264 Worker + 100 Web tests. A “ready” Preview
probe proved only page load: real E2E first found a missing DELETE grant, stale local
schema, then stale inbox data. A later concurrent local build triggered a server reload/HTTP 500 during browser navigation; builds and E2E were then serialized without changing assertions. Those failures were investigated rather than dismissed.
Local D1 snapshots were retained before rebuilding test data. No remote database was used.

## Files grouped for review

- **Security/sender:** `mail/auth.ts`, sender fixtures/tests, shared auth enums,
  verdict mappers and Inbox/detail/insight presentation.
- **Ingest/timestamps/recovery:** `mail/ingest.ts`, `db/ingest.ts`, schema `0013`/`0019`,
  scheduled handling, Miniflare tests and `scripts/ingest-dlq.*`.
- **Database/deletion:** `db/deletions.ts`, `db/visibility.ts`, schema `0014`/`0017`,
  messages/aliases/domains/read queries, semantic leases and lifecycle tests.
- **Passkeys/provisioning:** irreversible policy, security/domain routes, provisioner,
  WebAuthn challenge binding, UI mutation wrappers and takeover tests.
- **Outbound:** send/job helpers, schema `0015`/`0018`, transport/quota/reply tests and
  composer stable-key E2E.
- **CI/docs:** workflows, Dependabot, schema gate/tests, `SECURITY.md`, this directory,
  lockfile for PSL and local artifact ignores.

## Explicit limits for the independent reviewer

- No external independent security review or production-runtime certification has taken
  place. Local Miniflare storage and injected Vectorize/provider responses cannot prove
  remote service consistency, provider completion latency or every worker-crash race.
- No verified per-message sender verdict is available from the current receiver. Raw
  observations are not trusted. UI body/OTP/link/attachment gates and reply refusal remain
  fail-closed; readable subject/sender text can still contain phishing instructions (P2).
- An in-flight semantic writer has renewable leases and durable late-write repair. A
  worker that dies during an accepted remote operation whose completion outlives its
  lease is an unresolved external completion-ordering boundary until provider-runtime
  bounds or retained-tombstone reconciliation are independently established.
- Semantic disable is not a durable purge receipt: provider failure or an already-active
  writer can leave vectors. An authenticated operator may retry disable; this limitation
  is separate from durable permanent-message deletion and must not be concealed by an
  “off” label.
- **P1 / unknown / blocked: remote operation completion bounds.** R2 manifests now
  include object keys before PUT, deletion is fenced, and unlinked inbound tombstones
  are repeatedly swept. Tests cover live deletion/alias races, crash/late PUT, transient
  DELETE failure, and retention while semantic upsert is active. Unsettled expired
  writers cannot produce DONE; `INBOUND_STAGE_UNCERTAIN`/`OUTBOUND_STAGE_UNCERTAIN`
  preserve identifiers. This is local failure-injection evidence, not a proof of remote
  cancellation/completion bounds. Manifests/tombstones have no automatic retirement.
  Vectorize completion after a dead writer and semantic-disable purge remain blocked
  operational boundaries; do not interpret this review package as purge certification.
- Branch protection, production environment reviewers/restrictions, Access/DNS/routing,
  backup readiness, real Cloudflare quotas/bind behavior, and real SMTP/Queue replay
  remain operator/runtime prerequisites, not settings verified by this local run.
- Unverified mail can be archived/tagged by owner-authored rules; rules do not delete it.
  The implementation now adds HSTS to production-configured HTTPS documents and CSRF compares complete origins;
  the local regressions are in `unit/headers.test.ts`. Cloudflare edge header
  configuration remains unverified; no production browser bypass was demonstrated.

## Production mutation receipt

Production deploy: **NO**. Production D1/R2 mutation: **NO**. Production DNS mutation:
**NO**. Production Cloudflare routing mutation: **NO**. Production secret mutation:
**NO**. Production DLQ replay: **NO**. Repository protection/environment changes: **NO**.

## RED/GREEN reproduction receipt

`integration/p0-baseline-guards.test.ts` runs unchanged against fetched upstream Worker
source/schema and this remediation. Three upstream failures reproduce forged aligned
MIME trust, attachment-loss on partial-commit redelivery, and domain cascade after
keep-mail alias removal; all three pass after remediation. The baseline harness uses
the locked installed dependencies and baseline Worker/schema; no production data.

Additional retained local receipts: outbound eight-boundary failures and alias/deletion
races (`outbound-*.log`), missing DELETE grant (`delete-client-red.log`), HSTS/CSRF
failures (`headers-red.log`), two absent inbound-intent failures (`inbound-staging-red.txt`),
false alias DONE/missing recurring cleanup (`inbound-scheduled-red.log`),
a fenced writer that had not started PUT (`inbound-unstarted-red.log`), and premature
R2 removal during semantic upsert (`inbound-semantic-retention-red.log`), and incomplete/unknown migration receipts (`schema-receipt-red.log`). Focused GREEN
and the final full-suite receipts supersede intermediate failures. Logs live under
ignored `.hoplite/evidence/`; executable regressions are committed, not skipped.

The former lifecycle test simulated inserting a message after alias purge. Migration
`0019` now correctly rejects that insertion; the test asserts rejection and cleanup of
its durable outbound manifest instead. Existing semantic-retention coverage was not
weakened when it found the premature sweep.

A manifest fenced before `beginInboundStaging` returns is explicitly settled without
R2 writes. This does not infer settlement for a PUT that may already be remote. The
legacy alias-delete helper rejects purge requests; permanent purge uses the durable route.
