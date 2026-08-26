# Architecture

This follows the master spec's recommended architecture (§41-45) unless
noted otherwise. It's a strongly modular monolith today, not microservices —
module boundaries are enforced by convention (separate NestJS modules with
narrow exports) so pieces can be split into separate services later without
a rewrite, per the spec's explicit guidance to avoid premature service
sprawl.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Shared types across API/web without publishing packages |
| Web | Next.js 15 (App Router) + Tailwind v4 | Fast to build a genuinely polished UI; Tailwind v4's `@theme` maps directly onto our CSS-variable design tokens |
| Admin | Separate Next.js app (`apps/admin`, own port/origin) | Spec §41.3 treats admin as its own deployable; a separate app also makes "consumer auth can never reach admin endpoints" structural rather than a convention |
| Mobile | Expo + expo-router (React Native) | Matches the spec's own recommendation (§41.2 "React Native shell + native modules"); one codebase for iOS/Android, `expo start --web` gives a real-browser preview path for environments without a simulator |
| API | NestJS 11 + Fastify | Module system matches the spec's bounded-context list (Appendix I) directly; Fastify for throughput |
| Database | PostgreSQL 16 + pgvector | Single source of truth; vector search colocated rather than a separate service until scale demands it |
| ORM | Drizzle | SQL-first migrations (reviewable, source-controlled), native-enough pgvector support via a small custom column type |
| Object storage | S3-compatible (MinIO locally) | Documents/receipts/scans — never a public URL, always short-lived signed URLs |
| Jobs/queues | Redis + BullMQ | Connector sync and notification dispatch/delivery run as durable, retrying jobs — never inline on an HTTP request |
| Email | Nodemailer over SMTP (Mailhog in dev) | Daily/weekly briefs and per-item notifications actually send; no fake "would send" logging |
| AI | Anthropic (`@anthropic-ai/sdk`) | Structured extraction via forced tool-use against a zod schema; Haiku for cheap/routine extraction, Sonnet for Ask synthesis |
| Billing | Stripe | Entitlement ledger normalizes across billing sources per spec §46 |

## Module boundaries (`services/api/src/modules/*`)

Mirrors spec Appendix I:

- **identity** — auth, sessions, devices. Owns nothing about life-domain content.
- **household** — membership, dependents, invitations.
- **connectors** — provider credentials, OAuth, sync orchestration. Never touches domain meaning.
- **ingestion** — turns a raw source event into domain candidates. This is the pipeline (see below).
- **intelligence** — the only place that calls the Anthropic API. Schema-constrained, versioned, cost-tiered.
- **commerce / schedule / documents** — domain read/write APIs (purchases, returns, subscriptions, bills, calendar events, tasks, document vault).
- **attention** — the Home "Needs You" queue and the Inbox review surface.
- **notifications** — preferences, daily/weekly brief composition, quiet-hours/intensity suppression, and real SMTP delivery. Push/desktop channels aren't wired (no client to receive them yet).
- **automation** — types/schema exist in `@veynlo/core`; no rule engine or execution yet (ROADMAP).
- **search** — structured SQL search + grounded Ask (semantic/vector search not yet wired — search_documents table + pgvector column exist, embeddings pipeline doesn't yet).
- **billing** — Stripe checkout + webhook, entitlement resolution.
- **admin** — metadata-only support console with its own identity plane (`admin_users`/`admin_sessions`, separate JWT audience from consumer sessions, argon2 passwords, per-operator accounts provisioned via a CLI script — no self-serve sign-up). Every support lookup is audited. Also owns merchant data-quality operations — merging duplicate merchant rows (`merchant_merge_lineage`), which is a global/shared-data operation, not a per-user one.

`packages/authz` is the one authorization chokepoint every module is
expected to call before returning or mutating another principal's data —
see its own tests (`packages/authz/src/policy.test.ts`) run against a real
Postgres instance, not a mock.

## The ingestion pipeline (§39.1)

```
SourceEvent (raw, idempotent)
  → deterministic prefilter + relevance gate   (packages: intelligence/deterministic-prefilter.ts)
  → domain classification                       (AI, schema-constrained — or skipped if unconfigured)
  → structured extraction                        (AI, schema-constrained; dates/amounts are `null`, never guessed)
  → entity resolution                            (merchant-by-name for MVP; full entity-resolution graph is a ROADMAP item)
  → canonical persistence + InboxItem creation    (commerce/schedule schema)
```

Every extraction is versioned (`extractorName`), schema-validated before it
can touch canonical tables, and produces a review item in the Inbox rather
than silently mutating state — confirming an Inbox item is what promotes a
candidate to `confidenceBand: "verified"`. Filing an Inbox item at
high/verified confidence also creates a `"useful"`-priority notification
(dedupe key `inbox-item:<id>`) — low/needs-review candidates stay silent in
the Inbox rather than paging the user about something Veynlo itself isn't
sure of.

## Background jobs and the worker process

`services/api` has two entry points compiled from the same codebase:

- `src/main.ts` — the HTTP server (Fastify).
- `src/worker-main.ts` — a headless process (`NestFactory.createApplicationContext`,
  no HTTP listener) that runs four BullMQ workers: `connector-sync`,
  `connector-scan`, `notification-dispatch`, `notification-delivery`. It resolves the exact
  same providers (`GmailAdapter`, `NotificationDeliveryService`, etc.) via
  Nest's DI container, so job-processing logic is never duplicated between
  the HTTP and worker codepaths.

Both processes must run for the product to work end-to-end in dev
(`pnpm dev` for HTTP + web, `pnpm dev:worker` for the worker) — an OAuth
callback or a filed Inbox item enqueues a job and returns immediately; the
job only actually runs once the worker process picks it up.

Job flow, concretely:

```
Gmail OAuth callback → enqueue connector-sync(kind: "initial")
  → [worker] GmailAdapter.initialSync() → ingestion pipeline → InboxItem
    → captures the mailbox's historyId into connections.cursor
    → (if high/verified confidence) NotificationDeliveryService.createAndEnqueue()
      → enqueue notification-delivery
        → [worker] checks quiet hours/intensity → sends via Nodemailer → notifications.state = "sent"

Recurring tick (every 15 min) → connector-scan
  → [worker] finds every healthy Gmail/Outlook connection
    → enqueue connector-sync(kind: "incremental") per connection
      → [worker] dispatches by connection.provider to GmailAdapter or OutlookAdapter
        → GmailAdapter.incrementalSync() → history.list from connections.cursor
        → OutlookAdapter.incrementalSync() → Graph delta query from connections.cursor
        → either way: ingestion pipeline → InboxItem → (same notification path as above)
        → advances connections.cursor; falls back to a fresh initialSync on
          Gmail's 404 (startHistoryId aged out) or Outlook's 410 (deltaLink expired)

Recurring cron (13:00 UTC daily / Monday) → notification-dispatch(daily|weekly)
  → [worker] NotificationDispatchService composes one digest per eligible user
    → same notification-delivery path as above
```

Every job is retried with exponential backoff on failure (BullMQ `attempts`/
`backoff`), deduplicated by `jobId` where re-enqueuing the same logical work
item should be a no-op, and safe to reprocess — `connector-sync` relies on
`source_events.idempotency_key`, `notification-delivery` checks
`notifications.state !== "queued"` before sending.

**Deviation from the spec's literal repo layout**: §41.3 suggests a separate
`/services/workers` app. This repo keeps one codebase with two bootstrap
entry points instead, specifically to avoid duplicating GmailAdapter/
IngestionService/NotificationDeliveryService logic across two packages.
Revisit if the worker ever needs to scale or deploy on a genuinely different
release cadence than the API.

## Data model

`packages/db/src/schema/*` is the single source of truth; `packages/core`
holds the equivalent zod types for use in application code (API responses,
validation) — they're deliberately not the same objects, since DB rows use
`Date` and zod-validated entities use ISO strings; `@veynlo/core`'s
`resolveCapability` and similar functions accept either.

Key tables: `users`/`households`/`household_memberships` (identity+household),
`connections`/`connection_credentials` (encrypted OAuth tokens, separate table
per §45.1), `source_events`/`facts`/`canonical_entities`/`relationships`/
`entity_merge_lineage` (the provenance/knowledge-graph layer — schema-complete
but currently unwritten; nothing in the ingestion pipeline creates a
`canonical_entities` row yet), `merchants`/`merchant_merge_lineage`/`purchases`/
`return_cases`/`shipments`/`recurring_streams`/`subscriptions`/`bills` (commerce
— `merchants` is a separate, global/shared reference table, not part of the
per-user knowledge graph, which is why its own merge-lineage table exists
rather than reusing `entity_merge_lineage`), `calendar_events`/`tasks`
(schedule), `documents`/`document_versions` (vault), `inbox_items`/`attention_items`/
`notifications` (attention layer), `entitlements`/`billing_events` (billing).

Money is always `{ minorUnits: integer, currency: string }` — never a float.
Dates that aren't fully certain use `TemporalValue` (`packages/core/src/util/time.ts`):
an explicit `precision` field (`instant | date | month | approximate | unknown`)
so "we don't know" is representable and never silently upgraded to a fake
certainty.

## Authentication: cookie vs. bearer token

One session token, two transports, chosen per client at sign-in/sign-up
time based on the `x-veynlo-platform` header:

- **Web/admin** (`platform: "web"`): the token lives in an httpOnly cookie
  only — never present in the JSON response body. This is deliberate: a
  compromised web page's JS reading a token straight out of a fetch
  response would defeat the entire point of httpOnly (XSS-exfiltration
  resistance).
- **Native/non-web** (`ios`/`android`/`macos`/`windows`/`extension`): no
  shared browser cookie jar with the web app's origin to rely on, so
  the same response also includes `{ token, expiresAt }`, and the client
  stores it in Keychain/Keystore (`expo-secure-store` on mobile) and sends
  it back as `Authorization: Bearer <token>`.

`AuthGuard` (`services/api/src/common/auth.guard.ts`) accepts either
transport identically — it extracts whichever is present, verifies the
JWT, then re-checks the backing `sessions` row so a revoked session takes
effect immediately regardless of which transport carried it.

`expo start --web` runs the mobile codebase in a real browser, so it
reports `Platform.OS === "web"` too and gets the cookie flow — the mobile
API client always sends `credentials: "include"` (a no-op on true native)
specifically so this works without any special-casing.

## Authorization model

`resolveAccess(db, principalUserId, resource)` in `packages/authz` is the
only function that should ever decide whether a principal can see a row
that isn't their own. It checks, in order: ownership → household
membership (only for `visibility: "household"` resources) → explicit
resource grants. `shared_link` visibility is a separate token-based path
(`resolveShareLinkAccess`). This is deny-by-default: if none of those
match, access is denied.

## What's deliberately not built yet

See `docs/ROADMAP.md` for the full, prioritized list. The short version:
full entity-resolution/merge-lineage beyond order-number/tracking-number
matching, automation rule execution,
push/desktop notification channels, native mobile builds (the Expo
codebase exists and is verified via web preview; no simulator/device
build has been produced in this environment), and production
signing/notarization + a Windows build for the desktop app (macOS/arm64
only was built here). The browser extension (`apps/browser-extension`)
and desktop app (`apps/desktop`) are both built — see their READMEs.

## Desktop app

Tauri 2, native macOS/Windows/Linux shell. Deliberately not a separate
frontend: the window just loads `apps/web` (`http://localhost:3000` in
dev, `src-tauri/tauri.conf.json`'s `app.windows[0].url`), the same way
`expo start --web` gives mobile a real-browser preview — every web
feature works here identically with zero duplicated UI code. A production
build needs that URL pointed at the real deployed web origin instead of
localhost, plus real code signing/notarization (the local build here is
ad-hoc signed, which is fine for local use but triggers Gatekeeper/
SmartScreen warnings elsewhere).

## Browser extension

Manifest V3, plain JS/HTML/CSS (no bundler — `public/` is the literal
extension root Chrome loads). Reuses two existing pieces of
infrastructure rather than building new ones:

- **Auth**: `"extension"` was added to `identity.controller.ts`'s
  `detectPlatform()` whitelist, so it gets the exact same bearer-token
  transport as mobile (`x-veynlo-platform: extension` → token in the
  sign-in/up response body, sent back as `Authorization: Bearer`,
  verified by the same `AuthGuard` as every other client).
- **Capture destination**: both the popup and the right-click context menu
  route through the existing `POST /v1/ingestion/manual` endpoint —
  the same manual/share-capture entry point used for local pipeline
  testing — rather than a new domain. The spec's §29 `saved_items` domain
  would be the more correct long-term home for captured pages (price
  snapshots, product metadata); this is a deliberate reuse of real,
  working infrastructure over a half-built parallel path.

Permissions are deliberately narrow: `activeTab` + `scripting`, not the
broader `tabs` permission — the popup and context menu only ever see the
tab the user just interacted with, in keeping with this codebase's
authorization-before-retrieval principle. Verified live via a Playwright
persistent context loading the real unpacked extension
(`--load-extension`) against the running API.
