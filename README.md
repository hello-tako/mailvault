# MailVault V1 — Private Persistent Domain Mail

MailVault is a personal mail system that turns domains you already own on Cloudflare
into private inboxes of disposable **aliases**, optimised for capturing **one-time
passcodes (OTPs)**, verification links and password-reset mail — and for answering from
the alias the mail arrived on, so the other side never sees your real address. Aliases and
messages persist **indefinitely**, in both directions: nothing expires automatically.

It runs as a single Cloudflare Worker (HTTP `fetch` + inbound `email` handlers) with
D1 for metadata, a private R2 bucket for raw/normalized content and attachments,
Workers Static Assets for the SPA, and Cloudflare Access for authentication.

---

## Status

| Area | State |
|------|-------|
| Worker (API + inbound email) | ✅ Implemented |
| Shared types/validation (`packages/shared`) | ✅ Implemented |
| D1 schema + migration | ✅ Implemented (`apps/worker/migrations/0001_init.sql`) |
| React SPA (Dashboard / Domains / Aliases / Alias detail / Inbox / Message / Settings) | ✅ Implemented |
| Installable PWA + payload-free new-mail notifications | ✅ Implemented |
| Phone layout: bottom tab bar, card lists, safe-area insets, 44px targets | ✅ Mobile-first (E2E at 412px) |
| Reading view: re-flowed plain text, folded magic links, tracking-wrapper destinations, HTML frame that fits the screen | ✅ Fixture + E2E covered |
| One mailbox per domain: dashboard mailbox cards, inbox picker, per-row arrival domain | ✅ Implemented |
| Row actions folded until engaged (tap / hover / focus), bulk actions only with a selection | ✅ E2E covered |
| Inbound ingest is retryable: stage to R2 → queue → commit, with a dead-letter queue | ✅ +9 tests |
| Open tabs learn about new mail over a per-owner Durable Object (nudge only, no content) | ✅ Handshake tested |
| CI: typecheck + lint + tests + E2E on every push; manual versioned deploy; rollback | ✅ Runs on every push (Linux, Node 24) |
| Passkey step-up before anything irreversible (purge mail, detach domain, disable sender checks) | ✅ Gate tested |
| Mailbox rules (file/tag on sender or subject) + who-holds-my-address report | ✅ 12 tests |
| Semantic search (Workers AI + Vectorize) behind an explicit opt-in that defaults to off | ✅ 10 tests |
| Vietnamese interface with an English fallback, chosen in Settings and remembered (also for the new-mail notification) | ✅ E2E at 412px |
| Interface redesign: graphite + paper themes, self-hosted Manrope/JetBrains Mono, icon nav, sender monograms, authentication rail per row, skeletons, motion | ✅ 27 E2E + AA contrast guard |
| Interaction model: ⌘K / `/` command palette, two-pane inbox with j/k/e, one-tap OTP copy from the row, new-mail toast | ✅ 7 E2E |
| Sending: compose to anybody or answer a message from its alias, **with files sent and kept**, conversations kept in one thread, per-domain Email Sending behind an explicit DMARC confirmation | ✅ 47 send tests, 5 E2E |
| Reads like a mailbox: one row per conversation, replies that quote what they answer, `c`/`r` shortcuts, recipients completed from your own correspondence, one-click unsubscribe for aligned senders only | ✅ 9 + 5 E2E |
| Worked over like a mailbox: multi-select with shift ranges, bulk read/star/file/delete, a star of your own, counts per tab and mailbox, `from:` `to:` `has:` `is:` `in:` `after:` `before:` in search | ✅ 32 + 7 E2E |
| Delivery reported per address: a send to three people shows which one bounced, from Email Sending's own queue events | ✅ consumer tested through `worker.queue` |
| Sends under a name of its own choosing: a domain may send through an onboarded subdomain of the same zone, so the DMARC policy lands where nothing else sends and answers still come back to the alias | ✅ 9 integration tests |
| Frontend structure: `components/mail/*` for the parts of a mail screen, `lib/*` for the decisions (which tab asks for what, what a selection holds, which aliases may sign), mailboxes in the rail as navigation | ✅ 15 unit + 51 E2E |
| Unit + integration tests (415 passing: worker 305, web 110) | ✅ Green |
| Playwright E2E (63 passing across desktop and 412px, live workerd + local D1/R2) | ✅ Green |
| Deployed + receiving real mail on 32 of 36 owner domains (4 excluded by config) | ✅ Live |
| Working-list/counter indexes + cursor paging; counters as eight index-counts in one batch | ✅ Migration 0014, plan asserted by test |
| Ingest commit in one atomic batch; delivery events applied in batches; parallel pushes and attachment writes | ✅ Round trips per message cut, tests green |
| Split bundle (lazy screens), optimistic read/star, error boundary, PWA unread badge | ✅ First-load JS split from one 406 kB chunk |
| Download the original `.eml`; export/import the address book as JSON; compose draft autosave | ✅ Integration + unit tests |
| Failure-streak email alerts (via the app's own `send_email`) + a dead letter for delivery events | ✅ `src/lib/ops-alert.ts`, 9 tests |
| Backups: weekly D1 export to R2, Time Travel + versioning runbooks; CI applies migrations and auto-deploys on main; nightly production smoke; dependabot | ✅ See `DEPLOYMENT.md`, "Backups & disaster recovery" |

See [`DEPLOYMENT.md`](./DEPLOYMENT.md): the implementation receipt records the state at
build time (no Cloudflare credentials existed in that environment, so it says
`REAL DOMAIN MUTATIONS: NONE` and `DEPLOYMENT_BLOCKED_CREDENTIALS` rather than pretending
otherwise), and its addendum records what has since been deployed and measured live.

---

## Architecture

```
Cloudflare Email Routing (per-domain catch-all rule)
                    │  inbound mail
                    ▼
        ┌───────────────────────────┐
        │   mail-vault Worker       │   email() ── ingest: parse MIME (postal-mime),
        │                           │            extract OTP + verification links,
        │   fetch()  ── Hono API    │            store raw .eml + parsed JSON in R2,
        │   /api/*  (authenticated) │            write metadata row in D1
        └───────────┬───────┬───────┘
                    │       │
             ┌──────▼──┐ ┌──▼────────┐        D1: domains, aliases, messages,
             │   D1    │ │    R2     │            attachments, provisioning_events
             │ metadata│ │ raw+parsed│        R2: raw .eml, parsed JSON, attachments
             └─────────┘ │ +attach.  │        (private bucket — never public)
                         └───────────┘
                    ▲
        ┌───────────┴────────────┐
        │  Workers Static Assets │  React SPA (auth via Cloudflare Access JWT)
        └────────────────────────┘
```

- **One deployable.** The Worker serves the API under `/api/*` and the SPA for every
  other path (`run_worker_first: true`), so security headers are applied to the
  HTML document and assets too.
- **Mail is hostile input.** Raw `.eml` is stored verbatim; HTML is sanitized
  server-side and rendered only inside a `sandbox=""` iframe in the browser. The SPA
  never injects email markup into its own DOM.
- **No content ever expires.** No TTL, no cron deletion, no R2 lifecycle rule.
  Deletion happens only through explicit owner actions in the UI.
- **Sent mail is mail.** An outbound message is a row in the same table with a direction, a
  thread root and its own stored copy in R2, so a conversation reads as one list and
  "delete this message" already covers what you sent.

## Repository layout

```
apps/
  worker/            Cloudflare Worker: Hono API + email() ingest + provisioning
    src/
      index.ts       entrypoint (fetch + email)
      app.ts         router factory: auth → CSRF → routes
      auth.ts        Cloudflare Access JWT verification (+ dev-bypass guard)
      routes/        health, dashboard, domains, aliases, messages
      mail/          MIME parse, OTP extraction, link extraction, preview, normalize
      provisioning/  MX assessment, read-only preflight, owner-triggered provisioner
      security/      HTML sanitizer + security headers/CSRF
      storage/       R2 helpers
      db/            D1 data access + row mappers
      cf/            Cloudflare REST client (token from secret only)
    migrations/      D1 SQL
    test/            unit + integration + .eml fixtures
  web/               React 18 + Vite SPA (custom hash router, no UI framework)
    src/pages/       Dashboard, Domains, Aliases, AliasDetail, Inbox, MessageDetail, Settings
    src/components/  ui primitives, sandboxed MessageHtml
    e2e/             Playwright specs (against same-origin wrangler dev)
packages/
  shared/            Zod schemas + TS types shared by worker and web
```

## Getting started (local)

```bash
corepack enable            # uses pnpm@10 pinned in package.json
pnpm install

# Quality gates (all must pass):
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e            # boots its own same-origin Worker (see below); needs `npx playwright install chromium`
```

### Run the full app locally

The browser needs a Worker that serves both `/api/*` and the SPA on one origin so
CSRF "same-origin" holds.

```bash
pnpm build:web                                   # produce apps/web/dist
pnpm --filter @mailvault/worker dev:e2e          # migrate+seed local D1, then wrangler dev :8787
# open http://localhost:8787
```

`dev:e2e` uses `wrangler.dev.jsonc` (`DEV_AUTH_BYPASS=true`, `ENVIRONMENT=development`)
and seeds one Ready domain + one alias from `scripts/seed.sql`. **This is local only** —
the bypass cannot take effect when `ENVIRONMENT=production`, and the seed never reaches
a real account.

### Frontend unit/dev

```bash
pnpm --filter @mailvault/web dev      # Vite dev server on :5173, proxies /api → :8787
pnpm --filter @mailvault/web test     # Vitest + Testing Library
```

## API surface

All `/api/*` except `/api/health` require a valid Cloudflare Access identity and, for
state-changing methods, the `x-mailvault: 1` header + same-origin (CSRF).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/recipients` | Addresses this mailbox has corresponded with, for completing the To field |
| GET | `/api/health` | Liveness (unauthenticated, coarse) |
| GET | `/api/dashboard` | Counts + recent messages |
| GET | `/api/domains` | Tracked domains |
| POST | `/api/domains/sync` | Import zones from Cloudflare (read-only CF) |
| POST | `/api/domains/preflight` | Read-only conflict checks (no CF mutation) |
| POST | `/api/domains/provision` | Enable mail on selected zones (owner action; takes over catch-all only with explicit confirm) |
| POST | `/api/domains/:id/retry` | Retry provisioning for one zone |
| DELETE | `/api/domains/:id` | Forget a domain locally (**never** deletes the Cloudflare zone) |
| GET | `/api/aliases` | List/search aliases (`?view=active\|archived\|all`, pinned first) |
| POST | `/api/aliases` | Create alias (random / service_random / custom) |
| GET | `/api/aliases/:id` | One alias + arrival history (counts, first/last, top senders) |
| PATCH | `/api/aliases/:id` | Update label, notes, pinned, archived (partial) |
| POST | `/api/aliases/:id/enable` \| `/disable` | Toggle receiving |
| DELETE | `/api/aliases/:id` | Delete alias; purge messages only if `purgeMessages` |
| GET | `/api/messages` | Paginated inbox; filters + FTS5 search over subject/preview/sender, exact OTP-code and alias match, and `from:` `to:` `has:` `is:` `in:` `after:` `before:` operators in `q` |
| GET | `/api/messages/counters` | Totals and unread counts per tab and per mailbox, over the whole mailbox rather than the page |
| POST | `/api/messages/bulk` | Read / unread / star / unstar / archive / unarchive / delete a selection (up to 200 ids) |
| GET | `/api/messages/:id` | Detail with sanitized HTML, codes, links, attachments, and per-address delivery state |
| GET | `/api/messages/:id/raw` | The original message as `message/rfc822` (.eml download) |
| GET | `/api/aliases/export` | The address book as a JSON attachment |
| POST | `/api/aliases/import` | Add back what an export wrote (additive; reports created/skipped/refused) |
| PATCH | `/api/messages/:id/read` | Set read flag |
| POST | `/api/outbox` | Compose a new message from one of your active aliases, with up to 8 files (5 MiB for the whole message) |
| GET | `/api/outbox/capabilities` | Which domains may sign mail, and today's remaining budget |
| POST | `/api/messages/:id/reply` | Answer a message from the alias it arrived on (recipient read from the stored headers) |
| GET | `/api/threads/:id` | Every message of one conversation, received and sent, oldest first |
| POST | `/api/sending/refresh` | Re-read each domain's Email Sending state from Cloudflare (read-only) |
| GET/POST | `/api/domains/:id/sending[/preview]` | What enabling sending would write; enabling itself needs an explicit confirmation |
| GET | `/api/domains/:id/sending/names` | The zone's Email Sending names, enabled or not, read live from Cloudflare |
| PUT | `/api/domains/:id/sending-via` | Which of those names this domain's mail leaves under — writes no DNS, and clears the remembered sending status |
| DELETE | `/api/messages/:id` | Delete a message (+ its R2 objects) |
| GET | `/api/messages/:mid/attachments/:aid` | Authenticated attachment download (`Content-Disposition`, `nosniff`) |
| GET | `/api/push/public-key` \| `/status` | VAPID public key + subscription count (never the endpoints) |
| POST | `/api/push/subscribe` \| `/unsubscribe` \| `/test` | Register / drop a browser subscription; owner test send |

## Security posture (summary)

See [`SECURITY.md`](./SECURITY.md) for the full model. Highlights:

- The Cloudflare API token lives **only** as a Worker secret; it is never sent to the
  browser, stored in D1, logged, or returned by any endpoint.
- **No automatic domain mutation on startup or deploy.** Provisioning is strictly
  owner-triggered after an explicit action.
- Foreign **MX** and **catch-all** records are detected and **never silently
  overwritten** — conflicts are reported and must be confirmed.
- Email HTML is sanitized and rendered in a sandboxed iframe; remote images are
  blocked by default; a plain-text fallback always exists.
- R2 is private; every message/attachment read goes through authenticated routes.
- Security headers (CSP, `nosniff`, frame-ancestors, COOP/CORP, HSTS) are applied to
  every response; `DEV_AUTH_BYPASS` cannot take effect in production.

## Notes on this build environment

`@cloudflare/vitest-pool-workers` could not boot `workerd` from this project path (it
contains a space, which breaks the pool's virtual-module resolution), so it has been
dropped. Integration tests run in a normal Node Vitest pool and drive real D1/R2 through
programmatic **Miniflare**. Application code runs on Node's native
`fetch`/`Response`/`crypto`. This keeps the tests exercising genuine storage
engines without depending on a pool that cannot start here.

`wrangler dev` and the Playwright E2E suite run correctly from the same path, so the Worker
is exercised in a real workerd runtime end to end — including sending, since wrangler 4's
runtime simulates the `send_email` binding instead of leaving it undefined.
