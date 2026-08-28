# Roadmap

Phases follow the master spec §52 (MVP → Phase 2 → Phase 3 → Phase 4),
adapted to what's actually been built. Status reflects the current state of
this repository, not an aspirational plan.

## Phase 1 (MVP) — status

| Area | Status |
|---|---|
| Auth (email/password, sessions, device list) | ✅ Built, plus in-app self-service account deletion (`POST /v1/auth/delete-account` + web Settings UI — App Store/Play Store §5.1.1(v) requirement). Passkeys/MFA/OAuth sign-in not yet. |
| Data protection at rest | ✅ Field-level AES-256-GCM encryption on 50 sensitive columns across every domain (`grep -c "encryptedText(\|encryptedJsonb<" packages/db/src/schema/*.ts` — this line said "~40" until corrected 2026-08-28; count grows as new tables like `warranties` add encrypted columns, so re-verify rather than trust a stale count), transparent via a Drizzle `customType`, with explicit operator-set key versioning for rotation. See `SECURITY.md` for what's covered/not and why. |
| Household + dependents | ✅ Built (create/invite/leave/dependents/caregiver delegations — grant/list/revoke, `POST/GET /v1/households/:id/delegations`, `:id/revoke`). Delegation grants require the delegate to already be an active household member (a delegation adds a scoped capability to someone already trusted, not a way to admit an outsider), scopes are validated against a fixed enum (`schedule:read`/`documents:read`/`commerce:read`/`household:read`), and both grant/revoke are audited. `commerce:read` is now actually enforced: `HouseholdService.delegatedHouseholdIds` is the first real consumer of a granted delegation (previously the grant/list/revoke API worked but nothing ever checked a delegation before serving data), and `CommerceController`'s five read paths (purchases/bills/returns/subscriptions/warranties, including the by-ID `purchaseDetail`) now widen from "my own rows" to "my own rows, plus any household I've been delegated `commerce:read` on" — household-scoped, not per-member, matching how a grant itself has no per-member target. Verified live end-to-end: a delegate saw zero purchases before the grant, the full household's purchases/bills after it, and zero again — including on the by-ID detail route, not just the list — the moment it was revoked. `schedule:read` and `documents:read` are now enforced too, the same day: `ScheduleService` (events/tasks) and `DocumentsService` (list + the by-ID `signedUrl`/download-url path) both gained an identically-shaped `ownerOrDelegatedHousehold` helper. These two domains have a wrinkle commerce didn't: `calendar_events` and `documents` both carry a `visibility` enum (default `"private"`) that was — and, for a household member, still is — never actually enforced anywhere; rather than let a household-wide delegation grant be the first code path to leak a `"private"`-flagged row to someone, the delegated-household branch specifically excludes `visibility: "private"` (the owner's own rows are never filtered by visibility). Verified live with one household-visible and one private calendar event/document each: before the grant neither was visible; after, the household-visible ones appeared in both list endpoints and the private ones stayed hidden, including on `documents`' by-ID `download-url` route (403 before reaching the missing-file-version check, proving the authorization check itself — not a downstream error — is what blocks it); after revoke, all of it disappeared again immediately. **Not done yet**: `household:read` (viewing another member's profile/dependent info directly) remains unenforced — lower priority since `HouseholdService`'s existing `assertOwnerOrAdult` already gates most of that surface by membership role, not by delegation. |
| Email connectors | ✅ Gmail (real OAuth + Gmail API, incremental sync) and Outlook/Microsoft 365 (real OAuth v2.0 + Graph API, delta-query incremental sync) — both gated behind config, both share the same ingestion pipeline. IMAP/ICS connectors not started. Disconnecting a connection with "delete derived data" now actually deletes data (see item 14 below) instead of being a no-op the Connections page's own copy claimed was possible. |
| Ingestion pipeline | ✅ Deterministic prefilter + AI domain classification/extraction for receipts, bills, calendar events, and warranties (`extractWarranty`, `warranties` table, `GET /v1/warranties`, surfaced on Life and Timeline). Travel is partially covered by the calendar extractor; school/home/vehicle extractors not started. |
| Entity resolution | 🟡 Merchant-by-name with a real admin merge/unmerge UI + lineage (`apps/admin` `/dashboard/merchants`). No cross-source purchase/shipment/subscription reconciliation beyond what's in `ingestion.service.ts`. The owner-scoped `canonical_entities` knowledge-graph layer now has a real first writer (see item 13 below) — `extractReceipt` creates one `canonical_entities` row per purchase line and `extractWarranty` resolves back to it — but `relationships`/`facts`/`entity_merge_lineage` remain entirely unwritten (deliberately — see item 13). |
| Inbox (review/confirm/correct/archive/dismiss/snooze) | ✅ Built, including "correct" for all five linkable domains (purchase/bill/calendar_event/shipment/warranty — warranty was a gap introduced alongside the warranty extractor itself, since `correct()`'s switch had no case for it; fixed the same day). Snooze is now a real user-facing action on both web and mobile (previously the backend method existed with zero UI entry point, and — more importantly — nothing ever resurfaced a snoozed item once its `snoozedUntil` passed; added a recurring `inbox-unsnooze` worker tick, mirroring the existing `connector-scan` tick's shape, that flips due snoozed items back to `reviewState: "new"`). "Merge" was assessed and deliberately not built — see below. |
| Home "Needs You" + caught-up state | ✅ Built and now actually populated. Until this fix, `attention_items` had zero real inserters anywhere in the app — only seed data — so this screen silently stayed permanently "caught up" for every real account no matter what actually needed attention, the worst kind of gap since nothing signals it's broken. `AttentionService.scanAndFileDeadlines` (called by a new hourly `attention-scan` worker tick, `queue-producer.service.ts`/`worker-main.ts`) now files real items for bills/returns/warranties with a deadline in the next 14 days, tiered `critical`/`important`/`useful` by days remaining, and checks for an existing item on that exact linked resource (any state, not just unresolved) before inserting so a dismissed/resolved item never silently reappears. Not yet handled: auto-resolving an item when its deadline is handled outside the app (bills have no "paid" state to check today) and surfacing already-overdue deadlines (same reason — no signal to tell "handled" from "missed"). |
| Ask / structured search | ✅ Built — grounded synthesis with evidence citations, `insufficientEvidence` flag. **Fixed a real, previously-undiscovered bug**: `structuredSearch` used SQL `ILIKE` against `bills.billerLabel`/`documents.title`/`calendarEvents.title` — all three are `encryptedText` columns (AES-GCM ciphertext at rest), so those predicates could never match a plaintext query; only `purchases.orderNumber` (unencrypted) actually worked. Structured search now fetches each owner's rows (Drizzle transparently decrypts) and matches in application code instead. Also: documents were completely excluded from `ask()`'s grounding context, and structured search never checked a document's OCR'd body text at all — despite the Documents page telling users OCR'd text "will be searchable later." Both are now wired: `documents.title` OR the current version's `ocrText` are matched in structured search, and `ask()`'s context now includes a truncated excerpt of each document's OCR'd text. Verified live: searching "City" now correctly matches an encrypted `billerLabel`, and a document titled "Generic Appliance Manual" with no matching title text was found by a term ("Kryptonite") that only appeared in its OCR'd body — both via structured search and confirmed reaching `ask()`'s grounding prompt. Semantic/vector search still not wired (pgvector column exists, unused) — deferred, needs a new paid embeddings API. |
| Timeline | ✅ Built — `TimelineController`/`TimelineService` (unified chronological read projection via `UNION ALL` across canonical tables), web route at `/timeline`, mobile screen at `app/timeline.tsx`. This line was stale (said "not built") until corrected 2026-08-28 — verify against the actual code before trusting a status line rather than the other way around. |
| Documents/vault | ✅ Upload (web UI at `/documents` + API), S3 storage, image OCR via Claude vision, PDF OCR via Anthropic's beta document-input surface (`client.beta.messages`, `betas: ["pdfs-2024-09-25"]`). |
| Notifications | ✅ Preferences, daily/weekly brief composition, per-item email delivery, quiet-hours + intensity suppression — all real, running in the worker process (SMTP via Mailhog in dev). Push/desktop channels not implemented (no APNs/FCM integration yet — only `channel: "email"` actually sends). |
| Background workers | ✅ Separate worker process (`services/api/src/worker-main.ts`, BullMQ + Redis) runs connector sync and notification dispatch/delivery durably — survives a process restart, retries with backoff, dedupes by job ID. |
| Billing/entitlements | ✅ Stripe checkout + webhook + entitlement resolution, plus a real RevenueCat webhook handler (`revenuecat.service.ts`) normalizing App Store/Play Store/web entitlements into the same table — live-tested including a real bug found and fixed via a synthetic webhook call. Not built: the mobile IAP SDK/paywall UI itself (deliberately deferred — see `SECURITY.md`/roadmap testing-distribution section, since it can't be meaningfully tested without the paid Apple/Google developer accounts either way). |
| Admin console | ✅ Separate app (`apps/admin`, its own port/origin) with real per-operator RBAC: sign-in, user lookup, connector health, audit log — all live, all audited. Now includes self-service admin account management (create/list/revoke, `/dashboard/admins`), gated to `superadmin` only via a real `SuperAdminGuard` — the first place `support` vs `superadmin` actually differs. Break-glass/elevated-access workflow is still not built. |
| Web app (Home/Inbox/Ask/Life/Connections/Settings) | ✅ Built, responsive, light/dark theme, real API integration. |
| Mobile (iOS/Android) | ✅ Full screen parity with web: Home, Inbox, Ask, Life, Settings (tabs) plus Timeline, Documents, Connections (pushed screens) — Expo + expo-router (`apps/mobile`), light/dark theme, real API via bearer-token auth. **Real native builds produced and verified on both platforms**: `expo run:ios` on a real iPhone 16 Pro Simulator (Xcode 26.2) and `expo run:android` on a real Android emulator (API 36) — see docs/ARCHITECTURE.md's "Native mobile build" section for the three real upstream bugs found and fixed (all apply to both platforms) to get there. Every screen and nav path (Life → Timeline/Documents, Settings → Connections) also verified live via Playwright driving `expo start --web`, including real empty-state rendering for a fresh account. **Not done**: real device builds (only simulator/emulator so far); no share extension, widgets, biometrics, or push notifications; OAuth connect from mobile opens the system browser and finishes there rather than deep-linking back into the app. Theme preference now persists locally via `expo-secure-store` (`src/lib/theme-store.ts`) — verified live end-to-end through `expo start --web` (sign in, set Dark, reload the page, confirm it's still Dark) — but is not synced across devices via the account's `users.themePreference` column, which nothing on either platform writes to yet. |
| Desktop (macOS/Windows) | ✅ Built (`apps/desktop`, Tauri 2). A native window loading the real `apps/web` app — no duplicated frontend. A Rust toolchain was installed (none was available at the start of this project) and both `tauri dev` and a real unsigned `tauri build` (.app + .dmg, ad-hoc signed) were run successfully. Not yet: production signing/notarization, Windows build (only macOS/arm64 built here), auto-update, system tray/native menu bar. |
| Browser extension | ✅ Built (`apps/browser-extension`, Manifest V3, Chromium-based browsers). Sign-in/out, save-page and save-selection via popup and right-click context menu, options page. Verified live via Playwright loading the real unpacked extension against the real API. Not yet: packaged/signed store build, real designed icons (placeholders are solid-color PNGs), Firefox (MV3 support differs). |
| CI/CD | ✅ `.github/workflows/ci.yml` runs typecheck/lint/test on push. This row was stale (said "not started") until corrected 2026-08-28 — the "Immediate next priorities" section below already listed CI as done; verify against the actual repo before trusting a status line rather than the other way around. |
| Observability (structured logs/metrics/tracing) | 🟡 Structured logs done — `nestjs-pino` replaces Nest's default console logger (`services/api/src/logging/logging.module.ts`): JSON lines in production (one object per log entry, ready for any real aggregator), pretty-printed only in development, with `Authorization`/`Cookie`/password fields redacted so a secret never lands in a log line. Both processes (`main.ts`'s HTTP server and `worker-main.ts`'s background jobs) route through the same logger — every pre-existing `new Logger(ClassName.name)` call site across the app needed zero changes, since Nest's built-in `Logger` delegates to whatever's registered via `useLogger()`. Verified live in both modes: dev shows colorized pretty output including automatic per-request access logs (method/url/status/responseTime/request id); a real production-mode run emitted raw newline-delimited JSON with the same redaction confirmed on a request carrying real-looking `Authorization`/`Cookie` header values. **Not done**: metrics and tracing (Prometheus/OpenTelemetry or similar) — deliberately left for a separate pass, since that needs a real infra/backend decision (what collects and stores the metrics) rather than just an app-level dependency swap. |

## Immediate next priorities (in order)

1. ~~**Background job workers**~~ — done. `services/api/src/worker-main.ts` is
   a second bootstrap of the same Nest project (via `createApplicationContext`,
   no HTTP) that runs BullMQ workers for connector sync and notification
   dispatch/delivery. Architecture note: the spec's repo layout (§41.3)
   suggests a separate `/services/workers` app; this repo instead keeps one
   codebase with two entry points (`main.ts` for HTTP, `worker-main.ts` for
   jobs) so GmailAdapter/IngestionService/NotificationDeliveryService aren't
   duplicated across two packages. Revisit if/when the worker needs to scale
   or deploy independently enough that sharing a codebase becomes awkward.
2. ~~**Notification delivery**~~ — done for email. Daily/weekly brief
   composition, quiet-hours + intensity suppression, and per-discovery
   notifications (created when the ingestion pipeline files a high/verified-
   confidence Inbox item) all run for real, verified via live Mailhog
   delivery. Push/desktop channels remain unbuilt (need APNs/FCM, which in
   turn need a mobile/desktop client to receive them).
3. **Entity resolution v2** — 🟡 partially done. Purchases now dedupe on
   exact `(ownerUserId, merchantId, orderNumber)` — a second email about the
   same order (payment confirmation after order confirmation, etc.) updates
   the existing purchase instead of creating a sibling, per §40.1 "auto-merge
   exact order IDs." Shipments dedupe by tracking number and best-effort
   link to a purchase by order number alone (carrier emails don't restate
   the merchant, so this is deliberately looser than the purchase match).
   ~~Still missing: user-facing merge/unmerge with lineage~~ — done, for
   merchants specifically. `findOrCreateMerchant` matches by exact
   `displayName` string, so the same real-world merchant ends up as
   several rows across email templates ("Amazon.com" / "AMAZON MKTPLACE
   PMTS" / "Amazon, Inc."). Since `merchants` is a global, shared
   reference table (not owner-scoped) rather than a per-user knowledge-
   graph node, this is a support/admin data-quality operation — built as
   `AdminService.mergeMerchants`/`unmergeMerchants` (`apps/admin`'s new
   `/dashboard/merchants` page) with a dedicated `merchant_merge_lineage`
   table (not the pre-existing `entity_merge_lineage`, which hard-FKs to
   `canonical_entities` — an owner-scoped table nothing currently writes
   to; see below). A merge repoints every purchase from the merged
   merchant to the surviving one, snapshots the merged row instead of
   hard-deleting it, and records exactly which purchases were repointed
   so unmerge only reverses that merge's effects. A normalized-name
   grouping heuristic surfaces likely duplicates for a human to confirm —
   never an automatic merge. Every merge/unmerge is audited via the
   existing `audit_events` mechanism. `findOrCreateMerchant` now follows
   a merged merchant's `mergedIntoMerchantId` pointer so new purchases
   attach to the surviving merchant. Verified live end-to-end against the
   real API and a real Postgres instance (merge → purchase repointed →
   lineage recorded → audit event written → merged merchant excluded from
   listings → unmerge → full restore → a second unmerge attempt cleanly
   rejected as `ALREADY_UNMERGED`), and again through the actual
   `/dashboard/merchants` admin UI via a real Playwright browser session
   (duplicate-group detection, one-click merge, manual merge-by-ID, undo).
   **Still not addressed**: the owner-scoped `canonical_entities` /
   `entity_merge_lineage` knowledge-graph layer remains entirely
   unwritten — nothing in the ingestion pipeline creates a
   `canonical_entities` row today, so there is nothing there yet to merge;
   building that merge UI before the entity-resolution write path exists
   would be scaffolding with no real data behind it. VIN/tracking-number matching
   for domains beyond commerce is also still missing. ~~**Known gap**~~ — fixed. The known-sender fast path
   (`matchKnownSender`) used to map one sender domain to exactly one category, so a
   shipping-confirmation email from a sender categorized as receipt (e.g.
   amazon.com) still routed through the receipt extractor rather than the
   shipment one — fine for senders that only ever send one type of email,
   wrong for ones (like Amazon) that send both from the same domain.
   `matchKnownSender` now takes an optional subject+snippet argument;
   pure single-purpose carriers (UPS/FedEx/USPS) keep a fixed category
   exactly as before, but a domain marked `"ambiguous"` (Amazon) is
   disambiguated deterministically from shipment-specific keywords ("has
   shipped", "out for delivery", "tracking number", "delivered") instead
   of being hardcoded to one category — still no AI call, staying inside
   the cheap/deterministic fast path. Covered by unit tests asserting the
   exact failure mode this fixes, and verified live against the real
   running ingestion pipeline (a temporary debug log, added and removed
   for this verification, confirmed a simulated Amazon "has shipped"
   email resolves to shipment, a simulated Amazon order-confirmation
   email still resolves to receipt, and UPS is unaffected).
4. ~~**CI**~~ — done (`.github/workflows/ci.yml`).
5. ~~**Real admin RBAC**~~ — done. A separate `admin_users`/`admin_sessions`
   identity plane (distinct JWT audience claim so a consumer session can
   never be replayed as an admin one), per-operator accounts provisioned
   via `pnpm --filter @veynlo/api run create-admin` (no self-serve sign-up),
   argon2-hashed passwords, server-side revocable sessions, and every
   support lookup (hit or miss) written to `audit_events` with
   `actorType: "support_agent"`. `role: "support" | "superadmin"` exists in
   the schema. (This paragraph originally said nothing branched on that role
   yet — no longer true; see "Admin console" in the status table above and
   "Known limitations" below for the real `SuperAdminGuard` that now gates
   admin-management endpoints.) Verified live: sign-in,
   guarded lookup with real audit row, 401 with no cookie, and sign-out
   actually revoking the session server-side (not just clearing the cookie).
6. ~~**Outlook/Microsoft connector**~~ — done. `OutlookAdapter`
   (`services/api/src/modules/connectors/outlook.adapter.ts`) mirrors
   `GmailAdapter`'s shape exactly (`authorizationUrl`/`handleCallback`/
   `initialSync`/`incrementalSync`), using the Microsoft identity platform
   OAuth2 v2.0 endpoints and Graph API directly via `fetch` (no MSAL
   dependency — the flows involved are plain REST/JSON). Incremental sync
   uses Graph's delta query (`@odata.deltaLink`/`@odata.nextLink`) as the
   direct analog to Gmail's `history.list`/historyId, stored in the same
   `connections.cursor` column; a 401 from a stale access token
   transparently refreshes and re-persists via the credential vault rather
   than tracking expiry client-side, and a 410 (expired deltaLink) falls
   back to a fresh `initialSync`, mirroring Gmail's 404 fallback.
   `ingestion.service.ts` was refactored so `ingestGmailMessage` and the
   new `ingestOutlookMessage` both normalize into the same `ParsedEmail`
   shape and share one `ingestParsedEmail` pipeline entry point — Outlook
   messages get the identical domain-classification/extraction/dedup path
   as Gmail, not a parallel one. `worker-main.ts`'s connector-sync worker
   and the recurring connector-scan tick both now dispatch by
   `connection.provider` (gmail → GmailAdapter, outlook → OutlookAdapter)
   instead of being Gmail-only. The web app's Connections page now lists
   both providers from a small config array instead of a hardcoded Gmail
   card. Verified live: confirmed `/v1/connectors/outlook/authorize`
   returns the same `CONNECTOR_NOT_CONFIGURED` contract as Gmail when
   unconfigured; then, since this environment has no real Microsoft OAuth
   app registered, verified the token-exchange request's *shape* directly
   against Microsoft's real endpoint — sending the adapter's exact field
   set with a fake authorization code got back a deep validation error
   (`AADSTS9002313`, after passing field-presence and grant-type checks),
   which is a distinctly different, later-stage error than what a
   missing-field or wrong-grant-type request produces (verified both, to
   rule out a coincidence) — proving the request is well-formed. Also
   verified the Connections page renders both provider cards and shows
   the correct not-configured message for Outlook via a real Playwright
   browser session against the live API.
7. ~~**PDF OCR**~~ — done. `AnthropicExtractionService.extractStructured` now
   detects a `document` content block in its input and routes through
   `client.beta.messages.create` with `betas: ["pdfs-2024-09-25"]` instead
   of the stable Messages API (which doesn't accept PDF content blocks in
   the installed SDK version); everything else (image OCR, text
   extraction) is unchanged and still uses the stable path.
   `documents.service.ts`'s PDF branch, previously an unconditional `return
   null` stub, now calls this for real. Verified live: uploaded a real PDF
   through the running API with no `ANTHROPIC_API_KEY` configured (this
   environment has none) and confirmed it degrades gracefully — document
   lands in `processingState: "classified"` with no crash, same as before.
   Then, to verify the request shape itself rather than just the
   degraded-path branch, restarted the API with a deliberately invalid key
   and re-uploaded: the request reached Anthropic's real production API
   and came back with a genuine `401 authentication_error`, proving the
   beta call (model, document content block, tools, tool_choice, betas
   array) is well-formed — a malformed request would have 400'd instead,
   or failed client-side before any network call. A dedicated OCR engine
   remains a possible future swap if volume/cost data ever favors it over
   Claude vision, per the original ROADMAP note.
8. ~~**Gmail incremental/recurring sync**~~ — done. `GmailAdapter.initialSync`
   now captures the mailbox's `historyId` into `connections.cursor` right
   after the backfill; `GmailAdapter.incrementalSync` drives real
   `history.list`-based sync off that cursor (paginated, deduped per
   message, falls back to a fresh `initialSync` if Gmail 404s a
   too-old `startHistoryId`). A new recurring `connector-scan` queue tick
   (every 15 minutes, `QueueProducerService.scheduleRecurringConnectorScan`)
   finds every healthy Gmail connection and enqueues one incremental sync
   each. **Found and fixed two real bugs via live testing** (inserted a
   synthetic connection row, manually fired the scan tick, watched it
   fail, fixed, reran): (1) BullMQ 5.81+ rejects custom job IDs containing
   `:` — `enqueueConnectorSync`'s and `enqueueNotificationDelivery`'s jobId
   patterns both used `:` and were silently broken for any job that had
   never actually been exercised through the real queue before; switched
   to `-`. (2) `GmailAdapter`'s two sync methods dereferenced
   `vault.read()`'s result without a null check, so a connection with no
   matching credential vault row crashed with a cryptic
   `Cannot read properties of null (reading 'access_token')` instead of a
   clear error — added an explicit null check in both. Not yet done: Gmail
   push notifications via `watch()` (would replace polling with real-time
   push, but needs a public HTTPS endpoint Google can call, unavailable in
   local dev), per-connection scan cadence (today it's a flat 15 minutes
   for every connection).
9. ~~**Browser extension**~~ — done. `apps/browser-extension` (see its own
   README), Manifest V3, reuses the same `x-veynlo-platform`/bearer-token
   auth transport mobile uses (added `"extension"` to
   `identity.controller.ts`'s platform whitelist) and the existing
   `/v1/ingestion/manual` endpoint rather than a new domain. Prioritized
   ahead of the desktop app specifically because it needed no missing local
   toolchain to build and verify for real.
10. ~~**Desktop (macOS/Windows)**~~ — done for macOS. A Rust toolchain
    was installed via rustup (none was available at the start of this
    project) and `apps/desktop` (Tauri 2) was built and run for real:
    `tauri dev` compiled cleanly and launched a real native process
    pointed at the live `apps/web` dev server, and `tauri build` produced
    a real ad-hoc-signed `.app` + `.dmg`. Windows hasn't been built (this
    environment is macOS/arm64 only) — the Tauri config is
    platform-agnostic, so that should be a CI/cross-compile concern rather
    than a code change.

11. ~~**Warranty extractor**~~ — done. `WarrantyExtractionSchema` (in
    `extraction-schemas.ts`) and the `"warranty"` domain-classification
    label already existed but were unconsumed dead code — nothing called
    the extractor and no table existed to hold its output. Added a
    dedicated `warranties` table (mirrors `bills`'/`return_cases`' shape:
    encrypted `productLabel`, `expirationDate`/`expirationDateSort` as the
    sortable `TemporalValue` pair, plus `warrantyLengthMonths` and
    `registrationConfirmed`, with an optional FK to the `purchaseLineId`
    it belongs to — left unpopulated for now since no product-label
    matching between a warranty email and an existing purchase line
    exists yet), `IngestionService.extractWarranty` (mirrors `extractBill`
    exactly: calls `AnthropicExtractionService.extractStructured`, files
    an Inbox item with `suggestedActions: ["confirm", "correct",
    "dismiss"]`), and wired the `classifyAndExtract` dispatcher's missing
    `domains.includes("warranty")` branch — previously an email classified
    warranty-only silently fell through and got marked "filed" with
    nothing actually filed. Also added `GET /v1/warranties`
    (`CommerceService.warranties`), a Timeline `UNION ALL` branch (with
    `"warranty"` added to `ENCRYPTED_TITLE_KINDS` — the one easy-to-miss
    step, since a raw-SQL timeline query bypasses Drizzle's transparent
    decryption), and a "Warranties" section on both the web and mobile
    Life screens (using the same `daysUntil` urgency-badge pattern as
    Returns, since an expiring warranty is closer to that than to a bill's
    plain due date). Deliberately skipped: no automatic linking from a
    warranty to the purchase it belongs to (no established product-label-
    matching mechanism exists elsewhere in the pipeline to build on
    safely). Verified live end-to-end against the real running API and
    Postgres: confirmed the row is genuinely encrypted at rest
    (`product_label` reads back as ciphertext via `psql`), that
    `GET /v1/warranties` and `GET /v1/timeline` both correctly decrypt and
    return the plaintext product label, and — via a real headless-browser
    Playwright session — that the Life page's new Warranties section and
    the Timeline's new "Warranty" badge both render correctly with no
    console errors.

12. ~~**Inbox "merge" — assessed, deliberately not built**~~. "Merge" was
    listed as an unbuilt `suggestedActions` value, but it turns out to be
    purely aspirational — grepping every call site that builds
    `suggestedActions` (all in `ingestion.service.ts`) shows "merge" is
    never actually suggested to a user; it existed only as a sentence in
    this file. Investigated what it would mean: Inbox items link to a
    purchase/bill/shipment/calendar_event/warranty via
    `linkedResourceType`/`linkedResourceId`, and purchases/shipments
    already auto-dedupe deterministically (`findExistingPurchase` on exact
    `merchantId`+`orderNumber`, `findExistingShipment` on exact tracking
    number) — the only real gap is a purchase duplicated across two source
    emails where the order number is missing or differs, which the
    existing auto-merge can't catch. A manual two-item-picker merge
    UI/backend (reassigning `purchaseLines`/`shipments`/`returnCases`,
    recording lineage — the only existing pattern to copy is
    `AdminService.mergeMerchants`, which is admin-only and merges a
    different, global-reference-table kind of row) is disproportionately
    complex for that narrow a scenario, and there's no established
    domain-level "merge" concept for a receipt-tracking app's per-user
    records to build on safely. Decided against building it now — the
    better fix for the actual gap is a fuzzy fallback in
    `findExistingPurchase`, and that fallback is now built: when an email
    states no order number at all, `findExistingPurchaseByAmountAndDate`
    looks for an existing purchase with the same owner + merchant +
    identical total, dated within 2 days -- and if more than one existing
    purchase matches, treats it as no match rather than guessing (section
    40.2 precision-first). Verified live against the real pipeline (same
    mocked-AI-boundary technique as the canonical_entities verification
    above, for the same reason -- no ANTHROPIC_API_KEY in this
    environment): two no-order-number receipts for the same
    merchant/total one day apart correctly merged into a single purchase,
    while a third with a different total stayed a separate purchase
    rather than being incorrectly folded in. Also surfaced two smaller,
    unrelated facts while investigating: `dismiss` only marks the *inbox
    item* deleted, not the underlying linked resource, so a genuine
    duplicate purchase would stay in the Purchases list with no cleanup
    path even after dismissal; and the backend already suggests
    `"add_to_calendar"` for calendar-event discoveries, but neither web nor
    mobile renders a button for it (both hardcode Confirm/Correct/Snooze/
    Archive/Dismiss instead of reading `item.suggestedActions`) — low
    priority since a discovered calendar event is already written to
    `calendar_events` on confirm, so "add to calendar" wouldn't do anything
    a plain Confirm doesn't already do today.

13. ~~**canonical_entities knowledge-graph write path — first slice**~~ — done,
    deliberately narrow. `canonical_entities`/`entity_merge_lineage`/
    `relationships`/`facts` (`packages/db/src/schema/graph.ts`) existed with
    real FK plumbing already waiting (`purchaseLines.productMatchEntityId`/
    `.ownerAssetEntityId`) but zero write call sites anywhere — the same was
    true of `packages/core/src/entities/graph.ts`'s zod contract
    (`CanonicalEntityTypeSchema`/`RelationshipTypeSchema`), fully designed
    but never imported by application code. Rather than build the whole
    graph (relationships, facts, merge/unmerge UI) speculatively, shipped
    the smallest real vertical slice: `extractReceipt` now creates one
    owner-scoped `canonical_entities` row (`type: "asset"`) per purchase
    line and links `purchaseLines.ownerAssetEntityId` to it; `extractWarranty`
    resolves back to that same entity via a new `findMatchingPurchaseLine`
    helper (exact case/whitespace-insensitive `productLabel` match against
    the owner's purchase lines — deliberately no fuzzy/similarity scoring,
    per spec §40.2's precision-first stance: "false non-merge is preferable
    to incorrectly combining") and sets `warranties.purchaseLineId`
    accordingly; an unmatched warranty just leaves it `null`, same as
    before this change. No new table or migration needed — every column
    involved already existed. Deliberately NOT built in this pass:
    `relationships`/`facts`/`entity_merge_lineage` writes (nothing reads
    them yet — would be exactly the "scaffolding with no real data behind
    it" anti-pattern already called out above for the merchant-merge UI),
    any merge/unmerge UI for `canonical_entities` (no duplicate data
    exists yet to observe and design a real matching heuristic from), and
    `person`/`vehicle`/`property`/`pet` entity kinds (no extractor produces
    that data). Verified live against the real pipeline, real Postgres,
    and real encryption — with a caveat: this environment has no
    `ANTHROPIC_API_KEY` configured, so the real Claude-backed extraction
    call itself couldn't be exercised (and wouldn't be, on principle, since
    that would spend real money just to test). Instead booted the actual
    running `IngestionService` via `NestFactory.createApplicationContext`
    (same mechanism `worker-main.ts` uses) and stubbed only the
    `AnthropicExtractionService.extractStructured`/`isConfigured` boundary
    with canned responses — every line downstream of that (the
    `canonical_entities` insert, the `ownerAssetEntityId` link, the
    `findMatchingPurchaseLine` query, `warranties.purchaseLineId`) ran as
    real, unmodified production code. Confirmed: the entity was created
    with `aliases: []` set explicitly (encrypted-jsonb columns don't get a
    working DB-level default — same recurring bug class as
    `documents.tags`/`inbox_items.suggestedActions` earlier this session),
    the purchase line linked to it, and a warranty with a deliberately
    different-case, extra-whitespace product label ("  bosch 800 series
    dishwasher  " vs. "Bosch 800 Series Dishwasher") still correctly
    matched back to the same purchase line and entity.

14. ~~**Connection "delete derived data" — actually implemented**~~ — done.
    `ConnectorsService.disconnect` accepted a `deleteDerivedData` flag and
    the Connections page's own header copy told users "you can disconnect
    or delete it at any time," but the flag was a literal `// TODO` no-op
    — a privacy promise the app wasn't keeping. (Not actively misleading
    in practice: neither web nor mobile exposed a way to opt in, both
    hardcoded `deleteDerivedData: false`, so no user could have hit the
    dead code path — but the copy's claim was still false.) Now real, and
    exposed: both Connections pages gained a "Disconnect & delete data"
    action with an inline confirm step (mirrors the existing account-
    deletion confirm pattern) alongside the existing data-preserving
    "Disconnect." The actual deletion runs as a durable worker job
    (`connection-data-deletion` queue, `worker-main.ts`), same
    synchronous-mark/async-delete split as account deletion. Only
    `purchases.sourceEventId` traces directly back to a connection;
    bills/warranties/calendar_events/shipments have no such column, so
    those are found indirectly via `inbox_items` (every successful
    extraction files one, and nothing hard-deletes an inbox_item, so the
    mapping holds). Deletes purchases first so `return_cases`/`shipments`/
    `purchase_lines` FK-cascade away, captures
    `purchaseLines.ownerAssetEntityId` beforehand since `canonical_entities`
    has no matching cascade and would otherwise orphan, and clears any
    `attention_items` pointing at something being deleted. Documents are
    deliberately out of scope — they're user-uploaded, not
    connector-derived, so a connection never has any. Verified live:
    seeded a connection with one purchase (plus its line item and
    canonical-entity asset) and one bill/warranty/calendar-event/shipment
    each (filed via inbox_items, the indirect path), called the real
    `disconnect` endpoint with `deleteDerivedData: true`, and confirmed
    every table emptied to zero while the `connections` row itself
    survived (marked `disconnected`, not deleted) and a real
    `connection.delete_derived_data` audit event was written. Also
    confirmed live via Playwright that the new confirm UI renders
    correctly with no console errors.

## Phase 2 — financially sticky + household-ready

Plaid/financial aggregator integration, family plan + object-level sharing
UI, cloud file connectors (Drive/OneDrive/Dropbox), browser extension +
packaged desktop apps, home/vehicle profiles, advanced returns/refunds
dashboard, automation/rule center. None started; `@veynlo/core` already
has the automation risk-tier types (`AutomationRiskTier`, `AutomationRule`)
so the schema won't need to change when this starts.

## Phase 3 — broaden life logistics

School/activity ingestion, trip mode, recall matching, location/context
reminders, smart-home signals, pet care, saved-memory resurfacing. Not
started.

## Phase 4 — Life Agent

User-approved cancellation/renewal actions, scheduling, bill negotiation,
travel-disruption rebooking, developer API. Not started. This phase is the
highest-risk one from a safety/authorization standpoint (§34.1 risk tiers
L3/L4) and should not begin until the automation approval/audit
infrastructure from Phase 2 is proven.

## Pre-launch private testing distribution (tracked, not started)

Needed before real store submission: a way for the owner and a small set of
invited testers to use the app on their own devices — real phones/tablets
(not just simulators), laptops, browsers, and the browser extension —
without any paid account (Apple Developer Program, Google Play Console,
AWS). Requested 2026-08-28; deprioritized the same session in favor of
continuing the "100%" build-out, but tracked here so it isn't lost.

- **iOS/iPadOS — hard blocker, not a code problem.** Apple has no free path
  to install a custom app on someone else's iPhone remotely. TestFlight
  requires the paid Apple Developer Program ($99/yr); a free Apple ID can
  only self-sign a build that runs 7 days via a direct USB/Xcode connection
  per device, not something shareable as a link. Nothing to build here until
  that account exists.
- **Android — fully free, not started.** Build a signed APK (`expo build`/
  `eas build` free tier, or a local release build via the existing native
  toolchain) and distribute it as a direct download — no Google account
  needed, sideloading only.
- **Web — free, needs a reachable instance.** No server is deployed
  anywhere yet (see "Known limitations" below). Cheapest path: tunnel the
  local Docker Compose stack out (e.g. a free ngrok static domain) rather
  than standing up paid hosting just for this phase.
- **Desktop (macOS/Windows) — free, mostly already possible.** The unsigned
  Tauri build already produced this session installs today; testers just
  click through one "unidentified developer" prompt. Needs packaging/
  instructions, not new code.
- **Browser extension — free, mostly already possible.** Chrome's "Load
  unpacked" (Developer Mode) needs no account. Needs a zipped build +
  instructions, not new code.
- **Invite-gated sign-up — not started.** A `signup_invites` table (admin
  generates a code, optionally email-bound, single-use, sha256-hashed at
  rest matching the `shareLinks.tokenHash` design already scaffolded in the
  schema), a `SIGNUP_REQUIRES_INVITE` env flag, `POST /v1/admin/invites` +
  an `apps/admin` "Invites" page (clone the existing merchants page
  pattern), and `signUp()` validating/redeeming a code when the flag is on.
  Full design already scoped via a codebase research pass — implementation
  not started.

## Known limitations to fix before any real users touch this

See `SECURITY.md` for the full picture (field-level encryption design/key
rotation, account deletion, network hardening, and an honest pre-submission
checklist for the App Store/Play Store/a real pentest). Summary of what's
still open:

- Real malware scanning now exists for document uploads: a ClamAV service
  (`infrastructure/docker/docker-compose.yml`) and `MalwareScannerService`
  (`services/api/src/modules/documents/malware-scanner.service.ts`) speaking
  clamd's INSTREAM protocol directly over TCP. Optional in dev (`CLAMD_HOST`
  unset skips scanning, matching every other optional external dependency
  in this app) but fails *closed* once configured — a scan error rejects
  the upload rather than silently accepting an unscanned file. Verified
  live with a real EICAR test file: correctly detected and rejected
  (`Eicar-Test-Signature`), never stored; a genuinely clean file uploads
  normally either way. That same verification pass also caught and fixed a
  real, previously-undiscovered bug unrelated to scanning — every document
  upload crashed on `documents.tags`' NOT NULL constraint, since encrypted-
  jsonb columns don't actually get a working DB-level default (same class
  of bug as `inbox_items.suggestedActions` from earlier this session).
- No automated backup/restore drills (spec §49.2/49.3) — local dev only.
- Structured audit logging exists and is used by the admin console
  (`audit_events`, written on every support lookup and on account deletion),
  and now consumer-side household actions too (create/invite/add-dependent/
  leave, `actorType: "user"` — `household.service.ts`, verified live against
  real Postgres including that the encrypted before/after payloads round-trip
  correctly). Sharing changes and inbox corrections still don't write to it —
  no sharing feature exists yet (Phase 2), and Inbox "correct" was added
  without an audit write since it's a lower-stakes, easily-undone action
  compared to household ACL/ownership changes.
- Admin management is now a real self-service superadmin console
  (`/dashboard/admins` — list, create with a one-time-shown temporary
  password, revoke) alongside the `create-admin` CLI script, which stays
  for its actual purpose: bootstrapping the very first admin before any
  admin session exists to authenticate a UI with. First role-scoped
  endpoints in the app — a new `SuperAdminGuard` — since managing other
  operators' accounts was the concrete superadmin-only action the schema's
  role split was waiting for. Verified live: a support-role admin gets a
  clean 403 from the management routes but keeps normal access elsewhere;
  revoking an admin cuts off their already-open session immediately (not
  at next token expiry) and blocks a fresh sign-in with the same
  credentials; self-revoke and duplicate-email are both rejected.
- Session refresh-token rotation is not implemented — the current session
  cookie is a single long-lived JWT re-checked against a revocable DB row
  per request (safe against revocation, but not the full rotating-refresh-
  token flow the spec describes for mobile).
- No privacy policy/terms of service text, no store listings, no third-party
  pentest — all human/business actions, not code (see `SECURITY.md`).
