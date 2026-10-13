# TUNG OTP BRIDGE V1: preflight

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: `f8af0fb0b801e79479b4102bd48cfd4ce300aaa6`.
Branch: `codex/otp-bridge-v1`; code worktree clean after implementation commit. Reports and CI are documented successors; final review HEAD, PR URL and CI run URLs are recorded in the PR receipt/final agent output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Verified preflight (P0)

GitHub stable-ID lookup resolves both canonical repositories; historical vn-tak names redirect. Initial CLI identity hello-tako was read-only: no code was written under unconfirmed authority. User explicitly requested login to admin takovn2; completed device flow, `gh api user` verifies takovn2 and both stable-ID responses show push/admin true. Fresh main HEADs match the bases recorded here, rechecked before commits. Main protection API reports false; no rules/settings were changed. Work proceeded in a fresh canonical MailVault clone and exact-base Portfolio checkout; stale MailVault checkout was not modified.

Audit read actual source, migrations, configs, tests and fulfillment/auth calls, not only README. MailVault `apps/worker/src/index.ts:24` adds export alongside existing handlers; `mail/ingest.ts`, `mail/dkim.ts`, `mail/auth.ts`, `mail/otp.ts`, D1 ingest/visibility/deletions and migrations through 0019 were inspected. Actual enum values ACTIVE, READY/READY/OURS, COMMITTED and pending ingest states drove queries. Existing independently verified DKIM metadata is reused; MIME auth headers cannot establish trust.

Portfolio `src/lib/shop/customer-auth.ts:194` resolves secure sessions; `customer-account.ts` requires order ownership; core/inventory/customer migrations and fulfillment code were read. Existing encrypted inventory is not parsed as email/password/TOTP. Actual order item/allocation/unit foreign keys drive immutable entitlements. Postbuild wrapper was checked and generated named binding is asserted. Astro routing/components/framework/i18n and Cloudflare RPC documentation were consulted.

Findings addressed: no existing customer entitlement; old session is not recent auth; no distributed D1 transaction; normal owner message visibility is insufficient for login-only code; alias lifetime reuse unsafe; rate count-then-write unsafe; build-generated service type cannot infer source from separate repository. Implemented narrow fixes are described in reports 01-03. Existing owner/customer/payment systems are retained. Runtime/provider/routing review conditions are listed in report 05; they stop activation, not safe local implementation.

## Exact implementation changed files

| File | Why |
|---|---|
| `apps/worker/migrations/0020_customer_otp_rpc_nonces.sql` | additive immutable grant/nonce schema and lifecycle fences |
| `apps/worker/src/customer-otp/auth.ts` | reuse existing identity/session flow for same-session step-up |
| `apps/worker/src/customer-otp/classify.ts` | scoped implementation and boundary validation |
| `apps/worker/src/customer-otp/contracts.ts` | scoped implementation and boundary validation |
| `apps/worker/src/customer-otp/entrypoint.ts` | scoped implementation and boundary validation |
| `apps/worker/src/customer-otp/lookup.ts` | scoped implementation and boundary validation |
| `apps/worker/src/customer-otp/providers.ts` | scoped implementation and boundary validation |
| `apps/worker/src/env.ts` | optional secret NAME and typed boundary; no provisioned value |
| `apps/worker/src/index.ts` | additional private named export; existing event handlers preserved |
| `apps/worker/test/compat/worker-entrypoint-node.ts` | synthetic security/concurrency/regression/runtime validation |
| `apps/worker/test/integration/customer-otp.test.ts` | synthetic security/concurrency/regression/runtime validation |
| `apps/worker/test/unit/customer-otp.test.ts` | synthetic security/concurrency/regression/runtime validation |
| `apps/worker/vitest.config.ts` | synthetic security/concurrency/regression/runtime validation |
| `apps/worker/worker-configuration.d.ts` | canonical Wrangler-generated binding/runtime declarations |
| `apps/worker/wrangler.jsonc` | feature OFF default and scoped named service configuration |

Reporting successors add these seven required reports; Portfolio also adds review-only `.github/workflows/otp-bridge.yml` and `scripts/assert-otp-review-build.mjs` for repeatable final-SHA evidence. CI has no production credentials/deploy job. No generated screenshots, real mapping file, credentials or email body are committed.
