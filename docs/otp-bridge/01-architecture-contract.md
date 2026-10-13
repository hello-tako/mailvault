# TUNG OTP BRIDGE V1: architecture contract

Repository ID: `1409350639`; canonical `takovn2/mailvault`.
Main base SHA: `9865506ba44bceb9747a1c4f5343a8467f43c120`. Implementation HEAD SHA: `f8af0fb0b801e79479b4102bd48cfd4ce300aaa6`.
Branch: `codex/otp-bridge-v1`; code worktree clean after implementation commit. Reports and CI are documented successors; final review HEAD, PR URL and CI run URLs are recorded in the PR receipt/final agent output (avoids a self-referential commit hash inside its own tree).
Author review only; independent reviewer not assigned/approved. Flags OFF; production mutations NONE.

## Versioned contract

Browser POST `/api/shop/me/orders/:orderId/otp` accepts only `{allocationId}` in at most 1024 streamed bytes. Origin, URL origin, optional Fetch Metadata, existing secure session, proof younger than ten minutes, order ownership and the exact fulfilled allocation are checked before RPC. The final grant query also checks proof/session, current customer, payment, inventory, binding, expiry and grant version in the same SQL statement. It returns only `{ok,state,code,receivedAt}` or the specified generic error/pending response. Responses use private no-store and nosniff; existing account pages additionally disable Cloudflare CDN caching.

`MAILVAULT_OTP` binds service `mail-vault`, named export `CustomerOtpReader`. Only `validateAlias` and `lookupLoginOtp` are application RPC methods. Default fetch/email/queue/scheduled behavior is preserved. No owner credentials, inbox routes or cross-D1 reads are introduced.

Both sides use secret NAME `OTP_BRIDGE_RPC_HMAC_KEY` (no value is provisioned). HMAC-SHA256 covers the JSON array `["TUNG-OTP-BRIDGE",1,operation,aliasId,providerKey,grantId,notBefore,issuedAt,requestId]`. IDs, UTC millisecond timestamps, UUID nonce and lowercase 64-hex MAC are strictly checked. Maximum issue skew is 30 seconds. `crypto.subtle.verify` verifies the MAC; a globally unique D1 nonce reserves one use with 60-second retention and bounded pruning. Operation and every mapping/window field are signed. Customer input never chooses a remote alias or provider.

`validateAlias`: `{state:active|inactive|not_found|routing_unknown,aliasId}`. It requires ACTIVE alias, domain READY/READY/OURS, a watchdog check within two hours, enabled compiled policy and visible independently trusted approved-sender receipt for that alias within 24 hours. This is read-only receiving evidence, not a DNS mutation or a promise of future delivery.

`lookupLoginOtp`: `{state:found,code,receivedAt,messageRef}` or `{state:pending|ambiguous|untrusted|unavailable}`. `messageRef` remains internal. MailVault independently clamps age to at most 120 seconds and rejects grant-preactivation/future messages. It queries exact alias, IN, COMMITTED, TRUSTED and existing visibility/tombstone/staging fences, newest first. A 21st sentinel row makes a 20-row scan fail ambiguous. Sender needs exact reviewed From AND allowlisted independently verified aligned DKIM. Full private parsed R2 text is read only to corroborate extraction and reject reset/recovery/financial/account-change purpose; max object 256 KiB, text 64 KiB. Existing `extractOtp` and shared schemas are reused. Competing distinct codes fail ambiguous. Final visible snapshot, age, alias and routing checks fence changes completed during R2 reads.

The real `muse` registry remains disabled, with empty sender/signer allowlists. Synthetic test policy exists only in test bundles. No sender address or provider behavior is guessed.

## Review receipt references

The exact file manifest is [00-preflight.md](00-preflight.md); RPC/auth decisions are [01-architecture-contract.md](01-architecture-contract.md), schema/state details are reports 02/03, commands/counts/security negatives and CI receipts are [04-security-test-matrix.md](04-security-test-matrix.md), remaining runtime prerequisites are [05-staging-certification.md](05-staging-certification.md), and operator-only recovery is [06-release-and-rollback.md](06-release-and-rollback.md). These references apply to this deliverable.

PRs: [MailVault #13](https://github.com/takovn2/mailvault/pull/13), [Portfolio #1](https://github.com/takovn2/tungjpstore-portfolio/pull/1). Independent reviewer: unassigned, not approved; drafts await separate P5 review. Initial exact-head CI: [MailVault](https://github.com/takovn2/mailvault/actions/runs/38433814625), [Portfolio](https://github.com/takovn2/tungjpstore-portfolio/actions/runs/38434002462). Final head receipts are attached to the PRs; flags OFF and production mutations NONE.
