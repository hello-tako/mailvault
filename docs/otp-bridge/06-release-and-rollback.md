# TUNG OTP BRIDGE V1: release and rollback

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: remediation successor recorded in final PR receipt (the prior reviewed HEAD was `d9549512bfeda4332b26d48e68885a0e57093aab`).
Branch: `codex/otp-bridge-v1`; final successor HEAD, worktree cleanliness, PR URL and CI run URLs are recorded in the PR receipt/final acceptance output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Operator-only release and rollback

This runbook is documentation, not permission to execute. During implementation: PRODUCTION_MUTATIONS=NONE, flags OFF, no merge/deploy/DNS/MX/secrets/real mail/remote migration.

1. Independent reviewer audits both final PR heads, CI receipts, dependency diff, immutability/retention and deployment-principal access. Record approver and exact SHAs; author cannot self-certify P5.
2. Operator separately approves backups/recovery bookmarks and additive migration application. MailVault 0020/0021 and the Portfolio OTP migrations must precede their respective code; preserve the full historical ledger. The MailVault read-only schema gate automatically discovers 0020/0021. Do not rename historical Shop prefixes or drop lifetime binding/grant audit.
3. Deploy compatible MailVault export first with OFF flag; smoke owner auth, incoming queue/storage and sending. Deploy Portfolio binding/backend/UI OFF; smoke customer login, checkout/payment, fulfillment/key reveal and admin. These steps were not performed by the agent.
4. Operator provisions `OTP_BRIDGE_RPC_HMAC_KEY` in both Worker secret stores (minimum 32 characters, strong random key). Do not place values in vars/git/logs/chat. Verify live named binding, unauthorized caller denial and same account after deployment.
5. Run the existing read-only domain verification after migration 0021 to populate fresh `routing_verified_at`; discovery sync cannot create this evidence. The verification reads the complete bounded ordinary Email Routing rules inventory and exact catch-all shape; any pagination uncertainty or shadowing rule blocks readiness. Review legitimate owner-controlled provider samples and code-owned registry change. Prove actual routing and approved alias receipt; single-unit protected API validates receiving proof and lifetime no-reuse constraints. No automatic account login or provider OTP request is implemented.
6. Separately approve MailVault/Shop flags and limited cohort, run paid test order plus cross-customer/refund/revoke tests, then observe privacy-safe outcomes and latency. Alarm on found-to-attempt anomalies, auth denials, RPC unavailability/pending exhaustion; no OTP in metrics.

Emergency rollback: disable Shop flag first to stop customer requests, then MailVault flag. In-flight requests still perform final authorization but flag propagation and network delivery are not atomic. Use authorized version rollback only to a reviewed compatible version; Worker rollback does not reverse D1. Keep additive tables, immutable binding/grant history and tombstones; never delete/rebind sold aliases to recover service. Quarantine affected binding and revoke with a reason when needed. Secret rotation requires coordinated operator action; partial rotation fails closed. Use forward repair or separately approved D1 recovery instead of improvised down migration.

Pending validations: twenty leased attempts per cycle with exponential backoff and safe failure metadata. Investigate/fix routing, compiled provider policy or service availability, then use the protected `/api/admin/shop/otp/revalidate` with inventory unit ID and reason after its fifteen-minute cooldown. It records actor/reason/cycle and boundedly requeues the same immutable entitlement; no manual database mutation is supported. Do not reset alias ownership or resurrect revoked/expired grants. Lookup audit retention is thirty days; nonce retention sixty seconds; grant/binding lifetime history is permanent in V1. Legal/account deletion policy must separately assess retained minimal IDs before rollout; do not silently erase no-resale controls.

## Review receipt references

The exact file manifest is [00-preflight.md](00-preflight.md); RPC/auth decisions are [01-architecture-contract.md](01-architecture-contract.md), schema/state details are reports 02/03, commands/counts/security negatives and CI receipts are [04-security-test-matrix.md](04-security-test-matrix.md), remaining runtime prerequisites are [05-staging-certification.md](05-staging-certification.md), and operator-only recovery is [06-release-and-rollback.md](06-release-and-rollback.md). These references apply to this deliverable.

PRs: [MailVault #13](https://github.com/takovn2/mailvault/pull/13), [Portfolio #1](https://github.com/takovn2/tungjpstore-portfolio/pull/1). Independent reviewer: unassigned, not approved; drafts await separate P5 review. Initial exact-head CI: [MailVault](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462). Final head receipts are attached to the PRs; flags OFF and production mutations NONE.
