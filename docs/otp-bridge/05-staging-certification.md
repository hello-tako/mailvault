# TUNG OTP BRIDGE V1: staging certification

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: remediation successor recorded in final PR receipt (the prior reviewed HEAD was `d9549512bfeda4332b26d48e68885a0e57093aab`).
Branch: `codex/otp-bridge-v1`; final successor HEAD, worktree cleanliness, PR URL and CI run URLs are recorded in the PR receipt/final acceptance output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Runtime evidence and certification limits

Status: LOCAL_RUNTIME_VERIFIED; STAGING/PRODUCTION_NOT_CERTIFIED.

Read-only Wrangler whoami verified account `ef250a88911fd24073cb73d1c07e0218`. Both `mail-vault` and `tungjpstore-portfolio` version/deployment metadata were read with that account explicitly selected. This confirms current same-account Worker identity. It does not prove that the new named entrypoint exists in a deployed version. Local workerd with each repository compatibility date/Node compatibility runs both Workers, named binding and separate actual D1/R2 successfully.

Public DNS lookup for `tungjp.store` returned Cloudflare routing MX (`route1/2/3.mx.cloudflare.net`). MX is insufficient to certify the catch-all destination, ACTIVE alias or delivery. No real MailVault/customer mailbox was accessed. Reviewed owner-controlled mail sample and operator-authorized test receipt remain mandatory before enabling any provider.

Remaining approval/review gates: independently review exact PR SHAs and least-privilege deployment roles; provision the shared integration secret separately; approve migrations/backups and sequence; deploy both with flags OFF; verify actual deployed named RPC (including wrong-key caller), catch-all and controlled synthetic/test alias; review legitimate login-only sender/DKIM/template samples; verify real recent Google auth_time or magic-link on same session; physical Safari and remote D1 latency/quota tuning; flag activation for controlled cohort only with separate approval. No production-ready/security-approved status is asserted.

MailVault and Shop cannot share a database transaction. Final reads fence completed revocation interleavings, but cannot atomically couple both databases or the network-send boundary. Revocation occurring after the final authorization statement or after a response was delivered cannot retract that response/clipboard. UI holds only a short-lived code; no external provider consumption guarantee is made. A deployment principal possessing both the binding and HMAC secret remains privileged; isolate those rights.

## Review receipt references

The exact file manifest is [00-preflight.md](00-preflight.md); RPC/auth decisions are [01-architecture-contract.md](01-architecture-contract.md), schema/state details are reports 02/03, commands/counts/security negatives and CI receipts are [04-security-test-matrix.md](04-security-test-matrix.md), remaining runtime prerequisites are [05-staging-certification.md](05-staging-certification.md), and operator-only recovery is [06-release-and-rollback.md](06-release-and-rollback.md). These references apply to this deliverable.

PRs: [MailVault #13](https://github.com/takovn2/mailvault/pull/13), [Portfolio #1](https://github.com/takovn2/tungjpstore-portfolio/pull/1). Independent reviewer: unassigned, not approved; drafts await separate P5 review. Initial exact-head CI: [MailVault](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462). Final head receipts are attached to the PRs; flags OFF and production mutations NONE.

## Routing-readiness remediation gate

Migration 0021 leaves `routing_verified_at` NULL for existing domains. Before enabling any OTP cohort, an authorized read-only MailVault watchdog verification must prove Cloudflare MX without foreign MX, active Email Routing, a complete bounded ordinary-rule inventory with no shadowing actions, and an enabled catch-all with one action targeting the deployed MailVault Worker. Discovery sync cannot satisfy this gate. Actual delivery to an owner-controlled registered alias and legitimate provider DKIM/login-template evidence remain separate P6 requirements; removing the 24-hour provider receipt readiness check does not certify runtime delivery or enable a policy.
