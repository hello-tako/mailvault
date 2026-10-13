# TUNG OTP BRIDGE V1: release and rollback

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: `f8af0fb0b801e79479b4102bd48cfd4ce300aaa6`.
Branch: `codex/otp-bridge-v1`; code worktree clean after implementation commit. Reports and CI are documented successors; final review HEAD, PR URL and CI run URLs are recorded in the PR receipt/final agent output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Operator-only release and rollback

This runbook is documentation, not permission to execute. During implementation: PRODUCTION_MUTATIONS=NONE, flags OFF, no merge/deploy/DNS/MX/secrets/real mail/remote migration.

1. Independent reviewer audits both final PR heads, CI receipts, dependency diff, immutability/retention and deployment-principal access. Record approver and exact SHAs; author cannot self-certify P5.
2. Operator separately approves backups/recovery bookmarks and additive migration application. MailVault 0020 and Portfolio 0062 must precede their code; preserve the full historical ledger. The MailVault read-only schema gate automatically discovers 0020. Do not rename historical Shop prefixes or drop lifetime binding/grant audit.
3. Deploy compatible MailVault export first with OFF flag; smoke owner auth, incoming queue/storage and sending. Deploy Portfolio binding/backend/UI OFF; smoke customer login, checkout/payment, fulfillment/key reveal and admin. These steps were not performed by the agent.
4. Operator provisions `OTP_BRIDGE_RPC_HMAC_KEY` in both Worker secret stores (minimum 32 characters, strong random key). Do not place values in vars/git/logs/chat. Verify live named binding, unauthorized caller denial and same account after deployment.
5. Review legitimate owner-controlled provider samples and code-owned registry change. Prove actual routing and approved alias receipt; single-unit protected API validates receiving proof and lifetime no-reuse constraints. No automatic account login or provider OTP request is implemented.
6. Separately approve MailVault/Shop flags and limited cohort, run paid test order plus cross-customer/refund/revoke tests, then observe privacy-safe outcomes and latency. Alarm on found-to-attempt anomalies, auth denials, RPC unavailability/pending exhaustion; no OTP in metrics.

Emergency rollback: disable Shop flag first to stop customer requests, then MailVault flag. In-flight requests still perform final authorization but flag propagation and network delivery are not atomic. Use authorized version rollback only to a reviewed compatible version; Worker rollback does not reverse D1. Keep additive tables, immutable binding/grant history and tombstones; never delete/rebind sold aliases to recover service. Quarantine affected binding and revoke with a reason when needed. Secret rotation requires coordinated operator action; partial rotation fails closed. Use forward repair or separately approved D1 recovery instead of improvised down migration.

Pending validations: maximum twenty leased attempts; investigate routing/policy/service before an audited operator-only retry adjustment. Do not reset alias ownership or resurrect revoked/expired grants. Lookup audit retention is thirty days; nonce retention sixty seconds; grant/binding lifetime history is permanent in V1. Legal/account deletion policy must separately assess retained minimal IDs before rollout; do not silently erase no-resale controls.
