# TUNG OTP BRIDGE V1: mailvault implementation

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: `f8af0fb0b801e79479b4102bd48cfd4ce300aaa6`.
Branch: `codex/otp-bridge-v1`; code worktree clean after implementation commit. Reports and CI are documented successors; final review HEAD, PR URL and CI run URLs are recorded in the PR receipt/final agent output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## MailVault changes

`0020_customer_otp_rpc_nonces.sql` adds only `customer_otp_rpc_nonces(request_id PRIMARY KEY, expires_at)` and its expiry index. No payload, MAC, code, sender or credentials are persisted. Existing dynamic migration-ledger deployment gate automatically requires this migration; no production migration was run.

New customer-otp modules separate strict contract, HMAC/nonces, compiled policy, trust/classification, scoped lookup and named entrypoint. `index.ts` adds one named re-export; its existing handlers are unchanged. `env.ts` declares the flag and optional secret name; Wrangler defaults `MAILVAULT_CUSTOMER_OTP_ENABLED` to string `false`. Generated Cloudflare bindings were produced by Wrangler, not manually edited. Node regression import compatibility uses a test-only WorkerEntrypoint shim; actual RPC is independently tested inside native workerd, never certified by that shim.

Errors are reduced to safe states, with no error/body/OTP logging. Reader creates nonce metadata only and does not consume, mark read, delete or copy customer mail into Shop. Existing retention remains authoritative. HTML-only or unsupported messages fail closed until a separately reviewed template supports them.

## Review receipt references

The exact file manifest is [00-preflight.md](00-preflight.md); RPC/auth decisions are [01-architecture-contract.md](01-architecture-contract.md), schema/state details are reports 02/03, commands/counts/security negatives and CI receipts are [04-security-test-matrix.md](04-security-test-matrix.md), remaining runtime prerequisites are [05-staging-certification.md](05-staging-certification.md), and operator-only recovery is [06-release-and-rollback.md](06-release-and-rollback.md). These references apply to this deliverable.

PRs: [MailVault #13](https://github.com/takovn2/mailvault/pull/13), [Portfolio #1](https://github.com/takovn2/tungjpstore-portfolio/pull/1). Independent reviewer: unassigned, not approved; drafts await separate P5 review. Initial exact-head CI: [MailVault](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462). Final head receipts are attached to the PRs; flags OFF and production mutations NONE.
