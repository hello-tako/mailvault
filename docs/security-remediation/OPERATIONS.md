# Security remediation operations

This runbook covers the schema gate, remote migration order, deployment rollback limits, and recommended GitHub controls. It documents operator actions; it does not perform production operations or change GitHub settings.

## CI schema gate and migration order

The deployment job in `.github/workflows/ci.yml` first requires `verify`, then runs `node scripts/check-schema.mjs --remote` from `apps/worker`, and only then deploys the Worker. The schema gate (`apps/worker/scripts/check-schema.mjs`) is read-only: it asks Wrangler for `SELECT name FROM d1_migrations ORDER BY name`, compares the receipt with the numbered SQL files in `apps/worker/migrations`, and fails closed on a query error, invalid/incomplete JSON receipt, any unapplied/unknown/duplicate migration, or a receipt without explicit success. It never applies migrations. It checks names, not SQL contents or checksums; reviewers must separately enforce append-only integrity of shipped migrations. `apps/worker/test/unit/schema-gate.test.ts` covers a complete ledger, a missing migration, malformed/incomplete receipts, unknown/duplicate migrations, explicit success, and an unreadable database.

Remote schema changes are a separate, operator-controlled step. The package script is `pnpm --filter @mailvault/worker db:migrate:remote` (`wrangler d1 migrations apply mail-vault-db --remote`). Recommended order:

1. Review each new SQL migration and its data effects; run the PR's `verify` checks and migration compatibility tests. Confirm an approved, current D1 recovery/backup point using the organization's Cloudflare procedure before applying data-changing SQL.
2. From the reviewed revision, the authorized operator applies migrations with `pnpm --filter @mailvault/worker db:migrate:remote`. This is the only documented remote migration command; CI does not migrate automatically.
3. Confirm the migration ledger read-only with `cd apps/worker && node scripts/check-schema.mjs --remote`. Stop if it fails; do not dispatch a deployment that cannot pass the schema gate.
4. Dispatch the CI workflow on `main`. It reruns `verify`, downloads the tested SPA artifact, checks the schema read-only, and then deploys. Confirm the resulting production version with the deployment status output.

Migrations are append-only and are not rolled back by deploying an earlier Worker. Treat migration failures as a halt-and-recover event: do not hand-edit `d1_migrations` or attempt an improvised down migration. Prepare and review a forward repair or use the approved database recovery procedure.

## Worker rollback is not database rollback

The manual `Roll back production` workflow deploys an already-uploaded Worker version at 100%; it does not restore D1 or reverse migrations. It retains the `production` environment and requires a UUID-shaped version ID. It now also requires the operator to set `acknowledge_production_rollback` to true. The workflow validates both acknowledgement and version ID before its first Cloudflare API call, lists recent versions for operator context, validates again immediately before deployment, and checks the live deployment afterward. Choose a version only after checking that it is known good and compatible with the current D1 state. The rollback workflow does not depend on the `verify` job. The GitHub production environment's own approval controls (not confirmed in this review) are additional protection, not a substitute for this acknowledgement.

The migration compatibility test (`apps/worker/test/integration/migrations.test.ts`) applies the migrations to fresh and legacy fixtures, checks foreign keys and retained mail fields, and executes representative old query shapes. Its comment is intentional: old query shapes remain syntactically valid on the additive schema, but that does **not** prove old Worker behavior is semantically safe.

Local verification: the schema-gate unit tests pass 12/12; fresh and legacy migration
compatibility tests pass 2/2. The migration fixture parser handles trigger bodies without
splitting their internal semicolons. This is local Miniflare evidence, not a remote
ledger or production-runtime receipt.

- Migrations `0013`–`0015` add lifecycle columns/tables, deletion protections/jobs, and outbound idempotency state without dropping the old columns used by those sample queries. A pre-migration Worker may still parse those queries, but it does not understand the new durable deletion/send state or enforce the new code-path invariants. Do not infer a safe rollback solely from the compatibility test.
- Migration `0016_revoke_legacy_sender_auth.sql` clears stored inbound `auth_verdict` and `auth_json` because the old evidence was not trustworthy. A Worker version predating the sender-auth hardening can reintroduce the unsafe interpretation for newly received mail. After `0016`, deploying such a version is an explicit security downgrade and is not an acceptable routine rollback. Prefer a forward fix. Any emergency exception requires security-owner approval and a documented containment/recovery plan; traffic rollback alone cannot undo the data change or make old verification trustworthy.

## Passkey challenge troubleshooting

Passkey options return `{ options, challenge }`, with `options.challenge` exactly equal to the separately returned, server-stored `challenge`. Registration and step-up verification requests must send `{ response, challenge }` with `challenge` at the top level; do not move it into the credential `response`. The Worker consumes the matching, unexpired, purpose-bound challenge once and passes it as `expectedChallenge` to SimpleWebAuthn, which validates the challenge in the authenticator's signed `clientDataJSON` along with origin/RP and credential proof. Missing, mismatched, or replayed challenges are rejected. If the UI reports a missing challenge, check this request shape and preserve the cryptographic verifier; do not bypass it or trust a client-supplied challenge without matching the stored server challenge.

## Recommended GitHub protections (not applied here)

Read-only evidence checked on 2026-10-07 for `vn-tak/mailvault`:

- `gh repo view` reports default branch `main`; the checked-out baseline is commit `e966b67f0c56f5d5dab0c57d52e1927797e81d9b` (`Stop the view from stealing its overlays' containing block (#11)`). GitHub's branch endpoint reports `protected: false` for `main` at that baseline.
- `gh api repos/vn-tak/mailvault/rulesets --paginate` returned an empty list.
- The classic branch-protection endpoint returned HTTP 403 (`Resource not accessible by integration`), so its detailed settings could not be inspected. The production environment endpoint returned 404; its approval/restriction configuration is likewise unverified. These are read limitations, not settings changes.

Recommended owner-configured controls:

1. Protect `main`: require pull requests, at least one independent approval, dismiss stale approvals and require approval of the latest reviewable push, require conversations resolved, and require the `verify` status check before merge. Require branches to be up to date if the team can sustain the merge queue. Do not make the required check optional to accommodate a red CI run.
2. Block force pushes and branch deletion; disallow routine administrator bypass. If the single-owner team cannot provide an independent reviewer, document that limitation and use a deliberate, narrow exception rather than weakening the required CI check.
3. Configure the `production` environment with required human reviewers (where available, disallow self-approval), deployment restricted to `main`, and the Cloudflare credentials stored only as environment secrets. Keep the workflow's explicit production acknowledgement and version validation.
4. Keep workflow token permissions least-privilege (`contents: read` here), permit only reviewed/pinned actions, and retain CI as a required gate for both deploy and rollback code changes.

These recommendations are not evidence that corresponding settings currently exist; the read-only checks above did not confirm them.

## Rollback workflow action reference verification

On 2026-10-07, GitHub CLI read-only commit lookups against the official action repositories resolved the refs used by `rollback.yml` to these upstream commit objects:

| Workflow ref                                                  | Upstream commit subject                               | Committer date | Lookup                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `actions/checkout@11d5960a326750d5838078e36cf38b85af677262`   | `backport fixes to releases-v4 (#2524)`               | 2026-07-16     | [official commit](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262)   |
| `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1`  | `Revert "feat!: run the action on Node.js 24 (#205)"` | 2026-03-11     | [official commit](https://github.com/pnpm/action-setup/commit/b906affcce14559ad1aafd4ab0e942779e9f58b1)  |
| `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` | `Bump @action/cache from 4.0.2 to 4.0.3 (#1262)`      | 2025-04-02     | [official commit](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020) |

Each exact ref was queried with `gh api repos/{official-owner}/{action}/commits/{ref}`; the returned commit object's `sha` matched the workflow ref. These reads confirm the refs resolve to commits in the official repositories; GitHub's API did not return a `verification.verified` value, so this check does not assert signed-commit verification. CI's upload/download artifact refs were also resolved read-only: `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2 release preparation, 2025-03-19) and `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093` (v4.3.0 release preparation, 2025-04-24). CI action references are outside this runbook's edit scope.

## Staging reconciliation and uncertain completion

Migrations `0018` and `0019` persist outbound and inbound R2 write sets before writes.
The existing hourly scheduler calls `drainDeletionJobs`, which first performs a bounded
inbound sweep. It does not remove valid STAGED queue/DLQ input. Message-backed objects
stay on the writer-fenced deletion path; unlinked tombstoned manifests are re-swept
hourly, including after an empty/successful pass or provider failure.

An alias purge cannot finish until its inbound writers are settled and a subsequent
successful R2 cleanup is confirmed. Expired, unsettled inbound writes remain uncertain;
message cleanup records `INBOUND_STAGE_UNCERTAIN` rather than reporting DONE. Outbound
cleanup likewise refuses `OUTBOUND_STAGE_UNCERTAIN`. Do not clear manifests, expire
identity tombstones, or reset sticky uncertainty based solely on lease expiry, an empty
R2 list, or a single DELETE. Retained manifests/tombstones grow without an automatic
retention cutoff; capacity monitoring and a separately reviewed retirement policy are
operator prerequisites. There is no implemented automatic safe retirement proof.

For a separately authorized operator investigation, inspect metadata first (no mail body):

```sql
SELECT state, writes_settled, cleanup_confirmed, COUNT(*) AS count
FROM inbound_staging GROUP BY state, writes_settled, cleanup_confirmed;
SELECT state, error_code, COUNT(*) AS count
FROM deletion_jobs GROUP BY state, error_code;
```

No production query or cleanup was run in this remediation. Provider completion bounds,
Vectorize late writes after a dead worker, and semantic-disable purge recovery remain
explicit P1/unknown boundaries. A failed purge is not a successful deletion receipt.
