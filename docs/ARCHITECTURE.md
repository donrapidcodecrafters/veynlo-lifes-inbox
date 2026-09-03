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
| Database | PostgreSQL 17 + pgvector | Single source of truth; vector search colocated rather than a separate service until scale demands it; matches the blueprint's Aurora PostgreSQL 17.7 LTS production target (§37/§3) |
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
- **notifications** — preferences, daily/weekly brief composition, quiet-hours/intensity suppression, and real SMTP delivery, plus real Expo push delivery (`push.service.ts`) for mobile devices with a registered token. Desktop channel still isn't wired (no client to receive it yet; falls back to email) — see ROADMAP.md.
- **automation** — a real rule engine: `AutomationService` matches rules against ingestion/inbox events, executes `notify`/`add_task`/`add_calendar_event` actions (with an approval step and a 5-minute undo window for the latter two), and an account-wide kill switch — see ROADMAP.md/PHASE2_PENDING_CREDENTIALS.md for exactly which action kinds are supported and what's still deferred.
- **search** — structured SQL search + grounded Ask (semantic/vector search not yet wired — search_documents table + pgvector column exist, embeddings pipeline doesn't yet).
- **billing** — Stripe checkout + webhook, entitlement resolution.
- **admin** — metadata-only support console with its own identity plane (`admin_users`/`admin_sessions`, separate JWT audience from consumer sessions, argon2 passwords, per-operator accounts provisioned via a CLI script — no self-serve sign-up). Every support lookup is audited. Also owns merchant data-quality operations — merging duplicate merchant rows (`merchant_merge_lineage`), which is a global/shared-data operation, not a per-user one.
- **health-logistics** — §27 HLTH-001..005, non-diagnostic appointment/refill-reminder tracking with a deliberately stricter access model than every other domain (private by default; household membership alone grants nothing — only ownership, a scoped `resourceGrants` share, or an explicit "health:read" caregiver delegation on a row the owner marked `visibility: "household"`). Backend (service/controller/DTOs, tested) is complete. Basic UI exists inline on the Life page's Health section on both platforms (list/add appointments and refill reminders, sharing). A follow-up spec-retraceability audit found several spec-named pieces still had zero UI despite real backend logic (or, for tasks, no backend mechanism at all): a task could never be linked to an appointment (`tasks.healthAppointmentId`, mirroring `bills.healthAppointmentId`, added this pass), the existing `POST /v1/health/bills/:billId/link-appointment` endpoint had no caller anywhere in the app, insurance-card/EOB documents had no way to be associated with a specific appointment (`documents.linkedEntityIds`, already the schema's own generic entity-link column, now used for this), and no export existed for the domain. All four are now built on a new standalone appointment detail page (`/life/health-appointments/[id]` on web, `/health-appointment/[id]` on mobile) — link/unlink an existing task or insurance-card/EOB document, link a bill and see/dismiss its `needsAmountReview` flag, and export the appointment's packet (or, with no `appointmentId`, everything the caller owns) as JSON via `POST /v1/health/export`, gated behind the same §28.9 step-up password the rest of this domain requires and reusing `DataExportService`'s manifest-building approach rather than a parallel export mechanism. Access control was re-verified adversarially for every new write path (a plain household member/outsider/"health:read" delegate can link nothing and export nothing outside what they own) — see `health-logistics.access.test.ts`/`health-logistics.service.test.ts`.

Authorization is enforced per-domain, not through a shared package: each
service that owns household-shareable resources (`commerce`, `schedule`,
`documents`, and others) defines its own `ownerOrDelegatedHousehold`-style
helper and applies it as a `WHERE` condition before a row is ever returned
or mutated — see `docs/SECURITY_CONTROLS.md` V1.4/V4.4 for the live
cross-tenant/IDOR verification of this pattern. A shared `packages/authz`
module existed early on but was deleted as dead, unused scaffolding
(zero imports, a weaker/duplicate household model — see
`docs/PHASE2_PENDING_CREDENTIALS.md`'s "Resolved product decisions");
duplicating a few lines of ownership logic per domain was judged not worth
the cross-module coupling a shared chokepoint would introduce.

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
`entity_merge_lineage` (the provenance/knowledge-graph layer — `canonical_entities`
and `facts` have real writers as of 2026-08-31: `IngestionService.extractReceipt`
creates one `canonical_entities` "asset" row per purchase line plus a
`purchase_details` fact, and `extractWarranty` creates a "warranty" entity
plus a `covers` relationship back to the matched asset when it finds a
confident match — see `docs/ROADMAP.md`'s Entity resolution row for what's
verified live. `entity_merge_lineage` remains unwritten — there's now real
data to merge over, but a user-facing merge/unmerge surface for personal
knowledge-graph entities hasn't been built), `merchants`/`merchant_merge_lineage`/`purchases`/
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

Each domain service's `ownerOrDelegatedHousehold`-style helper (see above)
is the function that decides whether a principal can see a row that isn't
their own. It checks, in order: ownership → household membership (only for
`visibility: "household"` resources) → explicit resource grants.
`shared_link` visibility is a separate token-based path handled by the
dedicated `sharing` module (`SharingService.resolveShareLink`, called by
`public-share.service.ts`), not per-domain. This is deny-by-default: if none
of those match, access is denied.

## What's deliberately not built yet

See `docs/ROADMAP.md` for the full, prioritized list — this section
previously went stale relative to it more than once (corrected 2026-08-31;
verify against ROADMAP.md directly before trusting a status line here
rather than the other way around). Current short version: owner-scoped
entity merge/unmerge (the admin-only merchant merge UI exists; the
per-user knowledge-graph equivalent doesn't), automation rule execution,
desktop notification channel (push notifications are built — real Expo
push delivery, see ROADMAP.md), and production signing/notarization + a
Windows build for the desktop app (macOS/arm64 only was built here). Real
native mobile builds *have* been produced (`expo run:ios`/`expo run:android`
on a real simulator/emulator, not just web-preview — see ROADMAP.md's
Mobile row) — only real physical-device builds remain undone. The browser
extension (`apps/browser-extension`) and desktop app (`apps/desktop`) are
both built — see their READMEs.

## Native mobile build

`apps/mobile` compiles to a real native app via `expo run:ios`/`expo run:android`
(not just the `expo start --web` preview). Getting a real iOS build green
surfaced — and fixed, via `pnpm patch` — three genuine upstream bugs that
`expo start --web` can never exercise, since it doesn't compile any native
Objective-C++/Swift/C++ code at all:

1. **Swift/C++ interop, `expo-modules-jsi`**: `RuntimeScheduler.h` annotated
   both of `RuntimeScheduler`'s constructors `SWIFT_RETURNS_RETAINED`, which
   Xcode 26.2's stricter Swift/C++ interop checker rejects outright
   (`'RuntimeScheduler' cannot be annotated ... because it is not returning
   a SWIFT_SHARED_REFERENCE type`). Confirmed against an Expo SDK 58 canary
   release that the real upstream fix is simply removing the annotation
   from both constructors — applied as a two-line patch
   (`patches/expo-modules-jsi@57.0.6.patch`).
2. **Unquoted path, `expo-constants`**: `get-app-config-ios.sh` did
   `PROJECT_DIR_BASENAME=$(basename $PROJECT_DIR)` — unquoted, so Xcode's
   own `$PROJECT_DIR` build setting (which resolves to the project's real
   filesystem path, not however it was invoked, so a symlink workaround
   doesn't help here) breaks on a path containing spaces. One-line fix:
   quote the variable (`patches/expo-constants@57.0.15.patch`).
3. **API version skew, `expo-modules-core` vs. `react-native-worklets`**:
   `react-native-reanimated@4.6.0` hard-requires `react-native-worklets@0.12.x`,
   but `expo-modules-core@57.0.14` (latest stable at the time) still calls
   the pre-0.12 `WorkletRuntime::executeSync` API, which 0.12.x renamed to
   `runSync` (identical signature/semantics). This is a genuine, pre-existing
   version conflict between two Expo-ecosystem packages, not something this
   project's dependency choices caused — the mismatch was visible as a
   `pnpm install` peer-dependency warning from the very first install in
   this repo's history, but never surfaced as a hard failure until a real
   native build actually compiled the code that calls it. Fixed by renaming
   the call at both its iOS and Android sites
   (`patches/expo-modules-core@57.0.14.patch`).

A fourth blocker had nothing to do with Expo: this repository's own path
(`/Volumes/Mac Projects and Files/VEYNLO Lifes Inbox`) contains spaces,
and beyond the one `expo-constants` script above, other CocoaPods-generated
`rsync`/XCFramework-copy build phases also broke on it. Rather than
patching an unbounded number of third-party scripts one at a time, the
working native-build copy lives at `~/veynlo-src` — a full copy of this
repository at a space-free path, kept in sync manually. `~/veynlo-src` is
local-machine-only, not something this repository's own files reference;
if you hit `No such file or directory: /Volumes/...`-style errors on a
different space-containing path, the fix is the same: build from a
space-free copy.

Every fix above is a `pnpm patch` (registered in `pnpm-workspace.yaml`'s
`patchedDependencies`, applied automatically on `pnpm install` — nothing
manual required beyond having the `patches/` directory), so both
`expo run:ios` and `expo run:android` work out of the box from a
space-free checkout — the same three patches fix both platforms (two are
iOS/Xcode-specific; the `expo-modules-core` `executeSync`→`runSync` fix
applies identically to its Android call site).

Verified live, both platforms: `expo run:ios` built and installed on a
real iPhone 16 Pro Simulator (Xcode 26.2); `expo run:android` built and
installed on a real Android emulator (`Medium_Phone_API_36.0`, API 36).
Both launched to the real branded sign-in screen, screenshotted for real
(`xcrun simctl io ... screenshot` / `adb exec-out screencap`). Metro
bundled all 1716 modules with no runtime errors on either platform. Every
screen (including the new Life/Timeline/Documents/Connections ones) and
nav path was also verified interactively via Playwright driving
`expo start --web`, since blind pixel-coordinate `adb input tap` on the
real emulator turned out to be too fragile for reliable field-by-field
interaction (the on-screen keyboard shifts the layout under it) — DOM-
based automation against the same React Native codebase rendered via
`react-native-web` was the more reliable interactive-verification path,
while the two native builds themselves confirm the actual compiled apps
are real and launch correctly.

One environmental note for reproducing this: two simultaneous native
build toolchains (Xcode DerivedData + Gradle/NDK caches) can consume a
large amount of disk space fast on a first build — this ran the host
disk down to under 1GB free mid-Android-build, which manifested as a
native compiler `IO failure on output stream: No space left on device`
error deep in a Gradle task, not an obviously-disk-related message.
Clearing `~/Library/Developer/Xcode/DerivedData` freed ~5.7GB and
resolved it. A crashed-mid-build Gradle daemon can also leave a stale
lock file (`Cannot lock file hash cache ... as it has already been
locked by this process`) — killing lingering `gradle`/Kotlin-daemon
Java processes and deleting the project's `android/.gradle` directory
clears it.

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
