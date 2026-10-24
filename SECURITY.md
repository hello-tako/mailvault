# MailVault Security Model

This document maps the security requirements for a private, internet-facing
mail storage and sending system onto the actual implementation, and states the threat model.
Email is treated as **hostile input at every layer**.

Scope: personal/self-hosted use by a single owner behind Cloudflare Access. Not
multi-tenant SaaS.

---

## 1. Trust boundaries

```
Internet ──SMTP──▶ Cloudflare Email Routing ──▶ Worker.email()   [untrusted input]
Browser ──HTTPS──▶ Cloudflare Access ──JWT──▶ Worker.fetch()      [authenticated]
Buyer ──HTTPS──▶ /c/:token (no Access) ──▶ Worker.fetch()         [bearer link, one alias]
                     Worker ──token(secret)──▶ Cloudflare API     [privileged egress]
                     Worker ◀──▶ D1 / R2                          [private storage]
```

The owner's browser is untrusted for CSRF; the sender of any email is entirely
untrusted; the Cloudflare API token is the single most sensitive secret.

---

## 2. Secrets & the Cloudflare API token

**Rule:** the runtime token exists _only_ as a Worker secret.

- Typed as a secret binding in `apps/worker/src/env.ts`
  (`CLOUDFLARE_API_TOKEN?: string`). Set with `wrangler secret put` (prod) or
  `.dev.vars` (local). Never a plain-text `vars` value.
- The Cloudflare client is constructed per-request from `env` in
  `apps/worker/src/routes/_helpers.ts` → `cfClient(env)`. If unset it throws a
  `503 CLOUDFLARE_TOKEN_UNSET` and **never** echoes the value.
- The token is never placed in a response body, D1 row, R2 object, or the browser.
- Least-privilege: the token only needs _Email Routing_ + _Zone/DNS read+edit_ on the
  owner's zones. A Global API Key is **not** supported or required.
- Log scrubbing: `apps/worker/src/lib/logging.ts` allow-lists safe fields and
  redacts a set of keys (`token`, `authorization`, `cf_authorization`, `api_key`,
  `cloudflare_api_token`, `raw`, `body`, `otp`, `code`, `jwt`, `cookie`) to
  `[redacted]`. Error messages are truncated and never include request headers.

**Why it matters:** a leaked token would let an attacker mutate DNS/mail for every
domain in the account — the blast radius is the whole account, so it is isolated as a
secret and scrubbed from every log path.

## 3. Authentication (private by default)

`apps/worker/src/auth.ts`:

- Identity comes from a Cloudflare **Access** application JWT, validated with `jose`
  against the team's remote JWKS: signature, issuer (`team domain`), audience
  (`CF_ACCESS_AUD`) and expiry are all verified. Preferred source is the
  `cf-access-jwt-assertion` header, falling back to the `CF_Authorization` cookie.
- An optional `ALLOWED_EMAILS` allowlist further restricts which Access users are
  honored; an empty list means "any authenticated Access user".
- Service tokens (no `email` claim) are rejected.
- The only **public** endpoints are `GET /api/health` (coarse liveness) and the customer code
  portal below. Everything under `/api/*` is authenticated in `apps/worker/src/app.ts` before
  routing; unauthorized requests get `401 UNAUTHORIZED`. No stack traces leak (Hono `onError`
  returns a structured `{ error: { code, message } }`).

### Customer code portal — the one deliberately public read (`src/routes/portal.ts`)

A buyer needs one number from one mailbox, so that is the whole surface.

- It lives **outside** `/api/*`, and `src/index.ts` routes `/c/*` to the Hono app while every
  other path still falls through to the SPA. Nothing about the portal may be moved under
  `/api`, because that prefix is where the Access gate lives.
- On the portal's own hostname (`PORTAL_ORIGIN`), `/c/*` is the **only** thing served: every other
  path, including `/api/*`, is refused before it reaches a router. A public domain must not host a
  login-less look-alike of the owner's app, and one fewer surface is one fewer thing to get wrong.
  The mailbox hostname is unaffected — the rule is keyed on the host, not the path.
- The credential is the URL: 192 random bits, one per sale, scoped to one alias, stored only as
  a SHA-256 hash (`migrations/0013_portal_grants.sql`). A leak of D1 hands over no working link,
  and there is no enumerable column to attack — a guessed token has a 1-in-2^192 chance.
- It can answer four things: the newest code that arrived in the last 30 minutes in mail that
  passed authentication, its age in seconds, its kind, and the address it arrived at. The
  response key set is pinned by a test, so widening it is a deliberate edit rather than a
  slip. Subject, body, attachments, links and message lists are never reachable through it.
- Two rules the inbox does not apply, because nobody is reading context: a confidence floor of
  `0.6` (Meta's footer postcode scores 0.47 and appears in *every* message it sends) and a
  30-minute window. A `SPOOFED` message never yields a code whatever it claims — that number is
  the payload a phisher wanted somebody to type somewhere.
- Time-bounded, optionally look-capped, and revocable by a timestamp so the record of who saw
  what outlives the sale. Responses are `no-store`, `noindex`, `frame-ancestors 'none'`, and the
  page writes with `textContent` only.
- Per-isolate throttle on page views and malformed tokens. Best-effort by design: it raises the
  cost of scraping, the token is what actually defends the mailbox.
- Logs carry the grant id and the code's age, never the token and never the code.

### Dev bypass cannot reach production
`apps/worker/src/env.ts` → `devAuthBypassEnabled()` returns true **only** when
`DEV_AUTH_BYPASS=="true"` **and** `ENVIRONMENT` is one of `development/local/test`.
Production config ships `ENVIRONMENT=production`, so the bypass is inert regardless of
the flag. This is a configuration guard, not a deployment boundary: an operator could
mislabel a public deployment as development. Production configuration and Access policy
must be verified separately.

### Passkey step-up (`apps/worker/src/routes/security.ts`, `src/lib/webauthn.ts`)

Access answers _which account_ signed in. A step-up answers _is the same person holding
this device right now_, so a copied session cookie cannot do the irreversible things on its
own. It is asked for, by the route rather than the page, before:

- purging an alias's stored mail (`DELETE /api/aliases/:id` with `purgeMessages`) — a plain
  alias delete, which keeps the mail, does not ask;
- permanently deleting a message, singly or in bulk;
- detaching a domain from MailVault;
- setting a domain's sender-auth policy to `OFF` (tightening it never asks);
- removing any passkey, including the last one, and turning off semantic indexing;
- replacing foreign MX, catch-all routing, or DMARC configuration after fresh server preflight;
- enrolling an additional passkey once one exists — otherwise a hijacked session could
  quietly add the attacker's key and the gate would be theirs.

How it works: the browser's authenticator signs a single-use challenge (60s), and the
Worker returns a bearer grant valid for 5 minutes. Only its SHA-256 is stored, so reading
D1 cannot mint someone else's unlock; the grant lives in memory in the tab and is gone on
reload. `userVerification: required`, so the prompt must be a fingerprint, passcode or
security key rather than mere presence.

Boundaries worth stating: the relying-party id is the canonical `APP_ORIGIN` host, so a
passkey enrolled on one hostname will not unlock another hostname. Removing the **last**
passkey still needs a valid grant and revokes existing grants. There is no Access-only
break-glass deletion endpoint. Initial enrollment is allowed when no key exists; losing
every authenticator requires an independently authorized operator recovery procedure,
not a copied Access session. Irreversible operations fail closed without a valid grant,
including when there are no enrolled keys.
The residual risk is unchanged by this feature: whoever holds your Access session can still
read everything. Step-up protects what cannot be undone, not confidentiality.

## 4. CSRF & same-origin

`apps/worker/src/security/headers.ts` → `checkCsrf()`, wired as middleware after auth:

- State-changing methods (anything but GET/HEAD/OPTIONS) must carry the custom header
  `x-mailvault: 1`. A cross-site form cannot set custom headers.
- `Origin` (or `Referer`) must match the complete request origin (scheme, host,
  port) **or** the configured `APP_ORIGIN`. This is why E2E/dev run same-origin.
- Failures return `403 BAD_ORIGIN`.

## 5. Response hardening (every response)

`decorateResponse()` in `index.ts` wraps **both** the API and the static-asset path,
so success, error, 404 and SPA-document responses all get:

- `Content-Security-Policy`: `default-src 'self'`; `script-src 'self'`;
  `frame-ancestors 'none'`; `form-action 'none'`; `object-src 'none'`;
  `base-uri 'none'`; `connect-src 'self'`; `img-src 'self' data: blob:`;
  `frame-src 'self' blob: data:` (for the sandboxed email frame).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Cross-Origin-Resource-Policy/Opener-Policy: same-origin`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy`.
- `Strict-Transport-Security` on every HTTPS response in production, including
  the root document and static assets; not on HTTP/development responses.

## 6. Email content handling (hostile input)

Parsing: `apps/worker/src/mail/parse.ts` uses `postal-mime`; the raw `.eml` is always
kept in R2 so nothing is lost even on degraded parses (`parseDegraded`).

Sanitization: `apps/worker/src/security/sanitize-html.ts` (`sanitizeEmailHtml`):

- Drops `<script>`, `<style>`, `<iframe>/<object>/<embed>/<form>` and similar **together
  with their contents** — the element's text is discarded, not escaped, so a stripped
  script cannot leave its source visible in the message. Unknown tags are removed while
  their inner text is HTML-escaped, so leftover text can never execute.
- `javascript:`/`data:`/`vbscript:` and other unsafe URLs are stripped from `href`.
- Remote images are **blocked by default**; they render only when the owner opts in
  per-message (`?remoteImages=1`), because loading them discloses the reader's IP and
  that the mail was opened.
- Surviving links get `rel="noopener noreferrer"`.

Rendering: the SPA's `MessageHtml.tsx` injects the sanitized HTML into an
`iframe` with `sandbox=""` (no scripts, no same-origin, no forms) loaded from a
Blob URL with its own `<meta http-equiv="Content-Security-Policy">` and
`<base target="_blank">`. Email markup is never added to the top-level document.
The frame document also gets a `<meta viewport>` and a rule neutralising
`width="…"` on tables and cells: mail layout is built from fixed-width tables, and
without that a 700px mail overflows a 360px phone frame and has to be panned.

Plain text is rendered by `TextBody.tsx`, never as markup: blocks are split on blank
lines, indented blocks (ASCII tables, signatures) stay verbatim in a box that scrolls by
itself, and other lines are re-flowed with the mailer's incidental hard breaks removed.
Bare `http(s)` addresses become links with `rel="noopener noreferrer nofollow"`; nothing
else in the body is ever interpreted as HTML.

## 6.1 Verification links (`apps/worker/src/mail/links.ts`)

The owner is being asked to hand a token to whatever they tap, so extraction is
conservative and the UI shows the whole address:

- **Folded addresses are re-joined** only when the fragment stops at a character that
  cannot end a URL, or the continuation carries query syntax. Guessing on mid-word breaks
  would glue the next prose line onto a complete address — a visibly truncated link is
  safer than a silently wrong one.
- **Click-through wrappers are unwrapped** (`/CL0/https:%2F%2F…`, `?url=…`). The address as
  sent stays the link that is opened, while `destination` records where it leads; the card
  names the destination host and says it arrived behind a tracking host, and offers
  "Open as sent" separately.
- A wrapped link and its direct twin **collapse into one entry**.
- Entities (`&amp;`, `&#38;`) are decoded before use, and sentence punctuation is trimmed
  with balanced-bracket awareness, so `…/compare(a,b)` keeps its `)` and `…/verify.` loses
  its period.
- Nothing is ever fetched or preflighted server-side; a link opens only on an explicit
  click.

## 6.2 Sender authentication (`apps/worker/src/mail/auth.ts`)

An OTP inbox is a phishing target: anyone who learns an alias address can deliver a
message that looks like it came from a brand. Message authentication observations and
their provenance are stored in `messages.auth_verdict` and `auth_json`.

- **MIME authentication headers are observations only.** Both `Authentication-Results` and
  `Authentication-Results-IANA` are sender-controlled message content. A reporter string
  such as `cloudflare.com` is not an attestation, and even an aligned `d=`, `header.d=`,
  `header.i=`, or `smtp.mailfrom=` pass is not proof of provenance. These observations are
  retained for explanation but never set `alignedPass` or determine the trust verdict.
- **Verified DKIM is the only verified sender result.** Cloudflare's
  [Email Workers API](https://developers.cloudflare.com/email-routing/email-workers/)
  documents an `EmailMessage` that exposes envelope addresses, headers, raw MIME, and
  size; it does not document a receiver-authenticated SPF/DKIM/DMARC result. Cloudflare's
  [Postmaster documentation](https://developers.cloudflare.com/email-routing/postmaster/)
  describes inbound DMARC rejection, but does not expose its result to the Worker. MailVault
  therefore verifies DKIM cryptographically against the raw bytes during staging (see
  `docs/sender-auth/SENDER_AUTH_V1.md`). SPF and DMARC are not verified here. We do not infer
  authentication from transport acceptance or a MIME reporter name.
- **Verdicts require separate verified evidence.** `TRUSTED` requires an independently
  verified aligned DKIM pass; `SPOOFED` requires an independently verified aligned DMARC
  failure. No verified DMARC result is supplied, so raw `dmarc=fail` does not reject
  delivery. The stored per-domain `OFF`/`WARN`/`REJECT` preference remains, but `REJECT` has
  no effect until a verified DMARC result is supplied.
- **Unverified inbound content is withheld, not just labelled.** The inbox hides previews
  and extracted codes; the detail hides the body, codes, links, and attachments behind an
  explicit "Show anyway". Replies require `TRUSTED`. Unsubscribe and push detail are also
  available only for `TRUSTED` messages.
- **Historical inbound verdicts were revoked.** Migration `0016` resets every inbound verdict
  to `UNVERIFIED` and clears its assessment JSON because prior rows have no trustworthy
  provenance. Outbound verdict metadata is left unchanged.

### 6.3 Ingest durability — `apps/worker/src/index.ts` (`email` + `queue`)

Inbound mail is committed in two invocations with resumable database failure handling:

- The **email handler** validates the recipient, parses, judges the sender and writes the
  R2 objects (raw `.eml`, parsed JSON, attachments). Only then does it post an `IngestJob`
  to the `mail-ingest` queue. Every `setReject()` decision — unknown recipient, oversize,
  or a `REJECT` policy on a verified spoofed sender — still happens here, because this is the
  only place still able to answer the sending server. Raw MIME results cannot trigger it.
- Before the first R2 PUT, the email handler records every object key in a durable D1
  manifest (`0019`). Deletion/alias-purge tombstones fence writers. Settled, unlinked
  tombstones are cleaned by scheduled processing; manifests are retained and re-swept
  hourly even after an empty pass, so late remote writes remain discoverable.
  Message-backed manifests are cleaned through deletion jobs, preserving writer fences.
- Lease expiry is not proof that a remote PUT stopped. An unsettled writer cannot yield
  a successful purge receipt; deletion remains pending/failed with identifiers retained.
  STAGED queue/DLQ input is not expired or erased merely because its lease is old.
- The **queue consumer** uses the staged `messageId` as the canonical D1 id and reconciles
  message metadata, attachment rows and FTS in a D1 batch. Rules and opt-in semantic indexing
  have retryable lifecycle states; failures retry instead of acknowledging incomplete work.
  A job that exhausts its retry budget is parked in `mail-ingest-dlq` with its staged R2 keys.
- A replay of the same staged job is idempotent. A different job with the same content is
  treated as a true duplicate only after the canonical record is fully committed; cleanup
  deletes only its own objects proven unreferenced by D1.
- `received_at` and the raw-key date partition come from receiver-side arrival time;
  a valid MIME `Date` is preserved independently in nullable `header_date`.

**The queue carries keys and SMTP addressing only** — `rawKey`, `parsedKey`, alias/domain
ids, dedupe key, envelope. No subject, body, extracted code or link crosses it, verified by
test. That matters because a queue and its dead-letter are a second store the owner does
not browse; they must not quietly become an unauthenticated copy of somebody's mail. R2
holds canonical raw/parsed bodies and attachments; D1 also stores metadata and extracted
facts, and the opt-in vector index holds derived representations.

Codes, links, preview and the auth verdict are _re-derived_ at commit time from the staged
parse by the same pure functions — one assessment per message, and the stored verdict
cannot disagree with the one that was judged at the edge.

The operator tool `apps/worker/scripts/ingest-dlq.mjs` is read-only by default. It peeks
without leasing from the DLQ, classifies each key-only job against D1 and private R2, and
prints identifiers and state only. Configure `CF_ACCOUNT_ID`, `MAIL_INGEST_DLQ_ID`,
`MAILVAULT_D1_ID` (optional when the Wrangler config is current), and `CLOUDFLARE_API_TOKEN`,
then run `node apps/worker/scripts/ingest-dlq.mjs`. Add `MAIL_INGEST_QUEUE_ID` and pass the
explicit `--replay` flag to enqueue eligible jobs to `mail-ingest`; replay does not remove
or acknowledge the DLQ source. The tool never logs message content or credentials.

### 6.4 Live updates — `apps/worker/src/live/hub.ts`, `apps/web/src/lib/live.ts`

`GET /api/live` upgrades to a Durable Object websocket so an open tab learns that mail
landed without waiting for a pull-to-refresh.

- The frame the hub ever sends is `{"type":"hello"}` or `{"type":"new-mail"}`. **No sender,
  subject, code or link crosses the socket.** The tab reacts by refetching through
  `/api/*`, which is where access control actually lives, so the socket inherits it rather
  than bypassing it.
- The route sits behind the same Access verification as every other `/api/*` handler, and
  the hub instance is keyed by the authenticated address, so a second identity on the team
  cannot even observe that the owner's mail arrived.
- The client ignores any frame that is not the nudge and never renders socket data.
- `connect-src 'self'` covers the same-origin `wss://` handshake — verified live, not
  assumed, and covered by an E2E test that completes a real handshake and waits for the
  first frame.

### 6.5 Semantic search — off until the owner turns it on (`apps/worker/src/lib/semantic.ts`)

Keyword search (FTS5) needs the exact words. Semantic search does not, and the price is a
**second copy of message content**: enabling it embeds the sender, subject and the first
~900 characters of the body into a Vectorize index in this Cloudflare account.

So it is a deliberate switch in Settings, off by default, and:

- no new indexing is scheduled while it is off — not on ingest, not on search, not on
  backfill (`POST /api/semantic/backfill` refuses). An already-active remote writer
  may complete after disable; disabling is not a synchronous external-purge guarantee;
- a client cannot ask for semantic ids. `semanticIds` is a server-side parameter resolved
  from the index only when the setting is on, so the opt-in cannot be bypassed by crafting
  a query;
- turning it off stops new semantic work and attempts a bounded, paginated purge of
  indexed vectors. A provider failure can leave copies behind; inspect `indexed / total`
  and retry the authenticated disable request. The toggle alone is not a purge receipt;
- message deletion retains its vector id in a durable cleanup job until deletion succeeds;
- the excerpt is truncated on purpose — less text in the index is less text to explain.

`indexed / total` is shown in Settings, so the claim is checkable rather than taken on
trust. The residual risk is the obvious one: an index of derived representations of mail
sits in the same account as the mail itself, protected by the same Access policy.

## 6.3 Unsubscribe (`List-Unsubscribe`) — offered only to an aligned sender

`parseMime` stores the sender's `List-Unsubscribe` and whether it declared
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Both are **sender-authored
text**, stored verbatim, and only rendered by the reading view when the message's verdict is
`TRUSTED` — which requires independently verified aligned sender-auth evidence.

Why the gate is the verdict and not the URL's shape: hitting an unsubscribe endpoint proves the
address is read by a human. That is a thing a forger is happy to buy, so a message that failed
authentication offers nothing to click and says why in one line. An aligned sender's URL is the
sender's own domain, and it is presented as a link the owner chooses to open —
`target=_blank`, `rel="noopener noreferrer nofollow"`, never fetched by the app itself, which
would confirm the address from the server's own IP and put this app in the path of a request
between a subscriber and a sender.

The mailto form is offered alongside: it is the fallback for a sender without one-click, and it
composes from the owner's mail client rather than from anything MailVault sends.

## 7. Attachments

`apps/worker/src/routes/messages.ts` (download route) + `apps/worker/src/lib/filename.ts`:

- Attachment bytes live in the **private** R2 bucket; there are no public URLs and no
  permanent links. The only access path is the authenticated
  `GET /api/messages/:mid/attachments/:aid`, which verifies the message belongs to the
  caller's data before streaming.
- Download responses force `Content-Disposition: attachment` with a sanitized
  filename (directories, control chars, path traversal and a restrictive charset are
  stripped; extension preserved), plus `X-Content-Type-Options: nosniff` and
  `Cache-Control: private, no-store`. Dangerous types are never inlined.
- **Sent mail keeps its files too.** They arrive in the compose request as base64, are decoded
  once, and are stored as the bytes that left — under the same key scheme and the same
  authenticated route as received attachments. The `.eml` record is the assembled
  `multipart/mixed` message, so downloading a sent message returns the whole of it.
- A filename is the one part of a file its sender chooses, and it is written into MIME headers on
  the way out. The wire copy and the R2 key use `sanitizeFilename()`; the row keeps the owner's
  original name for display. A name carrying CRLF therefore cannot add a header line, which
  `test/integration/send.test.ts` asserts against the stored record rather than in a unit test.
- Size is judged on the assembled message, not part by part: base64 adds a third to every file and
  the platform's 5 MiB ceiling counts bodies, headers and files together. A compose that would not
  fit is refused before a row, an object or a send — so a refusal leaves nothing behind.

## 8. Alias safety — refuse unknown mail

`apps/worker/src/mail/ingest.ts`:

- Inbound acceptance is gated on an **ACTIVE alias row** in D1 matched by normalized
  recipient address. Unknown recipients are **rejected** (`message.setReject`) and are
  **never auto-created** — so the domain cannot be turned into a spam sink by
  guessing addresses. Mail to a `DISABLED` alias is rejected too (history preserved).
- Delivery is idempotent via a UNIQUE `dedupe_key`, so Cloudflare retries after a
  persistence throw cannot duplicate messages.
- Messages over `MAX_MESSAGE_BYTES` are rejected; the configured ceiling is clamped to
  Cloudflare's ~25 MiB inbound limit (`env.ts`).

## 8.1 Notifications (Web Push) — `apps/worker/src/push.ts`, `apps/web/public/sw.js`

- **The push carries no content; the worker asks for it afterwards.** The server sends a
  bodyless POST, so the push service sees an empty request (`test/unit/push.test.ts` asserts
  that). The service worker then calls `/api/messages?filter=unread` with its own session
  cookies and quotes the newest message that is unread and `TRUSTED` (verified aligned SPF/DKIM/DMARC)
  and minutes old — sender plus subject only, with any code the server identified masked and
  URLs collapsed to `[link]`. Everything else (signed out, offline, Access answering instead
  of the API, nothing recent, a spoofed sender) falls back to the fixed "New mail arrived".
  `src/lib/notify.test.ts` covers those rules; the phone E2E runs them inside the installed
  worker, where the real cookies live.
- **What that costs, deliberately:** the subject of _trusted_ mail now appears on the lock
  screen of every device holding the installation, without an Access prompt. Codes and
  unauthenticated senders are excluded exactly because a spoofed message choosing its own
  lock-screen text is the attack this product attracts. OS "hide content when locked" is the
  remaining lever.
- **A push endpoint is a bearer credential**, so it is stored only in D1, never returned by
  any API response, never logged, and never cached by the service worker. `/api/push/status`
  reports a count, not the endpoints; the integration test asserts the response body does not
  contain the stored URL.
- **Validation + self-healing.** `isUsableEndpoint` accepts only HTTPS port 443 endpoints
  for Chrome/Chromium's `fcm.googleapis.com`, Firefox's
  `updates.push.services.mozilla.com`, Edge's `*.notify.windows.com`, and Safari's
  `*.push.apple.com` ([Chrome](https://developer.chrome.com/blog/web-push-interop-wins) and
  [FCM host](https://firebase.google.com/docs/cloud-messaging/network-configuration),
  [Mozilla](https://mozilla-services.github.io/autopush-rs/http.html),
  [Edge/WNS](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/forcebuiltinpushmessagingclient) and
  [WNS host allowlist](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/firewall-allowlist-config),
  [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.md)).
  Credentials, non-443 ports, IP literals, and other hosts are rejected, and sends use
  `redirect: "error"`. Caller-defined and self-hosted push providers are deliberately
  unsupported. Re-subscribing the same endpoint updates keys and clears the failure counter
  rather than duplicating rows, a `404/410` prunes immediately, and repeated failures prune
  after 5 attempts so dead endpoints cannot accumulate.
- **Push can never break delivery.** Notification is fired with `ctx.waitUntil` after the
  message is durable, and `pushToAll` never throws — an unreachable push provider cannot
  reject or duplicate a real email.
- **The VAPID private key is a Worker secret** (`VAPID_PRIVATE_KEY`, a P-256 JWK). The public
  half is derived from it, so the two can never disagree, and the derivation is checked
  against `crypto.subtle`'s own `raw` export.
- **Push destination policy is enforced independently of owner authentication.** A signed-in
  owner can register only an endpoint from the provider allowlist above; legacy stored rows
  are revalidated before sending as well. VAPID authorization is scoped to the permitted
  endpoint's origin, redirects fail closed, and no message payload is sent.
- The service worker never caches `/api/*` and never proxies a cross-origin request, so the
  offline shell cannot become an unaccessed copy of private mail.

## 8.5 Sending mail — `apps/worker/src/mail/send.ts`, `apps/worker/src/routes/sending.ts`

An inbox that can send is an open relay until proven otherwise, so the send path is built as
a chain of refusals, each with its own reason code that the UI translates.

- **`From` is never free text.** It must normalise to an **ACTIVE alias row** in this
  mailbox. Nothing can be sent as an address nobody created, and no request can name an
  arbitrary sender — the same rule that keeps unknown recipients from being auto-created on
  the way in keeps forged identities out on the way out.
- **A reply's recipient comes from the stored message**, not the request: `Reply-To` first,
  then `From` (and the original `To` when answering your own sent mail). A crafted body
  cannot point a reply at somebody who never appears in the conversation.
- **Answering inbound mail requires `TRUSTED`.** Replies to `SPOOFED` or `UNVERIFIED` messages
  are refused before the transport is consulted, so an unavailable sending binding never
  obscures the authentication refusal.
- **The message is written before it is sent** (raw copy + parsed body in R2, metadata row
  with `direction='OUT'`), then updated with what the transport said. A send that succeeds
  while the database is unhappy cannot produce mail the owner sent and never sees again; a
  send that fails leaves a record marked `FAILED` with the reason.
- **Files are sent, and kept.** A compose may carry up to 8 files, base64 in the request; each is
  decoded once, written to R2 beside the message, and recorded in `attachments`, so it reads back
  through the same authenticated download route as received mail (§7). The bytes handed to the
  binding and the bytes in the `.eml` record are the same ones, and both carry the sanitized
  filename — a name is sender-chosen text that reaches a header.
- **Per-domain opt-in, with a visible consequence.** Sending is refused unless
  `domains.sending_status='ENABLED'`, and only an explicit owner action sets it. That action
  shows the exact DNS records Cloudflare's read-only preview says it will write, because
  Email Sending creates a **domain-wide DMARC record** — a policy that also covers senders
  MailVault knows nothing about. An existing `_dmarc` needs both a ticked confirmation and a
  passkey step-up, in the same shape as an MX or catch-all takeover.
- **Reputation is the domain's own**, not a shared relay's: Cloudflare signs with that
  domain's DKIM key and returns bounces to `cf-bounce.<domain>`.
- **Delivery is reported per destination.** `messages.send_status` is a summary of
  `message_recipients`, which holds one row per (message, address) — see §8.6.
- **Budget is counted locally.** Cloudflare's `/email/sending/limits` counter was measured to
  lag (three sends left it unchanged), so the daily ceiling (`MAX_SENDS_PER_DAY`, default 50)
  is enforced against `messages` rows, not against that endpoint.
- **A domain may send through one of its own subdomains, and that is a choice, not a default.**
  Email Sending is onboarded per name inside a zone, so `send.example.com` can be signed for while
  `example.com` is not. Choosing it writes no DNS and changes no receiving record — it moves the
  DMARC policy Email Sending insists on onto a name nothing else sends from. The wire address is
  then `<local>@send.example.com` with `Reply-To` on the alias that actually receives, both derived
  from the alias row and the domain row and never accepted from the request, so a compose cannot
  aim its own sending identity. Changing the choice clears the remembered sending status, because
  the verdict that was true of the old name says nothing about the new one.
- Nothing is sent on load, on a schedule, or by a webhook. There is no automatic reply,
  no vacation responder, and no forwarding to a third party anywhere in the send path.

### 8.6 Delivery events — `apps/worker/src/mail/delivery.ts`, `src/db/recipients.ts`

Email Sending publishes lifecycle events to a queue (`mail-delivery-events`) through a Queues
event subscription, one record per (message, recipient). That makes the queue a second inbound
write path into the owner's mail rows, so it is held to the same narrowness as the others:

- **The queue is not a source of content.** An event carries a message id, one address, a
  status and an SMTP line — never a body. The consumer reads it, updates two rows, and
  acknowledges. It never touches R2, so a delivery event cannot be used to pull mail content
  into a response or a log.
- **A message id this mailbox never sent is dropped, not retried.** The lookup is scoped to
  `direction='OUT'`, and an unmatched id is acknowledged and counted. Retrying could never
  make an unknown id known, and a poison loop on somebody else's events would cost the ingest
  queue its concurrency.
- **Ids are matched bare.** Both sides strip angle brackets before comparing, because the
  provider reports `a@b` where a header would read `<a@b>`; a mismatch there would leave every
  sent message reading "queued" forever, which is the failure this feature exists to remove.
- **A status can only move forward.** Events for one message arrive in whatever order the
  queues deliver them, so each row stores a rank and the upsert refuses a lower one — a late
  `deferred` from a retried attempt cannot undo a `delivered` that already happened. The guard
  is inside one `ON CONFLICT … WHERE` so two concurrent batches cannot interleave around it.
- **Nothing is derived from an address in an event.** The row it names already holds that
  address; an event for an address the send never recorded is stored as a destination of that
  message (the send may predate the tracking) and is never used to route or rewrite anything.
- The SMTP line is stored on the message for the owner's own reading, capped at 500
  characters, and kept out of logs and Analytics Engine, where an address could otherwise ride
  along with it.

### 8.7 Bulk operations — `POST /api/messages/bulk`

A control that acts on many messages at once deserves the same scrutiny as one that deletes a
whole alias:

- **The action is a closed vocabulary, and so is the column it moves.** `read`, `unread`,
  `star`, `unstar`, `archive`, `unarchive`, `delete` map to three hard-coded column names
  through a lookup table; nothing from the request reaches the SQL text.
- **The id list is bound, never interpolated**, and capped at 200 — the same size as a list
  page — so one request cannot turn into an unbounded statement.
- **A count means what it says.** A flag flip only writes rows whose value actually differs,
  so `affected` is the number of messages that changed rather than the number clicked.
- **Delete is delete.** It removes the row, its FTS entry and its raw/parsed/attachment
  objects, and the embedding goes with them. There is no bulk path to anything a rule filed:
  unarchiving is the only way back, and nothing here deletes a domain, an alias or a zone.
- Ownership adds no clause because this mailbox has exactly one owner behind the same Access
  gate as every other route; the id list is filtered by existence, in the same shape as the
  single-message routes it sits beside.
- Mail is still only removed when the owner asks. There is no bulk expiry, no "delete older
  than", and no selection that survives a reload to be acted on later.

## 9. Domain provisioning safety (the highest-risk feature)

`apps/worker/src/provisioning/` + `apps/worker/src/routes/domains.ts`:

- **Zero mutation on startup/deploy.** The Worker entrypoint never enables Email
  Routing, touches MX, replaces a catch-all, or provisions a zone. `sync` is read-only
  discovery.
- **Preflight is read-only** (`preflight.ts`) — proven by `test/unit/preflight.test.ts`
  asserting an empty mutation list. It classifies each zone and returns evidence.
- **Foreign MX is never overwritten _by default_** (`mx.ts`): Google Workspace, Microsoft 365,
  Zoho, Fastmail, Yahoo, Apple, Proton, Mimecast, Proofpoint, Barracuda, SpamTitan, IONOS,
  Amazon SES, Migadu and Yandex 360 signatures — and _any_ non-Cloudflare host — mark
  `MX_CONFLICT` → `safeToProvision=false`, default **skip**. Only Cloudflare Email
  Routing MX counts as "ours". The IONOS/SES/Migadu/Yandex entries were added from
  hostnames actually observed in the owner's account.
- **An MX take-over exists, and it is the owner pulling the trigger** (`allowMxTakeover`):
  the Domains UI lists the exact records that will be deleted per selected domain, the
  confirm is a separate checkbox from the catch-all one (a catch-all confirmation buys no
  MX deletion — tested), and each record is written to `provisioning_events` _before_ it is
  removed so the domain can be handed back. Matching requires `type === "MX"` plus an
  exchange the preflight named as foreign, so Cloudflare's own routing MX cannot be caught.
  Nothing but MX is touched: enabling routing does not add a second SPF, so deleting the
  provider's SPF/DKIM/DMARC would break the owner's outbound mail for no inbound gain
  (measured on a live take-over).
- **`DOMAIN_DENYLIST` (a Worker var) is checked before any mutation**, whatever the flags
  say. It exists for domains the owner runs another mail product on — they are refused with
  an explicit message rather than silently skipped, so the reason is visible in the UI.
- **Foreign catch-all** marks `CATCH_ALL_CONFLICT`; a takeover requires an explicit
  `allowCatchAllTakeover` confirmation from the owner (surfaced in the Domains UI).
- **Provisioning is allow-listed, not block-listed** (`provisioner.ts`). It mutates only
  when preflight returns `READY_TO_PROVISION`, `ALREADY_CONFIGURED`, or a conflict _with_
  the matching explicit confirmation from the owner (`CATCH_ALL_CONFLICT` →
  `allowCatchAllTakeover`, `MX_CONFLICT` → `allowMxTakeover`). Everything else —
  including a preflight read that Cloudflare refused — stops before any write. A token
  that cannot _see_ a zone is therefore never able to _change_ it. This replaced an
  earlier block-list that let an unrecognized classification fall through to mutation,
  found historically by exercising the live API. Those operator observations are not
  independently reverified by this local remediation.
- **`cfCode 10000` is ambiguous, and provision must not guess.** Historical operator evidence (not reverified here): `POST
/zones/{id}/email/routing/enable` returns the same 403 `Authentication error` for a zone
  outside the token's Zone Resources as it would for a missing permission — this is what
  first masqueraded as "an API token cannot enable Email Routing". It can, and now does:
  with the zone in scope a clean zone reached `READY` purely through the app. The endpoint
  that genuinely has no token permission is `GET /zones/{id}/email/routing` (the settings
  flag), which 403s in every scope and permission set tried. Consequences: routing state is
  derived from DNS instead of the unreadable flag (narrowly — other failures still
  propagate), the enable call is skipped when Cloudflare MX already exist, and a refused
  enable names both possible causes — the missing `Email Routing Rules: Edit` permission and
  the token's Zone Resources — and says whether this run already deleted the domain's MX.
  See `DEPLOYMENT.md`.
- **Drift is detected, never "repaired".** `provisioning/watchdog.ts` runs hourly
  (`triggers.crons`) and on demand from _Verify delivery_, re-reading the delivery path of
  domains MailVault believes work. If Cloudflare's routing MX disappeared or the catch-all
  was moved to another destination, the domain is marked `CONFLICT / DRIFT` with the new
  destination named — it **never** re-enables routing or rewrites the catch-all to win mail
  back, because someone else's configuration is not MailVault's to overwrite. It restores a
  domain to `READY` only if _it_ was the one that marked it drifted (an MX-conflict domain
  is never resurrected because routing happens to look fine), and an unreadable zone is
  recorded as unknown rather than downgraded.
- **Historical token scope (not verified in this review).** The documented token scopes its zone permissions to
  `All zones from an account`, not a per-zone list, so adding a domain never requires
  editing the token. Widening a _resource_ does not widen a _capability_ — it only changes
  which zones the same four permissions apply to: `Zone:Read`, `DNS:Read` and
  `Email Routing Addresses:Read` are read-only, and the one write,
  `Email Routing Rules:Edit`, reaches the catch-all rule and (through the same permission)
  `email/routing/enable`. That is exactly the blast radius to reason about, and it is
  bounded in code, not by the token: mutation happens only behind the allow-list gate
  above, only for a zone the owner imported and selected (a zone absent from `domains` is
  refused before any API call — `test/unit/provisioner.test.ts`), only via an
  authenticated owner-triggered route; foreign-MX takeover additionally requires a fresh
  conflict decision, explicit confirmation and passkey step-up. Historically measured on the owner's
  account: sync + preflight classified 38/38 zones and reported 35 conflicts with zero
  writes; one clean zone was then enabled deliberately, by the owner, in one click.
- **Historical permission diagnosis (not reverified here).** `DNS:Edit` was granted during diagnosis, shown by
  measurement to unlock nothing required, and reverted to `DNS:Read`.
- **Removing a domain** deletes only the local row; the code refuses while aliases or historical messages
  exist and **never** deletes the Cloudflare zone or its DNS.
- Every Cloudflare-side operation is wrapped so API/permission/rate-limit errors map
  to safe `asApiError` codes without leaking the token. Diagnostics log only the API
  path, status and Cloudflare error code — never headers, bodies or the token.

## 10. Data retention — nothing auto-expires

There is no age-based expiry or rule-driven deletion of mailbox content. Aliases and
messages persist until the owner explicitly requests deletion. That request creates
durable cleanup jobs: normal reads hide pending content, while D1 retains cleanup
identifiers until external deletion succeeds. Scheduled processing retries those jobs
before the drift-watchdog credential check; it is not a retention policy. Failed jobs
are observable and may be explicitly retried; they are not reported as completed.

**Rules inherit this limit.** `packages/shared/src/rules.ts` accepts only `archive` and
`tag` as actions — there is no delete verb for a rule to reach — and filing sets
`messages.archived = 1`, which moves mail out of the working list and nothing else. The
`Filed` tab and `archived=all` still return it. A rule records how it was worded at the
moment it acted (`applied_rule_note`), so an archive from last month is explainable after
the rule is edited or removed, and rule evaluation runs _after_ the message row is
committed, wrapped so a broken rule can never cost the owner mail that arrived.

## 11. Input validation

`packages/shared` Zod schemas validate every request body/query (`readJson`,
`parseQuery`) with tight bounds: local-part charset/length + reserved names, label
length, pagination limits (≤200), filter enums, etc. Validation failures return
`400 VALIDATION_ERROR` rather than reaching the DB.

- **Search syntax is data, not a query.** Values are always bound as parameters, but an
  FTS5 `MATCH` string is parsed by the index itself, so `"`, `AND`, `NOT`, `col:` and
  syntax errors in it are a caller-controlled grammar. `ftsMatch()` reduces the input to
  quoted word tokens (capped at 8) and the search falls back to LIKE-only when nothing
  usable remains, so a hostile query returns zero rows instead of a `500`. Proven by
  `test/integration/ingest.test.ts` ("FTS5 syntax attacks").
- **Operators are read server-side, and only from a fixed list.** `from: to: has: is: in:
after: before:` are parsed out of `q` by the Worker itself rather than taken from whatever
  the client decided the query meant, and each maps to a bound comparison against named
  columns. An unrecognised `something:else` stays an ordinary pair of words — a search that
  silently turned into "no filters at all" or "show nothing" would both leak and hide. Column
  names come from a literal table, never from the request.

## 12. What is deliberately out of scope in V1

- Inbound attachments larger than the platform's own per-message ceiling — such a message never
  reaches the Worker, and the size is refused at the edge rather than half-stored. (Outbound files
  are supported, counted against the same ceiling: see §7.)
- Inline images in a sent message (`cid:` references inside the HTML). Files travel as
  attachments, which is what the receiving client can be relied on to show.
- Multi-user tenancy and per-user authorization (single owner behind Access).
- Retry-on-bounce and suppression lists of MailVault's own making: a refusal is reported, and
  the account-level suppression list under Email Sending is what enforces it.
- Automatic conflict resolution (always human-confirmed).

## 13. Residual risks / operator responsibilities

- **Access configuration.** The owner must put the Worker behind a real Cloudflare
  Access application with a strong policy and keep `CF_ACCESS_AUD`/team domain
  correct; without it, only `DEV_AUTH_BYPASS=false` prevents open access.
- **Token scope.** Grant the narrowest token possible; rotate periodically.
- **OTP/verification links** are sensitive; treat the inbox like a password manager.
- **E2E suite** runs against a local `wrangler dev` Worker with `DEV_AUTH_BYPASS=true`
  in `ENVIRONMENT=development`. That config must never be deployed; the production
  config ships `ENVIRONMENT=production`, where the bypass is disabled by that configuration.
