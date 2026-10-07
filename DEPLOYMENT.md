# MailVault — Deployment & Operations Runbook

Deploying MailVault has **two very different kinds of change**, and this runbook keeps
them separate on purpose:

1. **Application infrastructure deploy** — the Worker, D1, R2 and static assets. This
   is ordinary and reversible.
2. **Real domain mutations** — enabling Email Routing / MX / catch-all on a live
   domain. This is **never** automatic: it happens only when the signed-in owner clicks
   *Enable mail* in the app, after a read-only preflight, and it **never** overwrites a
   foreign provider's MX records.

---

## Implementation receipt

```
PROJECT:        MailVault V1 — private persistent domain-mail inbox (Cloudflare)
COMMIT STATE:   working tree at /Users/tunbee27/Documents/mail sever (not a git repo)

QUALITY GATES (run in this environment):
  pnpm install            ✅ (workspace already resolved)
  pnpm typecheck          ✅  shared / worker / web  — no errors
  pnpm lint               ✅  eslint .               — no errors/warnings
  pnpm test               ✅  49 tests passed (worker 32, web 17)
  pnpm build              ✅  web vite build + worker `wrangler deploy --dry-run` bundle ok
  pnpm test:e2e           ✅  5 Playwright tests passed against a live workerd Worker

COVERAGE:
  worker unit             ✅  mail parse/OTP/links/preview/filename/MX + sanitize + preflight(no-mutation) + fixtures(.eml)
  worker integration      ✅  D1/R2 via Miniflare: ingest/accept/reject/dedupe/size + full HTTP API (auth/CSRF/alias/message/attachment)
  web unit                ✅  router + formatting + UI primitives (Testing Library)
  web e2e (Playwright)    ✅  EXECUTED — dashboard health pill, nav, Domains read-only table, Inbox filters,
                                alias create → disable → delete through the real Worker + local D1/R2

LIVE-RUNTIME PROBE (manual, `wrangler dev` on :8787):
  GET  /                        ✅ SPA served, full CSP / nosniff / X-Frame-Options / COOP / CORP headers present
  GET  /api/domains             ✅ returns the seeded READY domain
  POST /api/aliases (no header) ✅ 403 BAD_ORIGIN (CSRF enforced in the real runtime)
  POST /api/aliases (valid)     ✅ 201, "E2E Test!" sanitized to local part `e2e-test-j7wud7`

REAL DOMAIN MUTATIONS:    NONE
  No Email Routing was enabled, no MX/catch-all record was created or changed, and no
  Cloudflare zone was touched. No Cloudflare account, API token, D1, R2 or Access
  instance was provisioned against a live account from this environment.

STATUS:                   DEPLOYMENT_BLOCKED_CREDENTIALS
```

### Addendum — what actually shipped (2026-09-19)

The receipt above is kept exactly as it was written at implementation time, including its
`DEPLOYMENT_BLOCKED_CREDENTIALS` line: no credentials existed in that environment and
fabricating a deployed state was the correct thing to refuse. That is no longer the state
of this system, so this addendum records the difference.

- **Deployed:** D1 `mail-vault-db`, R2 `mail-vault-storage`, Worker `mail-vault` + SPA on
  `https://mail.tungjp.store` (canonical, `APP_ORIGIN`) and still on
  `https://mail.omnipos.tech` during the transition, both behind Cloudflare Access with a
  single owner address in `ALLOWED_EMAILS`. `workers_dev` is off, so the Worker is reachable
  only through those Access-protected routes. The Cloudflare API token exists only as a
  Worker secret.
- **Live updates run on a Durable Object** (`MailboxHub`, one instance per owner address).
  Two things about it were only caught against production, so they are recorded here:
  - This wrangler takes the code-side binding name in `name`, **not** `binding`. Writing
    `{ "binding": "MAILBOX_HUB", ... }` is reported as an unexpected field and the binding
    silently arrives as `MailboxHub`, so `env.MAILBOX_HUB` is undefined — `wrangler dev`
    forgave it, production returned 500.
  - A `101` handshake cannot be rebuilt: `new Response(body, { status: 101 })` throws
    `RangeError` and would also drop the socket. `decorateResponse` passes 1xx through.
  - The E2E that first "passed" only observed the browser *attempting* a socket. It now
    completes a handshake and waits for the hub's `hello` frame, which is what fails when
    either of the above regresses.
- **Migration `0006_passkeys.sql` is applied to production D1** (passkeys, single-use
  challenges, hashed step-up grants). It only adds tables; nothing existing was touched.
  Verified live: `/api/security/passkeys/options` returns a registration challenge bound to
  `rp.id = mail.tungjp.store` with `userVerification: required`, and no key material appears
  in any response. **The WebAuthn ceremony itself is unverified by me** — it needs the
  owner's fingerprint or security key, so enrolling the first passkey is one action left to
  do in Settings.
- **Migration `0007_rules.sql` is applied to production D1** (rules table; `archived`,
  `rule_tag`, `applied_rule_id`, `applied_rule_note` on messages). Verified live:
  `/api/report/address-reuse` already answers a real question — `github.com` holds **four**
  of the owner's aliases across 14 messages, and `cf-bounce.selinow.com` holds two.
- **Semantic search is provisioned but switched off.** Vectorize index
  `mailvault-messages` (1024 dims, cosine) + a Workers AI binding exist, and
  `migration 0008_semantic.sql` is applied (`app_settings`, `messages.embedded_at`).
  Verified live: `GET /api/semantic` reports `enabled: false, indexed: 0, available: true`
  and `POST /api/semantic/backfill` refuses while off. **No message content has been
  copied into the index** — turning it on is the owner's call in Settings, and turning it
  off deletes the vectors again (SECURITY.md §6.5).
- **Ingest is queue-backed:** `mail-ingest` (consumer = the same Worker, `max_retries: 3`)
  with `mail-ingest-dlq` behind it. The email handler stages to R2 and posts a job; the
  consumer commits to D1. Created 2026-09-20 with `wrangler queues create`, and the
  producer/consumer wiring is confirmed on the queue itself (`producers: mail-vault`,
  `consumers: worker:mail-vault`, `dead_letter_queue: mail-ingest-dlq`). The job body
  carries R2 keys and envelope addressing only — see SECURITY.md §6.3. A second queue,
  `mail-delivery-events`, is written by Cloudflare rather than by this Worker and carries
  delivery reports for outbound mail; the consumer dispatches on `batch.queue`, so one
  handler serves both without guessing at either (SECURITY.md §8.6).
- **Real domain mutations: 3 zones, each one an explicit owner click in the app** —
  `omnipos.tech`, `datlichngay.com`, `tung.codes`. Email Routing was enabled by MailVault's
  own token, the catch-all points at the MailVault Worker, and `READY` was recorded only
  after re-reading both. Public DNS confirms `route1-3.mx.cloudflare.net` on the enabled
  zones. The remaining 35 zones were classified as conflicts and left untouched.
- **2026-09-20, owner-authorized take-over: 23 more zones.** Every domain that was not
  excluded is now `READY` (32 of 36). Each of those zones previously published another
  provider's MX — IONOS, Google Workspace, Zoho or Amazon SES — and those MX records were
  **deleted** at the owner's explicit instruction, with the exact record set shown first and
  written to `provisioning_events` before removal; `.ops/mx-snapshot-2026-09-20.json` holds
  the same list for restore. SPF, DKIM and `_dmarc` were deliberately left in place: enabling
  routing adds no second SPF, so deleting them would only break the owner's outbound mail.
  `tungjpstore.net`, `selinow.com`, `fball.vn` and `logivn.com` are excluded by
  `DOMAIN_DENYLIST` and still route to Zoho — verified by public DNS after the batch.
  All 36 were then re-checked against each zone's **authoritative** nameservers, because a
  recursive resolver served a deleted IONOS MX set for `abitovn.info` minutes afterwards
  (authoritative DNS was already correct; the cache, not the zone, was wrong).
- **One `READY` domain cannot receive mail: `loiyeuthuong.org`.** Its Cloudflare zone is
  active, `full`, and holds exactly Cloudflare's routing MX, so both preflight and the drift
  watchdog report it healthy — but the *registration* lapsed on 2026-08-21 and the registry
  moved it to `redemptionPeriod` on 2026-09-17, which removes it from the `.org` zone. Public
  DNS answers NXDOMAIN, so no sender can ever look up its MX. This is registrar state, not
  MailVault state: the fix is to renew (or deliberately drop) the domain, and nothing here can
  verify that from inside a Worker without querying a public resolver on MailVault's behalf.
- **Inbound proven with real mail**, including a live provider email whose 8-digit OTP was
  extracted at 0.85 confidence while a postal code in the same message was demoted to 0.47.
- **The interface speaks Vietnamese now** (`apps/web/src/lib/i18n.ts`). Every string on every
  screen goes through one dictionary; the language starts from the browser, is switchable in
  Settings, and is remembered in `localStorage` (a display preference only — nothing secret or
  session-shaped is stored there). A missing Vietnamese string falls back to English rather
  than printing a key, and a key neither dictionary has prints its own name so a typo is
  visible instead of blank. The new-mail notification follows the same choice: a service worker
  cannot read `localStorage`, so the app posts it the language and the worker falls back to the
  browser's.
  Three things deliberately stay English, and the Settings card says so: technical names
  (SPF, DKIM, MX, OTP, Email Routing), an error the Cloudflare API wrote verbatim, and
  `appliedRuleNote` — the words a rule had at the moment it filed a message, stored with the
  message, which cannot be rephrased later without rewriting history.
  Layout consequence, measured rather than assumed: the five Domains filters no longer fit one
  line at 412px in either language, so `.tabs` wraps instead of scrolling sideways behind a
  hidden scrollbar. `e2e/vietnamese.spec.ts` asserts every filter is on screen, that no screen
  prints a dictionary key, and that nothing overflows the viewport at the longest strings.
- **The E2E layout contract runs on Linux, and that is the only reason one of its
  assertions was worth having.** `phone: the filters share two lines` failed on every CI run
  from the semantic-search commit (`e7705fd`) through the Vietnamese one (`9a19be1`) while
  passing locally: a flex line breaks on *base* sizes before anything shrinks, so the
  mailbox picker's `flex: 1 1 190px` basis pushed it onto its own row as soon as the tab
  labels were a few pixels wider — which they are under Linux's default font. The basis is
  now 110px, and the picker holds the tabs' line with 144px of budget spare even when the
  labels are forced 19px/18px-padding. **CI was therefore not green for those three
  commits**, and the `✅ Green on GitHub` row in README.md described the job's intent rather
  than its state; local gates were green throughout. The fix is in the same commit as this
  note, and the CI run for it is the record of it being green again.
- **The interface was redesigned end to end** (`apps/web/src/styles/`, split into
  tokens / base / components / screens / motion). One identity colour — jade, the same word
  the app uses for a verified sender — status amber and rose, and primary actions taken from
  the *paper* end of the scale instead of a coloured fill, so the only saturated hue on screen
  always means something. New: a Graphite/Paper theme that follows the device unless told
  otherwise, an icon tab bar and rail, sender monograms, a left rail on every message row
  coloured by its authentication verdict, a dashboard vault band, skeletons in place of the
  spinner, and a one-shot sweep on a row that arrived while the tab was open.
  - **Fonts are bundled, not fetched.** The CSP allows `font-src 'self' data:`, and a mail
    client that phoned a CDN on every open would contradict its own pitch. Manrope and
    JetBrains Mono both ship the Vietnamese subset the interface needs (U+1EA0–U+1EF9).
  - **Contrast is now a test, not an opinion** (`src/styles/contrast.test.ts`): it reads
    tokens.css and asserts 12 real text/background pairs at WCAG AA in *both* themes, plus
    that the three status colours are separated by hue rather than lightness — in the light
    theme all three must sit dark to pass contrast, so lightness separates nothing. The first
    run of it caught `--faint` failing AA in both themes (3.95:1 and 3.62:1).
  - **A page-wide transform breaks measurement.** `.page` faded and translated in for 380ms
    on every navigation; the More-menu geometry test went flaky because the element was still
    moving when the popover was measured. It now rises 4px in 220ms — which also just feels
    less sluggish — and the test measures the panel's real height instead of hard-coding a
    clearance constant that had quietly gone stale.
  - Everything the E2E contract measures was kept: class names, accessible names, the
    four-column desktop row, the folded row, the popover flip. Two assertions were updated
    where the design deliberately changed shape (the health dot is an element now; the
    clearance is measured), not where it merely disagreed.
- **The interaction model moved up a level** (production `f8e95b44`):
  - **Command palette** on `/` or ⌘K — one box that searches mail (server FTS, so last
    month is reachable), aliases and domains, and runs actions. It reaches Cloudflare-backed
    actions by navigating to `#/domains?run=sync`, and the marker is replaced out of the URL
    immediately, because reloading a page must not call Cloudflare a second time for
    something the owner only asked for once. **Chromium keeps Ctrl/Cmd+K for its own address
    bar**, so `/` is the binding that actually arrives at the page — and a visible trigger
    exists for everyone else.
  - **Two-pane inbox** at ≥900px: the message opens beside the list from `#/inbox?open=<id>`,
    with `j`/`k` to walk unread, `e` to mark read and advance, `Esc` to close. The phone keeps
    the full-screen route — there is no beside on a handset. `/messages/:id` stays canonical,
    so push notifications and shared links are unaffected.
  - **The OTP copies from the row.** That needed the row restructured (grid wrapper + a link
    whose `::after` covers the row + a real button in the aside), because a button inside an
    `<a>` is not HTML. A forged code still gets no chip.
  - **A new-mail toast** says only how many arrived. The socket carries no content and the
    notice does not either; the count comes from the same authenticated list route.
  - `components/MessageRow.tsx` now exists because the dashboard had quietly kept its own
    copy of the row markup: when the list CSS moved to `.msg-row`, the dashboard's rows
    stopped being a grid and made the page 1028px wide on a 412px phone. The overflow test
    caught it in the suite, not in review.
  - Two E2E assertions were rewritten where the design genuinely changed shape (the row's
    grid element, and the palette's keyboard timing — a key typed before the bundle has
    mounted is simply lost), and one missing dictionary key was caught by the leak check
    rather than by the parity test, which cannot see a key neither screen defines.
- **Reading like a mailbox** (this round): migration `0010_unsubscribe.sql` adds
  `list_unsubscribe` / `list_unsubscribe_post` to `messages` and must be applied before
  deploying. Grouping is a window pass over the existing list query, switched by
  `?threaded=true` and remembered locally; a search always lists every matching message,
  because "which of my messages matched" and "how big is this conversation" are different
  questions — the badge on a grouped row is the conversation's size, not the match count.
  Autocomplete reads the mailbox's own history (`GET /api/recipients`), capped at 8 rows per
  keystroke burst and never wider than 25. Unsubscribe is stored verbatim and rendered only
  for an aligned sender; `SECURITY.md` §6.3 records why.
- **The frontend got a structure** (this round; UI only, no API or schema change):
  - `apps/web/src/components/mail/` now holds the parts of a mail screen — toolbar, bulk bar,
    delivery report, unsubscribe card, the header's codes/links/auth ribbon, the rail's
    mailbox list — and `apps/web/src/lib/` holds the decisions: `mailviews.ts` for what each
    tab asks the server for, `useSelection.ts` for a multi-select with shift ranges,
    `useOutbox.ts` for which aliases may sign. `Inbox.tsx` and `MessageDetail.tsx` went from
    611 and 589 lines to 431 and 434 while doing more, because both had been re-deriving the
    same facts separately.
  - The mailbox switcher moved from the inbox toolbar into the rail, under Inbox, where it can
    carry its unread count too. `GET /api/messages/counters` is then fetched twice per inbox
    view (rail and tabs) — two cheap `SUM(CASE …)` passes, chosen over a shared cache because
    a cache is a second source of truth about a number allowed to change under you.
  - The phone keeps the `<select>`: a 412px bar is a tab bar and nothing else fits in it, and
    `mailboxes.spec.ts` measures that its filters still take only two lines.
  - Two E2E expectations were rewritten where the design genuinely changed shape: the desktop
    mailbox switcher is the rail now, and "All" needed scoping to the tab strip because the
    rail beside it carries an "All mailboxes" entry.

- **Gates at this writing:** 103 tests (worker 81, web 22), 5 E2E; lint and typecheck clean.
  The five later slices — sender authentication, drift watchdog, FTS5 search, alias
  lifecycle, PWA + payload-free push — were each built, tested and deployed on
  `feat/mailvault-v1`; see `git log` and `SECURITY.md` §6.2/§8.1/§9 for their contracts.

- **The mailbox learned to send** (this round; not yet deployed at the time of writing):
  - Migration `0009_sending.sql` adds `direction`, `thread_root_id`, `in_reply_to`,
    `references_json`, `reply_to`, `cc`, `send_status`, `send_error` to `messages` and
    `sending_status` / `sending_tag` / `sending_checked_at` to `domains`. **Apply it before
    deploying**, or every read of `messages` fails: `pnpm db:migrate:remote`.
  - A new `send_email` binding named `EMAIL` must be present on the Worker. Without it the
    app still receives everything and says so plainly: the composer reports that this server
    cannot send instead of failing after you have written a message.
  - **`wrangler dev` simulates it — since wrangler 4.** On wrangler 3.114.17 / workerd
    2025-07-18 the local runtime listed `Send Email: EMAIL` and then injected nothing at any
    compatibility date it supported, so the compose path could only be proven against
    production. On wrangler 4.136.x / workerd 2026-09-21 `dev` builds the message, logs its
    parts to `.wrangler/tmp/email/…` and delivers nothing — which is what a simulator should
    do. The browser suite now sends for real (`sending.spec.ts`), and the state where a
    deployment has *no* binding is asserted in `test/integration/send.test.ts`, where it can
    be forced rather than waited for.
  - The API token needs **`Email Sending: Edit`** (plus `DNS: Edit`, which provisioning
    already required) for *Enable sending* to work; the read-only state check needs
    `Email Sending: Read`. Without them the app surfaces `CLOUDFLARE_PERMISSION` and nothing
    changes on the zone. The token stays a Worker secret either way.
  - **Enabling sending for a domain is a domain-wide act.** Email Sending writes
    `cf-bounce.<domain>` (MX/SPF/DKIM) and `_dmarc.<domain>` = `v=DMARC1; p=reject;`. It never
    touches the receiving MX records — verified live on `omnipos.tech`, where the apex kept
    its routing MX and had no DMARC record before or after. But a DMARC policy governs
    **every** service that sends as that domain, so the dialog lists the exact records from
    Cloudflare's read-only preview, and an existing `_dmarc` needs a ticked confirmation plus
    a passkey.
  - Measured against the real service, worth remembering: any local part on an onboarded
    domain can send (no alias row needed on the sending side); `queued` rather than
    `delivered` is normal for a foreign mailbox or any attachment; the limits endpoint is not
    realtime (`sent` did not move across three sends); total message size including
    attachments is **5 MiB**; and a first probe from the cold subdomain landed in Gmail
    **Primary**.
  - Local `sending_status` for `demo.example` is seeded to `ENABLED` so the compose screen has
    something to offer. That is a local fiction: the seed only pretends the domain is
    onboarded, and the local runtime cannot send anyway.

- **Delivery status, stars and working over a list** (this round):
  - Migration `0011_starred_and_recipients.sql` adds `messages.starred` and the
    `message_recipients` table. **Apply it before deploying** (`pnpm db:migrate:remote`), or
    every list read fails on the missing column.
  - A second queue, `mail-delivery-events`, is consumed by the same Worker. The consumer is
    declared in `wrangler.jsonc`; the queue itself is created once with
    `wrangler queues create mail-delivery-events`. The handler dispatches on `batch.queue`, so
    a batch is never guessed at from its shape.
  - **The event subscription is an account resource, not part of a deploy**, and it needs
    wrangler 4 (`wrangler queues subscription create …`) — which is what this project pins, see
    *Toolchain: wrangler 3 → 4* below. Create it once per sending domain:

    ```bash
    npx wrangler@4 queues subscription create mail-delivery-events \
      --source email.sending --domain send.omnipos.tech --zone-id <zone id> \
      --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
    ```

    Nothing in the app writes it, and deleting it only stops status updates — mail still
    sends. `DELIVERY_EVENTS_QUEUE` names the queue on both sides; the default matches.
  - Sent messages created **before** this round have no `message_recipients` rows. That is
    correct rather than broken: they report the status the send itself recorded, and an event
    that arrives later for one of them creates its row. No backfill was invented from
    `envelope_to`, because a comma-joined string cannot say which of those addresses were Cc.
  - Tab badges come from `GET /api/messages/counters`, counted over the whole mailbox. On a
    handset they are hidden, because five tabs carrying counts no longer share their line with
    the mailbox picker, and a third line of filters is what `mailboxes.spec.ts` exists to catch.

- **Sending files with a message** (this round):
  - **No migration.** The `attachments` table and the `has_attachments` / `attachment_count`
    columns were built for received mail; a send now writes them with its own rows, so a sent
    message's files are listed, downloaded and deleted by the code that already does that for
    an inbound one.
  - A compose carries each file as base64 in the JSON body. The Worker decodes it once, puts the
    bytes in the private bucket, and hands the *same* base64 to the `send_email` binding — so the
    copy that left and the copy kept cannot drift apart. The `.eml` record is the assembled
    `multipart/mixed` message, which is why `raw_size` on a sent row now reads as the whole
    message rather than its text.
  - Two ceilings, from different places. **8 files** per message is ours, a shape guard.
    **5 MiB** for the assembled message is Cloudflare's, measured on the bytes that would go —
    base64 adds a third, so the practical single-file limit is nearer 3.7 MB. A compose over
    either is refused before a row, an object or a send.
  - The local runtime accepts a file whose `content` is a base64 string; an `ArrayBuffer` does not
    serialize through the simulator. That is why the E2E attaches for real instead of asserting a
    stub, and it is a constraint worth knowing before anyone changes the payload shape.
  - Nothing new to create: no queue, no secret, no DNS. Deploy is the same command.

- **Sending through a subdomain of the same domain** (this round):
  - Migration `0012_sending_via.sql` adds `domains.sending_via`. **Apply it remotely before
    deploying** (`pnpm db:migrate:remote`); without it the new choice cannot be saved.
  - Why it exists: Cloudflare onboards Email Sending per *name* inside a zone, and the name that
    carries the DMARC policy does not have to be the name that receives mail. `send.omnipos.tech`
    has been onboarded since 2026-09-22 while `omnipos.tech` has not, and enabling the apex would
    write a domain-wide `_dmarc` over a domain whose other senders MailVault knows nothing about.
    The choice is what closes that gap without a DNS write.
  - `PUT /api/domains/:zoneId/sending-via` records the choice and **deliberately clears** the
    remembered `sending_status`: the old verdict described a different name. `GET
    /api/domains/:zoneId/sending/names` lists the zone's sending names live, because a cached
    list is how somebody ends up enabling the same name twice.
  - A send then leaves as `<local>@<chosen name>` with `Reply-To` on the alias that receives —
    both derived by the Worker from the alias row and the domain row, never from the request.
    `POST /api/sending/refresh`, the preview and the enable flow all ask about the chosen name.
  - Nothing here changes a receiving record, and nothing runs on load: the field is only ever set
    by an explicit `PUT`.

## Why it was `DEPLOYMENT_BLOCKED_CREDENTIALS`

At implementation time the build could not be deployed here because the required, secret,
account-specific inputs were **not present** (and must not be fabricated):

- A Cloudflare **account id** and a **least-privilege API token** (`wrangler secret put
  CLOUDFLARE_API_TOKEN`).
- A **D1 database** and **R2 bucket** created on the account (the ids/names in
  `wrangler.jsonc` are placeholders).
- A **Cloudflare Access** self-hosted application (team domain + `AUD`).
- A **custom hostname** + DNS for the app origin.
- Wrangler login for `wrangler deploy` / `d1 migrations apply --remote`.

Per the project rules, deployment was **not** faked. Everything that did not require a
live account was complete, green and committed to the tree — and each item above was
supplied by the owner afterwards, which is what the addendum records.

## How the E2E suite runs

Two Playwright projects: `chromium` (desktop) and `mobile` (412×915, touch, coarse
pointer). `e2e/ui.spec.ts` is the layout contract — no horizontal overflow on any screen,
the tab bar pinned to the bottom with ≥40px targets, inputs at 16px so iOS does not zoom
on focus, and a spoofed message that shows no code badge in the list and gates its codes
and links behind an explicit reveal. Screenshots land in `apps/web/e2e-screens/` (ignored).

`pnpm test:e2e` boots the Worker itself via `webServer` →
`pnpm --filter @mailvault/worker dev:e2e`, which applies migrations, seeds
`scripts/seed.sql`, and serves the built SPA **and** `/api/*` from one origin
(`http://localhost:8787`). Same-origin is required: the browser's `Origin` must equal
the request host for the CSRF check to pass, so the Vite dev proxy is deliberately not
used for E2E.

```bash
npx playwright install chromium      # once
pnpm build:web
pnpm test:e2e
```

The seed is applied when that server **starts**, not between specs, so a run against a
reused `localhost:8787` inherits whatever the last run left in local D1. Measured: a second
full run on one server failed `ui.spec.ts`'s phone menu test, which archives a seeded alias
and so expects to find it active. Restart the dev server (or drop the port to Playwright)
before reading a repeat failure as a regression — CI is unaffected, it boots its own.

Verified locally with `wrangler 4.136.x` + its workerd, using `wrangler.dev.jsonc`
(`compatibility_date: 2025-07-18`, `DEV_AUTH_BYPASS=true`, `ENVIRONMENT=development`).

> Note: `wrangler dev` and Playwright have always run fine from this project path. The
> path-space problem was confined to `@cloudflare/vitest-pool-workers`, whose virtual-module
> resolution mis-encodes the space in `mail sever`; that is why the worker's integration
> tests drive D1/R2 through programmatic Miniflare instead. The pool has now been dropped
> rather than upgraded, so it is no longer a dependency waiting on that fix.

### Toolchain: wrangler 3 → 4 (2026-09-23)

The pin moved to `wrangler@^4.136` because wrangler 4 stopped being able to share
credentials with v3: v4 stores the OAuth token in an encrypted, Keychain-backed
`config/default.enc`, which v3 cannot read, so `wrangler deploy` and
`d1 migrations apply --remote` began failing with "set a CLOUDFLARE_API_TOKEN" while v4
was logged in. CI's deploy and rollback jobs were already written against v4
(`npx wrangler deploy`, and `wrangler versions deploy`, which only exists in v4) — the local
pin was the last thing still on v3.

**Neither CI job has ever run.** The deploy one is manual-only, and the first
`workflow_dispatch` (2026-09-23, after PR #8) failed at wrangler with *"In a
non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN"*: the token is a
**Worker secret**, deliberately never copied into GitHub, so the workflow has nothing to
deploy with. Deploys are therefore run from this machine against the wrangler login —
`pnpm build:web && pnpm --filter @mailvault/worker deploy` — and the CI path stays unused
until the owner chooses to add a scoped Actions secret for it. The `verify` job, which needs
no credentials, is what gates every push and PR.

What came with it:

- `@cloudflare/workers-types` to v5, which resolves the peer requirement v4 states.
- `@cloudflare/vitest-pool-workers` removed (unused; it also pinned a second, older
  wrangler into the tree) along with the `worker-env.d.ts` stub that only referenced it.
  `tsconfig.json` already declares the Cloudflare types directly, so nothing was lost.
- The send payload now goes to the binding as the runtime's own `EmailMessageBuilder`
  instead of a hand-written interface plus a cast. That cast existed because the old
  types described only the raw-MIME form of `send()`; with it gone, `from: { name, email }`,
  `cc`, `bcc`, `replyTo` and `headers` are checked against the contract Cloudflare
  publishes.
- Nothing in `wrangler.jsonc` needed changing: a v4 `deploy --dry-run` resolved the same
  bindings, vars and triggers (including the Durable Object declared with `name` only).
- `wrangler.dev.jsonc` lost its `ai` binding. v4 treats Workers AI as always-remote and opens
  an authenticated proxy session to start `dev` with one, which the CI E2E job has no
  credentials for and should not have. Verified by starting the dev server with an empty
  `HOME` (no Cloudflare auth at all): it serves, and `POST /api/outbox` still returns 201
  against the local `send_email` simulator. Semantic search was never available locally
  anyway — there is no Vectorize backend in the dev config either.

---

## Prerequisites (owner, one-time)

```bash
# 1. Install deps
corepack enable && pnpm install

# 2. Create remote D1 + R2 and paste real ids into apps/worker/wrangler.jsonc
wrangler d1 create mail-vault-db
wrangler r2 bucket create mail-vault-storage

# 3. Confirm the Worker's own name + APP_ORIGIN/CF_ACCESS_* in wrangler.jsonc
```

## Deploy application infrastructure

```bash
# From apps/worker (or via root scripts):
pnpm build:web                       # produces apps/web/dist served as assets
pnpm --filter @mailvault/worker db:migrate:remote   # apply 0001_init.sql to prod D1
pnpm --filter @mailvault/worker deploy              # wrangler deploy

# Secrets (never committed, never in vars):
wrangler secret put CLOUDFLARE_API_TOKEN            # least-privilege token, see below
wrangler secret put VAPID_PRIVATE_KEY               # optional: enables notifications

# VAPID key pair (only if you want push notifications). The Worker derives the public
# half from this JWK, so there is one value to keep and no way for them to disagree:
node -e 'const{generateKeyPairSync}=require("node:crypto");const{privateKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});console.log(JSON.stringify(privateKey.export({format:"jwk"})))' \
  | pbcopy                      # then: wrangler secret put VAPID_PRIVATE_KEY  (paste)
# and set VAPID_SUBJECT (a var, not a secret) to a contact, e.g. mailto:you@example.com

# Put the deployed Worker behind Cloudflare Access:
#   - Zero Trust → Access → Applications → Self-hosted
#   - policy = the owner's email(s); set a login policy
#   - copy the AUD tag and team domain into CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN
#   - restrict direct access to the Worker route to Access only
```

### Hostnames: two routes, one Worker, one Access app

`mail.tungjp.store` is the canonical origin (`APP_ORIGIN`); `mail.omnipos.tech` still serves
during the transition. Both are `custom_domain` routes on the same Worker, and a single
self-hosted Access app covers both through its `self_hosted_domains` list — so
`CF_ACCESS_AUD` did not have to change, and there is one policy ("Owner only") to keep
correct rather than two.

What that does *not* carry over, because browsers scope it per origin:

- **The installed PWA.** `mail.tungjp.store` is a separate install; the old one keeps working
  against the old hostname.
- **The Web Push subscription.** Endpoints are origin-bound, so notifications must be
  re-enabled once in Settings on the new hostname. Until then only the old origin notifies.

To retire the old hostname: drop its route from `wrangler.jsonc`, redeploy, and remove
`mail.omnipos.tech*` from the Access app's `self_hosted_domains`.

### The customer code portal (`/c/:token`) — not deployed yet

The owner sells accounts that sign up with these addresses, so a buyer needs one number from
one mailbox and nothing else. `/c/:token` is that: one page, one number, no login. It is
mounted outside `/api/*` on purpose — the Access gate that protects the mailbox is what keeps
a stranger out of somebody else's mail, and a public path must never live under it.

**It cannot work on the two live hostnames.** Access here covers *every* path on
`mail.tungjp.store` and `mail.omnipos.tech` (verified: `/api/health`, `/c/test` and `/portal`
all 302 to the Access login), so a buyer's link would stop at the owner's login screen. The
portal needs its own hostname with no Access app listing it.

To turn it on:

```bash
# 1. Apply the grants table to the remote D1.
pnpm --filter @mailvault/worker db:migrate:remote

# 2. DNS: an A/AAAA record for code.omnipos.tech pointing at the Worker (proxied),
#    then a third custom_domain route in apps/worker/wrangler.jsonc:
#      { "pattern": "code.omnipos.tech", "custom_domain": true }
#    Do NOT add it to the Access app's self_hosted_domains — that list is what gates it.

# 3. Un-comment PORTAL_ORIGIN in wrangler.jsonc so minted links point at the public
#    hostname instead of the gated one, then redeploy:
cd apps/worker && pnpm build:web && npx wrangler deploy

# 4. Check it from somewhere with no Access session.
curl -i https://code.omnipos.tech/c/not-a-real-link-000000   # 404, and never a login redirect
```

Email Routing, MX records and the API token are untouched by any of this: the portal reads D1
and nothing else, so there is no new Cloudflare permission to grant.

**Understand what the third hostname actually opens.** Routes point domains at a Worker, not at
a path — so `code.omnipos.tech` would also answer `POST /api/*`, with no Access in front of it,
on the same Worker as the mailbox. What stops that is the Worker itself: `src/auth.ts` verifies
the Access JWT's signature, issuer, audience and expiry on every `/api/*` call, and a request
that arrives through an ungated hostname simply has no assertion to present, so it gets
`401 UNAUTHORIZED`. `DEV_AUTH_BYPASS` is inert in production and `checkCsrf` still rejects any
Origin that is neither `APP_ORIGIN` nor the host being asked. If that single layer ever stops
being enough, the fix is a second small Worker on the public hostname with a read-only D1
binding and no API token at all — not an Access exception on a path.

What a link can say: the newest code for its own alias that arrived in the last 30 minutes in
mail that passed authentication, how old it is, and the address it arrived at. What it can
never say: a subject, a body, an attachment, a link, a message list, or anything about another
address.

The credential model, since the token is the only thing standing between a buyer and a
mailbox:

- 192 random bits (`/c/:token`), stored **only** as a SHA-256 hash. The list API returns every
  link's state and cannot rebuild any of them; the token appears in exactly one response.
- Time-bounded (5 min … 7 days, default 1 h) and optionally look-capped. Polling the JSON
  endpoint does not consume a look, so a cap of 5 means five customers, not five refreshes.
- Revoking writes a timestamp rather than deleting, so the record of who was shown what
  survives the sale. `GET /c/:token` is `no-store`, `noindex`, and `frame-ancestors 'none'`, so
  the shop must send buyers to the link in a new tab instead of embedding it.
- Per-isolate, best-effort throttle on page views and bad tokens. It raises the cost of
  scraping; the token is the real defence.

Links speak Vietnamese unless the URL says `?lang=en`.

### API token scope (least privilege)

Create **one** User API Token.

- **Zone / Zone / Read** — enumerate + inspect the zone
- **Zone / DNS / Read** — read MX records for conflict detection
- **Zone / DNS / Edit** — *only* for an owner-confirmed MX take-over: deleting another
  provider's MX is the one DNS write MailVault performs. Without it, takeover attempts stop
  with an auth error and nothing is deleted.
- **Zone / Email Routing Rules / Edit** — read and set the catch-all → Worker, and
  `POST /email/routing/enable`
- **Account / Email Routing Addresses / Read** — carries the account resource the Email
  Routing endpoints require

Do **not** use a Global API Key. `DNS:Edit` is the widest grant here, so it is worth being
explicit about what bounds it: the code deletes a record only inside a take-over the owner
confirmed in the UI, only records whose `type` is `MX` and whose exchange the preflight
named as foreign, never Cloudflare's own routing MX, never SPF/DKIM/DMARC, never a zone on
`DOMAIN_DENYLIST`, and never on startup or from a cron.

Set *Zone Resources* to **All zones from an account**. A per-zone list was tried first
and rejected: it forces a dashboard edit before MailVault can even *see* a new domain, and
it makes `email/routing/enable` fail with an error that looks like a missing permission
(next section). The scope changes which zones the *existing* permissions apply to, so
judge it by what they can do on a zone MailVault has no business touching:

- `Zone:Read` + `DNS:Read` are read-only on the owner's own zones.
- `Email Routing Addresses:Read` is read-only.
- `Email Routing Rules:Edit` is the routing write: it sets the catch-all rule and, through
  the same permission, enables Email Routing. Both are bounded in code, not by the token.
- `DNS:Edit` is the record write, and the only one that can strand a mailbox — see the
  take-over gate in `SECURITY.md` §9.

What actually limits the blast radius is the code path: an HTTP route can only name zones
the owner selected, each must already be a row in MailVault's own `domains` table, the
preflight **allow-list** refuses mutation unless the classification is `Ready to enable`,
`Already configured`, or `Catch-all conflict` *with* the owner's explicit take-over tick,
foreign MX is never overwritten, and none of this runs on startup.

### Constraint: what an API token can and cannot do for Email Routing

Measured against a live account — and an earlier reading of the same measurement was wrong
in a way worth recording, because the failure mode is genuinely misleading:

| Call with the runtime API token | Result |
|---|---|
| `GET /zones/{id}/dns_records?type=MX` | ✅ 200 |
| `DELETE /zones/{id}/dns_records/{id}` | ❌ 403 `cfCode 10000` without `DNS:Edit`; ✅ 200 with it |
| `GET /zones/{id}/email/routing/rules/catch_all` | ✅ 200 |
| `PUT /zones/{id}/email/routing/rules/catch_all` | ✅ 200 |
| `POST /zones/{id}/email/routing/enable` | ✅ 200 — but ❌ 403 `cfCode 10000` when the zone is outside the token's *Zone Resources* |
| `GET /zones/{id}/email/routing` (settings flag) | ❌ 403 `cfCode 10000`, in every scope and permission combination tried |

- **`enable` and `DNS:Edit` are independent grants, and `cfCode 10000` cannot tell them
  apart.** Measured 2026-09-20 during a real take-over: the same token deleted IONOS's MX on
  a zone (so that zone *is* inside its resources and `DNS:Edit` works) and was refused
  `email/routing/enable` on that same zone minutes later. The domain was left with no MX at
  all until routing was enabled through another credential — which is why the take-over
  failure message now says the MX is already gone instead of reassuring about it.

- **Enabling Email Routing *is* token-performable.** It was first written down as
  impossible because `cfCode 10000` ("Authentication error") is also what Cloudflare
  returns when the *zone* falls outside the token's resources — the two causes are
  indistinguishable from the response. After `Zone Resources = All zones from an account`,
  a clean zone went from `Ready to enable` to `READY` entirely inside the app, and public
  DNS confirms `route1-3.mx.cloudflare.net` was created for it. **Adding a domain now needs
  no dashboard step at all.**
- **Reading the routing settings flag is not token-performable**, in either scope: it stays
  403 with `Email Routing Rules:Edit`, `Zone:Read`, `Email Routing Addresses:Read` and even
  `DNS:Edit` granted, and Cloudflare exposes no permission group for it. Consequence,
  already built in: preflight derives routing state from DNS instead, since Cloudflare only
  publishes `route*.mx.cloudflare.net` once Email Routing is on. If that read fails for any
  *other* reason the error still propagates — the fallback is deliberately narrow.

## Enable mail per domain (owner-triggered, in the app)

1. **Domains → Sync from Cloudflare.** Read-only import of every zone the token can see —
   with `All zones from an account` that is the whole account, so a domain the owner adds in
   Cloudflare shows up here without any token edit. No DNS change.
2. **Domains → Preflight all** (or select, then Preflight). Read-only: reports
   `Ready to enable` / `Already configured` / `MX conflict` / `Catch-all conflict` /
   `Permission error`, and auto-expands any domain that is not safe. Nothing is
   mutated — the preflight unit test asserts an empty mutation log.
3. **Select → Enable mail.** After an explicit confirmation the Worker:
   - runs preflight again; a **foreign MX** stops it and reports a conflict (never
     overwrites), and a **foreign catch-all** is replaced only if the owner also ticks
     *Take over catch-all*;
   - skips the enable call when Cloudflare MX already exist (no redundant mutation), and
     otherwise attempts it;
   - points the catch-all rule at the MailVault Worker;
   - **verifies** routing is on *and* the catch-all targets this Worker before marking
     the domain `READY`. A single 200 is never trusted.
4. **Troubleshooting only:** if a receipt ever says routing could not be enabled, the first
   thing to check is the token's *Zone Resources* for that zone, not the dashboard —
   MailVault names both causes in the receipt and links to the Email Routing console.
   Nothing is ever surfaced as a bare "Authentication error".

`enable mail` performs exactly these steps:
`email_routing_dns → catch_all_worker → verify`.

## Ongoing health: the drift watchdog

A zone can be edited from the dashboard at any time (by you, a teammate, or another tool),
and then mail simply stops arriving. Two things guard against discovering that by accident:

- **Hourly, automatically** (`triggers.crons` → `7 * * * *`): every domain marked `READY`
  is re-read — are Cloudflare's routing MX still in DNS, and does the catch-all still point
  at this Worker?
- **On demand:** Domains → **Verify delivery**, which runs the same sweep and reports
  `checked / drifted / restored / failed`.

What it does on drift: marks the domain `CONFLICT` with `DRIFT` and names the new
destination, records a `watchdog:drift` event, and restores the domain when the path comes
back. What it never does: enable routing, edit DNS, or rewrite someone else's catch-all to
win mail back — re-taking a zone is an owner decision, made with *Enable mail*. A zone whose
reads fail is left alone, because "unknown" is not evidence of drift.

This matters in practice: during development of this slice, another operator enabled
`vnecs.com`/`vnecs.store` (with catch-all take-over) and removed two other domains from
tracking while the app was being tested — exactly the kind of concurrent change a status
page that never refreshes would hide.

## Receiving & reading mail

- Create **aliases** (random / service-prefixed / custom) on any `READY` domain. Only
  aliases in the `ACTIVE` state accept mail; unknown recipients are rejected and never
  auto-created.
- Incoming OTPs, verification links, sanitized HTML and attachments appear in the
  **Inbox**. Remote images stay blocked until the owner opts in per message.
- **Nothing expires.** Deleting a message or an alias (with optional purge) is the only
  way content is removed.

## Removal / teardown

- **Remove a domain** in the app deletes only the local MailVault row. It refuses while
  aliases exist and **never** deletes the Cloudflare zone or its DNS.
- **Delete an alias** keeps existing mail unless *also delete all messages* is checked,
  which then purges the D1 rows and the R2 objects.
- Un-deploying the app (`wrangler delete`, dropping D1/R2) is a separate, deliberate
  operator action outside the app.

## Rollback

`wrangler` keeps previous Worker versions. `pnpm --filter @mailvault/worker deploy`
again with an earlier build, or `wrangler rollback`, restores the previous Worker. D1
migrations are additive; roll forward with a new migration rather than editing history.
