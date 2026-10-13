# TUNG OTP BRIDGE V1: security test matrix

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: remediation successor recorded in final PR receipt (the prior reviewed HEAD was `d9549512bfeda4332b26d48e68885a0e57093aab`).
Branch: `codex/otp-bridge-v1`; final successor HEAD, worktree cleanliness, PR URL and CI run URLs are recorded in the PR receipt/final acceptance output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Executed validation (synthetic local data only)

| Command | Result | Evidence |
|---|---|---|
| MailVault `pnpm install --frozen-lockfile` | PASS, lock unchanged | local install |
| MailVault `pnpm typecheck`, `pnpm lint` | PASS | all packages |
| MailVault `pnpm test` | 542 Worker + 106 web PASS; 0 FAIL/SKIP | 37 Worker + 17 web files, includes 12 true-workerd DKIM tests |
| MailVault focused unit/integration customer OTP | 80 PASS, 0 FAIL/SKIP | 33 unit + 47 D1/R2 integration |
| MailVault `pnpm build` | PASS | SPA build + Worker deploy dry-run only |
| MailVault `pnpm test:e2e` | 60 PASS | built owner SPA, local Worker/D1/R2; desktop/mobile |
| MailVault `pnpm audit --prod --audit-level high` | PASS | zero known vulnerabilities |
| Portfolio prior-reviewed `npm ci` | PASS | lockfile reproducible |
| Portfolio prior-reviewed `npm run types`, `npm run check` | PASS | 0 errors, 0 warnings; 43 existing/tooling hints |
| Portfolio prior-reviewed `npm run test:all` | 476 smoke + 13 E2E PASS, 0 FAIL/SKIP | includes 43 OTP smoke and 12 Chromium/WebKit browser tests |
| Portfolio prior-reviewed native `MAILVAULT_REPO_PATH=<canonical checkout> npm run test:otp:integration` | 6 PASS, 0 FAIL/SKIP | production reader/Shop endpoint bundles linked in workerd, isolated actual D1/R2 |
| Portfolio prior-reviewed `npm run build` and `node scripts/assert-otp-review-build.mjs` | PASS | named binding and OFF flag checked in dist/server/wrangler.json |
| Portfolio prior-reviewed `npm audit --json` | PASS | zero known vulnerabilities after remediation |
| Both `git diff --check` | PASS | no whitespace errors |

Portfolio table rows explicitly marked prior-reviewed describe evidence at the earlier reviewed HEAD. The remediation successor Portfolio counts and exact companion MailVault SHA are recorded in the Portfolio report/PR receipt and final cross-repository acceptance; those earlier rows do not certify the remediation.

## Security-negative matrix

| Boundary | Covered cases | Outcome |
|---|---|---|
| Ownership | swapped owner/order/allocation, guest identity unverified, browser alias/email/grant/extra keys | denied before RPC |
| Lifecycle | unpaid, refund/partial refund/cancelled, blocked/deleted customer, held allocation, wrong variant, expired proof/grant, disabled binding/revoked unit | denied |
| Concurrency | 20/50 requests, rolling five-minute/day quota, 50 nonce replay calls, 20 provisioning racers, simultaneous reconciliation, repeat delivery | exactly one eligible winner; lifetime uniqueness |
| During RPC | refund or session revoke completed before final check | no code; final proof/session also joins entitlement SQL |
| During private read | alias disable, deletion, competing new mail | final snapshot fences found |
| MAC | wrong MAC, all signed-field tampering, stale/future issue/window, replay, extra fields, missing secret/OFF | unavailable/denied |
| Email trust | forged Authentication-Results, wrong signer/From, noncryptographic evidence, SPF-only, UNVERIFIED/SPOOFED | never found |
| Code/purpose | reset/recovery/billing, multiple codes/messages, digit-only/order subject, stale/preactivation, malformed JSON, >20 scan candidates | fail closed |
| Mail lifecycle | committed visibility, pending deletion, durable tombstone, uncommitted staging, cross alias | excluded |
| routing-path rules | exact single-action catch-all, ordinary shadow forward/drop/other-worker, malformed action/matcher, complete 50-row pagination, missing/changed totals, duplicate IDs, second-page shadow, GET-only and 20-page bound | no shadowing proof; failures clear readiness |
| F-03 routing readiness | cold alias idle >24h, no receipt proof, fresh first post-entitlement mail, stale/future/malformed routing proof, discovery cannot refresh proof, disabled routing/catch-all, watchdog drift clear | active only with fresh dedicated proof; first trusted code found; stale/pre-entitlement code excluded |
| Privacy | minimal response, malformed RPC, no mailRef/alias/body/MAC, audit row fields, no storage/URL code, no public reader HTTP | PASS |
| Browser | mobile Chromium/WebKit, all four locales, Tab/Enter, aria-live, clipboard, stop at 120s, hidden/pagehide/logout/other tab | PASS |
| Regression | owner auth/mailbox, ingest retry/queue/DLQ, cryptographic verifier, sending, scheduler; Shop payments/inventory/customer login/key reveal/admin | full suites PASS |

The native reader fixture installs synthetic cryptographic-evidence metadata; full MailVault verifier/ingest suites separately verify genuine signature behavior. Browser OTP calls use synthetic server responses; the separate native suite verifies real RPC transport. Neither constitutes real third-party provider/production receiving certification. No screenshots containing OTP are committed. Original failures (Node cannot import cloudflare:workers; test locator matched output implicit status; Miniflare API change; test fixture column/session names) were fixed without skipping assertions or weakening production checks.

Raw local logs are transient `/tmp/otp-*` files; repository contains counts/commands and CI links rather than MIME bodies, mappings, OTP screenshots or secret values. CI receipts at the final PR SHA are linked in the PR; CI failures, if any, must be resolved before acceptance. Author review does not satisfy independent P5 review.

Additional actual default-handler boundary test: POST to `/api/customer/otp`, `/api/otp`, `/api/customer-otp/lookupLoginOtp` returns 404 for authenticated owner context despite the OTP flag ON; production unauthenticated GET returns 401. This uses `src/index.ts` and the actual router, not the RPC harness HTTP fixture. Worker regression total becomes 542.

GitHub CI receipts: [MailVault initial exact head](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio initial exact head](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462); final receipts are recorded in each PR.

## Review receipt references

The exact file manifest is [00-preflight.md](00-preflight.md); RPC/auth decisions are [01-architecture-contract.md](01-architecture-contract.md), schema/state details are reports 02/03, commands/counts/security negatives and CI receipts are [04-security-test-matrix.md](04-security-test-matrix.md), remaining runtime prerequisites are [05-staging-certification.md](05-staging-certification.md), and operator-only recovery is [06-release-and-rollback.md](06-release-and-rollback.md). These references apply to this deliverable.

PRs: [MailVault #13](https://github.com/takovn2/mailvault/pull/13), [Portfolio #1](https://github.com/takovn2/tungjpstore-portfolio/pull/1). Independent reviewer: unassigned, not approved; drafts await separate P5 review. Initial exact-head CI: [MailVault](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462). Final head receipts are attached to the PRs; flags OFF and production mutations NONE.

## Independent-review remediation validation

Reviewed starting HEAD: `d9549512bfeda4332b26d48e68885a0e57093aab`; final successor SHA and matching GitHub CI receipt are recorded in the PR receipt. Local commands run only against synthetic data. The additional complete-routing-path suite passes all 125 tests; combined OTP unit/D1/R2 coverage is 80 tests, included in the full regression count. Additive migration 0021 is tested from a previously READY 0020 database and fresh/legacy database fixtures, without converting discovery timestamps into routing evidence. Routing proof invalidation while R2 is pending fences a found code. Revised full regression/typecheck/lint/build/E2E/audit commands are listed in the validation table; no failures/skips are accepted. Exact companion SHA/native evidence is captured by the Portfolio review workflow after the final MailVault commit.

Followup routing-path hardening starts from MailVault `f50235d50ed210342026a21b82880af7395743e7` and adds no migrations. `cf-client.test.ts` verifies the documented GET-only 50-row page size, maximum 20 pages/1000 rules, complete stable metadata and unique IDs. Actual D1 tests prove that an alias-specific forward on page two prevents readiness despite a healthy catch-all, and missing pagination clears prior readiness immediately. `preflight.test.ts` rejects extra catch-all destinations/actions and unknown ordinary-rule shapes; `provisioner.test.ts` proves ordinary-rule shadows cannot be bypassed by takeover flags. No rule matcher/address values are logged by these tests' production paths. The conservative domain policy blocks any enabled ordinary rule that routes somewhere other than MailVault, including an unrelated address; an operator must separately assess and correct that routing configuration before activation.
