# Security boundaries audit

Date: 2026-10-07 UTC. Read-only audit of the current shared worktree, plus scoped sender-auth integration-test fixture corrections. No production data or credentials were accessed; no production operation was run. `SECURITY.md` was not edited in this pass.

## Scope and evidence limits

Reviewed sender verdict consumers, API authentication/CSRF, response CSP, service-worker caching and push behavior, rule execution, push subscription handling, Wrangler/GitHub operational metadata, and available tracked source history. Paths below are repository-relative and refer to the current shared worktree.

At the starting upstream baseline, the checkout was shallow: `git rev-parse --is-shallow-repository` returned true, and `git rev-list --count HEAD` returned 1 (`e966b67`, the selected head). Historical exposure claims therefore cover only that baseline, not earlier commits or other refs. No earlier history was deepened. A high-confidence scan of the 216 files reachable from that baseline found no PEM private-key, Cloudflare `v1.` token, or GitHub token signatures. A broader env-assignment pattern matched only `apps/worker/.dev.vars.example` and `apps/worker/test/integration/_mf.ts`; values were not emitted or copied. `.dev.vars` is ignored and is not tracked (only the example file is). No runtime secret values were read. This is a bounded source scan, not proof that every kind of secret is absent from all Git history or provider-side secret stores.

The currently documented Cloudflare Email Workers API surface still does not supply the application with a separate authenticated sender verdict. The production ingest calls in `apps/worker/src/mail/ingest.ts` invoke `assessAuth()` with MIME results, From, and envelope From only; they do not pass its optional `verifiedEvidence`. Thus new inbound messages currently remain `UNVERIFIED`, and trusted-only conveniences (including sender-specific push and unsubscribe) remain unavailable unless a verified evidence adapter is added. `VerifiedAuthEvidence` is exercised in unit tests, not wired to a production verifier. The internal assessment records an evidence `source` in `apps/worker/src/mail/auth.ts`, while `packages/shared/src/message.ts` does not declare `source` in `AuthEvidenceSchema`; typed consumers therefore cannot rely on that provenance field.

Authoritative documentation checked for that adapter boundary: [Cloudflare Email Workers API](https://developers.cloudflare.com/email-routing/email-workers/) and [Cloudflare Email Routing Postmaster](https://developers.cloudflare.com/email-routing/postmaster/). The API documents the incoming envelope, headers, raw MIME, and size; Postmaster describes DMARC enforcement, but neither documents a per-message authenticated result exposed to the Worker.

## Confirmed protections

- **Access gate:** `apps/worker/src/app.ts` applies `verifyAccessIdentity()` to all `/api/*` routes except coarse `/api/health`. `apps/worker/src/auth.ts` verifies the Access JWT signature through the configured team JWKS, issuer, audience, and expiry; requires an email claim, and applies `ALLOWED_EMAILS` when nonempty. The dev bypass in `apps/worker/src/env.ts` requires both the explicit flag and a non-production environment. Access cookie issuance and its Secure/HttpOnly/SameSite attributes are Cloudflare Access configuration, not set by this Worker; that external policy was not inspected.
- **Mutation CSRF gate:** the same API middleware calls `checkCsrf()` for every method except GET/HEAD/OPTIONS. It requires `x-mailvault` and Origin (or Referer) matching the complete request/configured origin (scheme, host, port). No CORS middleware was found in the Worker app. This is a custom-header plus same-origin defense, not a secret token.
- **Response policy:** `apps/worker/src/index.ts` wraps both API and static-asset responses with `decorateResponse()` from `apps/worker/src/security/headers.ts`. CSP denies objects, framing, forms, inline scripts, and cross-origin connections; `X-Frame-Options`, `nosniff`, same-origin resource/opener policies, and a restrictive permissions policy are also applied.
- **Mail HTML:** `apps/worker/src/security/sanitize-html.ts`, `apps/worker/src/routes/messages.ts`, and `apps/web/src/components/MessageHtml.tsx` combine server-side allowlist sanitization with an empty-sandbox Blob iframe and a restrictive iframe CSP. Remote images require the separate user action; the main app CSP does not allow arbitrary remote images or scripts.
- **Offline cache:** `apps/web/public/sw.js` bypasses all `/api/` requests and only caches same-origin static resources/navigation shell. Navigations are network-first and fall back to the shell, not cached API responses.
- **Push content:** `apps/worker/src/push.ts` sends no message payload. `apps/web/public/sw.js` subsequently fetches the unread list with same-origin credentials and `cache: "no-store"`; it selects only unread `TRUSTED` messages within a five-minute window, displays sender/subject only, masks the known primary code and URL-shaped strings, and otherwise emits a generic notification. Endpoint URLs/keys remain in D1 and are not included in API responses or logs; normal push logs use subscription IDs/counts.
- **Rules:** `packages/shared/src/rules.ts`, `apps/worker/src/mail/rules.ts`, and `apps/worker/src/routes/rules.ts` restrict rules to organization (archive/tag), not delete or delivery acceptance. Deleting a rule does not undo its stored filing action. Rules are not sender-verdict-aware.
- **Operational configuration:** the tracked Wrangler files do not configure a literal `account_id`; production secrets are referenced as platform secrets in GitHub workflow expressions rather than checked into source. `.github/workflows/rollback.yml` is manually dispatched, validates a UUID-shaped version ID, requires an explicit production rollback acknowledgement, and targets the production environment. Workflow actions are pinned to full commit SHAs in the inspected workflow files. Verification used local Wrangler/workerd and dry-run bundling only. No production deploy, rollback, remote Wrangler mutation, or GitHub secret API was invoked.

## Additional findings and residual risks

### B-1 — Arbitrary push egress (remediated application boundary)

The former endpoint validator accepted any HTTPS destination. `apps/worker/src/push.ts` now permits only port-443 HTTPS endpoints at `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, or `*.push.apple.com`; credentials and other hosts are rejected. `pushOne()` revalidates persisted subscriptions and sets `redirect: "error"` before sending VAPID authorization. `test/unit/push.test.ts` verifies destination policy, legacy-row rejection without a network call, and fail-closed redirects. Caller-defined/self-hosted push providers are intentionally unsupported. Real Worker private-network reachability, provider DNS/control, and live push delivery were not tested; application policy is not a claim about Cloudflare's complete network boundary. Provider references and the product limitation are in SECURITY.md §8.4.

### B-2 — Unverified subjects remain visible in inbox/detail/thread headings (content exposure)

The new sender gates hide inbox previews and inline OTPs in `apps/web/src/components/MessageRow.tsx`, and hide the detail body, extracted codes, links, and attachments in `apps/web/src/pages/MessageDetail.tsx` until explicit reveal. However, those components still render sender display text and the sender-controlled subject for unverified mail; thread entries also render each message subject. React renders these as text (not an active HTML/link), but a sender can put a code, URL, or deceptive instruction directly in the subject, bypassing the preview/body/code presentation gates. Push is safer because it only quotes `TRUSTED` mail. This is an observed residual, not a demonstrated script execution issue.

### B-3 — Rules may archive unverified mail

Ingest applies `applyRules()` in `apps/worker/src/mail/ingest.ts`; `RuleFacts` in `apps/worker/src/mail/rules.ts` has no verdict field. Rules can match sender domain, subject, alias/domain, code, and attachment, and can archive/tag regardless of `auth_verdict`. Archive is non-destructive and the filed view retains the message, but a sender-controlled subject/domain may cause unverified mail to leave the default inbox. The rule API is Access-gated and owner-configured. Treat trust-aware rule policy/visibility as a product decision; no destructive rule action was found.

### B-4 — Root-document HSTS gap (remediated locally)

The previous decorator attached HSTS only to API responses. It now attaches HSTS to all production HTTPS responses, including the root HTML, static assets, errors, and API responses; HTTP and development responses are excluded. `test/unit/headers.test.ts` reproduced the missing document header before the patch and passed afterward. Real Cloudflare edge HSTS configuration remains outside this local evidence.

### B-5 — CSRF origin comparator (remediated defense-in-depth)

The previous comparator ignored the scheme and parsed malformed Referer outside its exception handler. It now compares complete serialized origins and fails closed on invalid input. `test/unit/headers.test.ts` reproduced same-host wrong-scheme acceptance before the patch, then verified scheme/port/host rejection and malformed Referer handling. The prior custom-header/no-CORS controls were not weakened; no prior browser exploit was demonstrated.

### B-6 — Subject masking in push is intentionally narrow

`safeSubject()` in `apps/web/public/sw.js` replaces URL-shaped strings and only the parsed `primaryCode`. It does not promise to redact every other number or secret-like token in an otherwise `TRUSTED` sender's subject. The notification contains no body and excludes untrusted senders, but device lock-screen policy and sender-auth availability remain user/device considerations.

## Sender-test fixture correction in this pass

Added `apps/worker/test/integration/_auth-fixtures.ts`, which represents an independently verified, aligned DKIM pass in test auth JSON (`source: cryptographic-verifier`), not in MIME `Authentication-Results`. Updated `apps/worker/test/integration/send.test.ts`, `apps/worker/test/integration/mailbox.test.ts`, and `apps/worker/test/integration/sending-via.test.ts` positive reply fixtures to carry this verifier metadata. The explicit unverified-parent refusal test remains unverified and continues to assert `UNVERIFIED_PARENT`. The fixture-only correction itself did not bypass production verification; other remediation changes and migrations are inventoried in REVIEW.md.

### B-7 — R2 writer completion is not implied by lease expiry (P1 / unknown / blocked)

`0018`/`0019` persist outbound/inbound object intents before PUT, fence deletion and
alias purge, and retain cleanup identifiers. Inbound tombstones without message rows
are re-swept hourly; message-backed cleanup observes semantic/outbound/inbound writer
fences. Alias completion requires a settled writer snapshot followed by successful
cleanup. Tests inject deletion while an attachment PUT is held, writer exit followed
by a late PUT, transient DELETE failure, and semantic-upsert concurrency. RED receipts
show false alias DONE and missing scheduled cleanup; GREEN asserts repeated cleanup
and refuses DONE for unknown completion. This establishes application behavior locally,
not Cloudflare's maximum completion latency or crash cancellation guarantee.

An expired unsettled inbound writer remains blocked; no automatic certainty or manifest
retirement is inferred. Outbound uncertain staging and semantic completion after a dead
worker also remain P1 unknowns. Retained tombstones trade unbounded metadata growth for
recoverability; operational monitoring and a reviewed retirement proof remain required.
