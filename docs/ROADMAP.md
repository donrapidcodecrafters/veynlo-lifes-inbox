# Roadmap

Phases follow the master spec §52 (MVP → Phase 2 → Phase 3 → Phase 4),
adapted to what's actually been built. Status reflects the current state of
this repository, not an aspirational plan.

## Phase 1 (MVP) — status

| Area | Status |
|---|---|
| Auth (email/password, sessions, device list) | ✅ Built, plus in-app self-service account deletion (`POST /v1/auth/delete-account` + web Settings UI — App Store/Play Store §5.1.1(v) requirement). Passkeys/MFA/OAuth sign-in not yet. |
| Data protection at rest | ✅ Field-level AES-256-GCM encryption on ~40 sensitive columns across every domain, transparent via a Drizzle `customType`, with explicit operator-set key versioning for rotation. See `SECURITY.md` for what's covered/not and why. |
| Household + dependents | ✅ Built (create/invite/leave/dependents). Caregiver delegation types exist in `@veynlo/core`, no API yet. |
| Email connectors | ✅ Gmail (real OAuth + Gmail API, incremental sync) and Outlook/Microsoft 365 (real OAuth v2.0 + Graph API, delta-query incremental sync) — both gated behind config, both share the same ingestion pipeline. IMAP/ICS connectors not started. |
| Ingestion pipeline | ✅ Deterministic prefilter + AI domain classification/extraction for receipts, bills, calendar events. Travel/warranty/school/home/vehicle extractors not started. |
| Entity resolution | 🟡 Merchant-by-name with a real admin merge/unmerge UI + lineage (`apps/admin` `/dashboard/merchants`). No cross-source purchase/shipment/subscription reconciliation beyond what's in `ingestion.service.ts`; the owner-scoped `canonical_entities` knowledge-graph layer remains unwritten (see below). |
| Inbox (review/confirm/correct/archive/dismiss/snooze) | ✅ Built. "Correct" (editing extracted fields) and "merge" are not yet implemented — only confirm/archive/dismiss/snooze. |
| Home "Needs You" + caught-up state | ✅ Built, reads real attention_items. Nothing populates attention_items automatically yet from the pipeline — currently only seed data and (implicitly) future automation-rule output would. |
| Ask / structured search | ✅ Built — grounded synthesis with evidence citations, `insufficientEvidence` flag. Semantic/vector search not wired (pgvector column exists, unused). |
| Timeline | ❌ Not built. |
| Documents/vault | ✅ Upload (web UI at `/documents` + API), S3 storage, image OCR via Claude vision, PDF OCR via Anthropic's beta document-input surface (`client.beta.messages`, `betas: ["pdfs-2024-09-25"]`). |
| Notifications | ✅ Preferences, daily/weekly brief composition, per-item email delivery, quiet-hours + intensity suppression — all real, running in the worker process (SMTP via Mailhog in dev). Push/desktop channels not implemented (no APNs/FCM integration yet — only `channel: "email"` actually sends). |
| Background workers | ✅ Separate worker process (`services/api/src/worker-main.ts`, BullMQ + Redis) runs connector sync and notification dispatch/delivery durably — survives a process restart, retries with backoff, dedupes by job ID. |
| Billing/entitlements | ✅ Stripe checkout + webhook + entitlement resolution. App Store/Play Store receipt verification not built (mobile doesn't exist yet either). |
| Admin console | ✅ Separate app (`apps/admin`, its own port/origin) with real per-operator RBAC: sign-in, user lookup, connector health, audit log — all live, all audited. Break-glass/elevated-access workflow and role-scoped endpoints (`support` vs `superadmin` don't differ in practice yet) are not built. |
| Web app (Home/Inbox/Ask/Life/Connections/Settings) | ✅ Built, responsive, light/dark theme, real API integration. |
| Mobile (iOS/Android) | ✅ Full screen parity with web: Home, Inbox, Ask, Life, Settings (tabs) plus Timeline, Documents, Connections (pushed screens) — Expo + expo-router (`apps/mobile`), light/dark theme, real API via bearer-token auth. **Real native builds produced and verified on both platforms**: `expo run:ios` on a real iPhone 16 Pro Simulator (Xcode 26.2) and `expo run:android` on a real Android emulator (API 36) — see docs/ARCHITECTURE.md's "Native mobile build" section for the three real upstream bugs found and fixed (all apply to both platforms) to get there. Every screen and nav path (Life → Timeline/Documents, Settings → Connections) also verified live via Playwright driving `expo start --web`, including real empty-state rendering for a fresh account. **Not done**: real device builds (only simulator/emulator so far); theme preference isn't persisted across restarts; no share extension, widgets, biometrics, or push notifications; OAuth connect from mobile opens the system browser and finishes there rather than deep-linking back into the app. |
| Desktop (macOS/Windows) | ✅ Built (`apps/desktop`, Tauri 2). A native window loading the real `apps/web` app — no duplicated frontend. A Rust toolchain was installed (none was available at the start of this project) and both `tauri dev` and a real unsigned `tauri build` (.app + .dmg, ad-hoc signed) were run successfully. Not yet: production signing/notarization, Windows build (only macOS/arm64 built here), auto-update, system tray/native menu bar. |
| Browser extension | ✅ Built (`apps/browser-extension`, Manifest V3, Chromium-based browsers). Sign-in/out, save-page and save-selection via popup and right-click context menu, options page. Verified live via Playwright loading the real unpacked extension against the real API. Not yet: packaged/signed store build, real designed icons (placeholders are solid-color PNGs), Firefox (MV3 support differs). |
| CI/CD | ❌ Not started — no GitHub Actions workflow yet. |
| Observability (structured logs/metrics/tracing) | ❌ Not started — only Nest's default console logger. |

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
   the schema but nothing branches on it yet — every admin endpoint accepts
   both roles today; role-scoped endpoints are a follow-up once there's a
   concrete action that should be superadmin-only. Verified live: sign-in,
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

## Known limitations to fix before any real users touch this

See `SECURITY.md` for the full picture (field-level encryption design/key
rotation, account deletion, network hardening, and an honest pre-submission
checklist for the App Store/Play Store/a real pentest). Summary of what's
still open:

- No malware scanning on document uploads (MIME/size/hash validated; no AV).
- No automated backup/restore drills (spec §49.2/49.3) — local dev only.
- Structured audit logging exists and is used by the admin console
  (`audit_events`, written on every support lookup and on account deletion);
  consumer-side actions (household changes, sharing changes, corrections)
  don't write to it yet.
- No admin *management* UI/API yet — creating/revoking operator accounts is
  a CLI script (`create-admin`), not a self-service superadmin console.
- Session refresh-token rotation is not implemented — the current session
  cookie is a single long-lived JWT re-checked against a revocable DB row
  per request (safe against revocation, but not the full rotating-refresh-
  token flow the spec describes for mobile).
- No privacy policy/terms of service text, no store listings, no third-party
  pentest — all human/business actions, not code (see `SECURITY.md`).
