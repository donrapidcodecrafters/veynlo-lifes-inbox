# Roadmap

Phases follow the master spec §52 (MVP → Phase 2 → Phase 3 → Phase 4),
adapted to what's actually been built. Status reflects the current state of
this repository, not an aspirational plan.

## Phase 1 (MVP) — status

| Area | Status |
|---|---|
| Auth (email/password, sessions, device list) | ✅ Built, plus in-app self-service account deletion (`POST /v1/auth/delete-account` + web Settings UI — App Store/Play Store §5.1.1(v) requirement). **Google/Microsoft OAuth sign-in now built (web)** — "Continue with Google/Microsoft" on both `/sign-in` and `/sign-up`, reusing the same `GOOGLE_OAUTH_CLIENT_ID/SECRET`/`MICROSOFT_OAUTH_CLIENT_ID/SECRET` the connectors use (a different redirect URI + narrower `openid email profile` scope registered on the same OAuth client). `IdentityService.oauthSignIn` deliberately never auto-links a new OAuth sign-in to an existing password-based account just because the email matches — a well-known account-takeover pattern — it only signs in via an existing `identity_links` row; a colliding email with no link is rejected with a message pointing back to password sign-in, not silently merged. Google's id_token is verified by signature (`client.verifyIdToken`, effectively free via the existing `googleapis` dependency); Microsoft's is decoded without signature verification, safe specifically because it arrives via a server-to-server token-endpoint exchange (this process's own authenticated call), not anything attacker-influenced — the same trust model `GmailAdapter`/`OutlookAdapter` already rely on for their own tokens. Apple sign-in not built (needs a real Apple Developer account to test — client-secret-as-JWT and native-only nuances make it a distinct follow-up, not a quick addition). Native (mobile) sign-in-with-provider not built either — same already-documented gap as connector connect (system browser, no deep-link handback yet). **Found and fixed a real, previously-shipped bug while building this**: every existing OAuth callback (Gmail/Outlook/Google Calendar/Microsoft Calendar) returned a plain JSON body on what is actually a full browser navigation (Google/Microsoft redirect the browser directly back to the API) — meaning a user who just connected Gmail would land on a page showing raw `{"connectionId":"...","redirectTo":"..."}` text instead of being sent back to the Connections page; nothing ever executed that `redirectTo`. Fixed with real `reply.redirect()` calls, which surfaced a second layer of the same bug: Fastify's `redirect(url)` (no explicit code) reuses whatever status NestJS already pre-set on the reply (200) instead of defaulting to 302, so every redirect needed an explicit `res.redirect(url, 302)` — confirmed via a real `curl -D -` check that the fix actually changed the wire response from `200 OK` with an inert `Location` header (which browsers ignore on a 200) to a real `302 Found`. The Connections page now reads the `?connected=`/`?error=` query params these redirects land with, instead of the params being silently dropped, and the sign-in page does the same for OAuth sign-in errors. Verified live end-to-end: confirmed real `302` status + correct `Location` on both `/v1/auth/google/authorize`/`microsoft/authorize` (not-configured case) and a connector callback with an authenticated cookie; exercised `oauthSignIn`'s three real paths directly (new-account creation with `passwordHash: null`, idempotent repeat sign-in resolving to the same user rather than duplicating, and the cross-provider same-email attempt being rejected with `EMAIL_ALREADY_REGISTERED`); confirmed via a real Playwright session that the sign-in page renders both provider buttons and the error banner, and the Connections page renders its new success banner. **Mobile biometric app lock now built**: `expo-local-authentication` gates the whole authenticated app behind Face ID/Touch ID/device passcode (`LockGate` in `app/_layout.tsx`) when the user turns it on in Settings → Security — locks again on backgrounding, unlocks via a real native prompt. Deliberately a device-local client preference (stored via `expo-secure-store`, same tier as theme) rather than being backed by the `devices.biometricLockEnabled` DB column — that column belongs to a separate, still-unbuilt server-tracked device-management feature (worth noting: `issueSession` creates a brand-new `devices` row on every sign-in with no reuse for the same physical device, so that column isn't stably addressable per-device yet anyway). Gracefully shows a disabled toggle with "Set up Face ID..." copy when hardware/enrollment isn't available, rather than a broken switch — verified live via a real `expo start --web` + Playwright session (web has no biometric hardware, so this is exactly the path that exercises the unsupported-state UI) — no console errors, and the correct disabled-toggle state rendered. Native Face ID/Touch ID prompts themselves are only exercisable on a real iOS/Android build, not this web preview — not independently verified live this pass. |
| Data protection at rest | ✅ Field-level AES-256-GCM encryption on 50 sensitive columns across every domain (`grep -c "encryptedText(\|encryptedJsonb<" packages/db/src/schema/*.ts` — this line said "~40" until corrected 2026-08-28; count grows as new tables like `warranties` add encrypted columns, so re-verify rather than trust a stale count), transparent via a Drizzle `customType`, with explicit operator-set key versioning for rotation. See `SECURITY.md` for what's covered/not and why. |
| Data export (PRIV-002) | ✅ Built — previously completely absent (no `export_jobs` table, no route, no UI) despite the `data_export` `CapabilityKey` existing since the entitlements system shipped. `POST /v1/data-export` creates an `export_jobs` row and enqueues a real BullMQ job (`data-export` queue/worker, mirroring `connection-data-deletion`'s "controller does the synchronous part, worker does the real work" split); the worker (`DataExportService.buildManifest`) gathers the caller's own purchases (+lines/returns/shipments)/bills/warranties/subscriptions(+streams)/calendar events/tasks/document metadata/inbox items/notifications/notification preferences/household memberships — transparently decrypted via Drizzle — into one JSON manifest uploaded to S3, never a permanent public URL (`GET /v1/data-export/:id/download-url` mints a fresh 5-minute signed URL on demand, same pattern as `documents.controller.ts`). `/settings/data-export` (web) and `app/data-export` (mobile) show job status (queued/processing/completed/failed, polling every 3s while pending) and a Download button once ready. Deliberately excludes document file bytes (the manifest names what it left out — see its own `notIncluded` field — rather than silently omitting), connector OAuth credentials, and other household members' private rows. Verified live end-to-end: requested a real export via curl against the running API, confirmed the worker log showed the job complete in ~70ms, downloaded the actual signed S3 URL and confirmed the manifest's `profile.displayName` came back correctly decrypted plaintext (not ciphertext) and its domain counts matched the real seed data; also verified via a real Playwright session against the live web app (request → poll → completed → Download button, no console errors). **Not built**: no scheduled cleanup of expired export blobs past the 7-day `expiresAt` tracked on the job row (S3 objects are left in place after expiry rather than actually deleted) — same class of deliberate deferral as this session's other explicitly-noted gaps (metrics/tracing, IMAP). |
| Privacy/consent center (PRIV-001) | ✅ Built — a final MVP completeness pass found the spec's required single view ("what's connected, per-source scopes, AI-processing setting, export, disconnect/delete") had no real surface: those controls were scattered across Connections/Settings/Data-export with no AI-processing toggle anywhere, and `IdentityService`/`users` had no such column at all — meaning a user who wanted Veynlo to stop running AI on newly captured items had no way to ask for that, despite `AnthropicExtractionService` being the thing that reads every subject line/snippet/attachment that comes in. Added `users.aiProcessingEnabled` (boolean, default true) and `POST /v1/auth/ai-processing`, gated in `IngestionService.classifyAndExtract` at the very top of the method — before the deterministic `matchKnownSender` branch — because a known-sender match still routes into domain-specific extractors (`extractReceipt`/`extractBill`/etc.) that independently call `this.ai.extractStructured`; gating only the AI-classifier call would have left known-sender mail still AI-processed for an opted-out user. When off, incoming items are filed as-is (`markProcessed(..., "filed")`) with zero AI calls. New `/settings/privacy` (web) and `app/privacy` (mobile) pages assemble the real consolidated view: the AI-processing switch, a live "what's connected" summary (provider + health badge, sourced from the same `GET /v1/connectors` Connections already uses) linking out to Connections for management, the export link (PRIV-002), and a link to Settings' existing delete-account flow rather than a duplicate one. Verified live end-to-end via the mocked-AI-boundary technique: with processing on, a genuine unmodified `ingestManualText` call reached `extractStructured` and created a real bill; with it toggled off via the real endpoint, an identical email produced zero `extractStructured` calls and zero domain rows, filed as `"filed"`; toggled back on, extraction resumed — confirmed via the bill's actual `inbox_items` linkage (encrypted columns can't be equality-matched directly, so lookups go through the unencrypted linking row, same pattern used elsewhere for bills/warranties evidence). Also verified via real Playwright sessions on both web (`/settings/privacy`) and mobile (`expo start --web` → `/privacy`) — all four sections render, the real switch fires a genuine `POST /v1/auth/ai-processing` (`{"enabled":false}`, HTTP 201), no console errors, clean screenshots on both platforms. |
| Household + dependents | ✅ Built (create/invite/leave/dependents/caregiver delegations — grant/list/revoke, `POST/GET /v1/households/:id/delegations`, `:id/revoke`). Delegation grants require the delegate to already be an active household member (a delegation adds a scoped capability to someone already trusted, not a way to admit an outsider), scopes are validated against a fixed enum (`schedule:read`/`documents:read`/`commerce:read`/`household:read`), and both grant/revoke are audited. `commerce:read` is now actually enforced: `HouseholdService.delegatedHouseholdIds` is the first real consumer of a granted delegation (previously the grant/list/revoke API worked but nothing ever checked a delegation before serving data), and `CommerceController`'s five read paths (purchases/bills/returns/subscriptions/warranties, including the by-ID `purchaseDetail`) now widen from "my own rows" to "my own rows, plus any household I've been delegated `commerce:read` on" — household-scoped, not per-member, matching how a grant itself has no per-member target. Verified live end-to-end: a delegate saw zero purchases before the grant, the full household's purchases/bills after it, and zero again — including on the by-ID detail route, not just the list — the moment it was revoked. `schedule:read` and `documents:read` are now enforced too, the same day: `ScheduleService` (events/tasks) and `DocumentsService` (list + the by-ID `signedUrl`/download-url path) both gained an identically-shaped `ownerOrDelegatedHousehold` helper. These two domains have a wrinkle commerce didn't: `calendar_events` and `documents` both carry a `visibility` enum (default `"private"`) that was — and, for a household member, still is — never actually enforced anywhere; rather than let a household-wide delegation grant be the first code path to leak a `"private"`-flagged row to someone, the delegated-household branch specifically excludes `visibility: "private"` (the owner's own rows are never filtered by visibility). Verified live with one household-visible and one private calendar event/document each: before the grant neither was visible; after, the household-visible ones appeared in both list endpoints and the private ones stayed hidden, including on `documents`' by-ID `download-url` route (403 before reaching the missing-file-version check, proving the authorization check itself — not a downstream error — is what blocks it); after revoke, all of it disappeared again immediately. **Not done yet**: `household:read` (viewing another member's profile/dependent info directly) remains unenforced — lower priority since `HouseholdService`'s existing `assertOwnerOrAdult` already gates most of that surface by membership role, not by delegation. |
| Email & calendar connectors | ✅ Gmail (real OAuth + Gmail API, incremental sync) and Outlook/Microsoft 365 (real OAuth v2.0 + Graph API, delta-query incremental sync) — both gated behind config, both share the same ingestion pipeline. Disconnecting a connection with "delete derived data" now actually deletes data (see item 14 below) instead of being a no-op the Connections page's own copy claimed was possible. **ICS calendar-feed connector now built too** (see item 15 below) — a genuinely different thing from IMAP despite the roadmap having lumped them together historically: ICS is a calendar-feed-by-URL subscription (no email protocol, no AI extraction, a VEVENT maps ~1:1 onto a `calendar_events` row), so it shipped as its own small, low-risk connector. **Google Calendar direct sync now built too** (`google-calendar.adapter.ts`) — a distinct connection from Gmail (separate `provider: "google_calendar"` row, so a user can connect either without the other), reusing the same `GOOGLE_OAUTH_CLIENT_ID/SECRET` since one Google Cloud OAuth app can request both scopes. Structurally identical to ICS, not Gmail: a Calendar API event already IS a calendar event, so there's no domain classification/AI extraction step — both connectors now share one `IngestionService.ingestFeedCalendarEvent` write path (renamed from the ICS-only `ingestIcsEvent`, idempotency key now prefixed by provider so two feed-style connectors sharing a UID format can't collide). Incremental sync uses the Calendar API's `syncToken` (Gmail's `historyId` equivalent), including update-in-place and cancelled-event deletion, with the documented recovery (fresh full resync) when a `syncToken` expires (410 Gone). Verified live: confirmed `GET /v1/connectors/google-calendar/authorize` returns a clean `CONNECTOR_NOT_CONFIGURED` 503 (no Google OAuth credentials in this dev environment, matching every other optional external dependency), confirmed via direct calls to `ingestFeedCalendarEvent` that a real event creates a `calendar_events` row, an identical re-sync is correctly a no-op, and a changed re-sync (simulating a rescheduled meeting) updates in place rather than duplicating, and confirmed via a real Playwright session that the Connections page lists Google Calendar with the correct not-configured messaging. **Microsoft Calendar direct sync now built too** (`microsoft-calendar.adapter.ts`) — a separate connection from Outlook mail (own `provider: "microsoft_calendar"` row, same `MICROSOFT_OAUTH_CLIENT_ID/SECRET`), using Graph's `calendarView/delta` (bounded to a date range unlike plain message delta — the initial window runs from `historyDepthDays` in the past to 2 years in the future, since a calendar sync's whole point is upcoming events, not just backfill). **Caught and fixed a real correctness bug before it ever shipped**: Graph's event `dateTime` fields are naive local timestamps with no UTC offset (the actual zone is a separate `timeZone` field) — the first draft blindly appended `"Z"` to treat that local wall-clock time as UTC, which would have silently shifted every synced event's time by its zone's offset. Fixed by sending `Prefer: outlook.timezone="UTC"` on every request (Microsoft's documented way to make the API itself return already-UTC values), so appending `"Z"` afterward is correct precisely because of that header. Verified live the same way as Google Calendar: `GET /v1/connectors/microsoft-calendar/authorize` returns a clean `CONNECTOR_NOT_CONFIGURED` 503, and a direct call to the shared `ingestFeedCalendarEvent` (this time exercising the all-day-event branch, which Google Calendar's own verification didn't cover) correctly created a `calendar_events` row and the cancelled-event deletion path correctly removed it — confirmed via a real Playwright session that both new providers list correctly on the Connections page. **Apple/device local calendar now built too** (`POST /v1/ingestion/device-calendar` + `expo-calendar` on mobile) — architecturally different from every other calendar connector: a device's own Calendar app has no OAuth token or feed URL a server could poll, so this is push-from-client instead of a `connections` row this process syncs on its own schedule. The mobile Connections screen's new "This phone's calendar" card reads local events (`expo-calendar`, -30/+365 day window, up to 500 events) and posts them to the same `ingestFeedCalendarEvent` write path the other three calendar connectors share; `connectionId` there is genuinely `null` for this source (the parameter's type changed from `string` to `string | null` to allow it), with the idempotency key falling back to scoping by `ownerUserId` instead. Manual "Sync now" only, not a background job — real background sync needs `TaskManager`/`BackgroundFetch` (its own cross-platform battery/OS-permission complexity), a deliberately separate, larger follow-up. Verified live: a real `POST` with one timed and one all-day event correctly created both `calendar_events` rows with the right `precision`/`date`/`instantUtc` shape, a re-post of the same event was correctly idempotent (`filedCount: 0`), and malformed input correctly 400'd; confirmed via a real Playwright session driving `expo start --web` that the card renders and "Sync now" fails gracefully (`expo-calendar` has no real implementation in a browser) rather than crashing — the same "not configured on this platform" pattern used elsewhere, not independently verified against a real device's actual calendar since that needs a real iOS/Android build. **Found and fixed a real bug in that same feature on a later pass**: `syncDeviceCalendar` called `Calendar.requestCalendarPermissionsAsync()`/`getCalendarsAsync()`/`getEventsAsync()` — the legacy `expo-calendar` API names — but this app's SDK version resolves the plain `"expo-calendar"` import to the package's new object-oriented API, whose same-named `"...Async"` exports are deprecated stubs that unconditionally `throw` at runtime (confirmed by reading the compiled package source directly, not guessing). It typechecked cleanly and passed the `expo start --web` verification above, because web can't execute native `expo-calendar` calls at all — so a real device would have crashed the instant a user tapped "Sync now," and nothing before now could have caught it. Fixed by switching to the real non-deprecated names (`requestCalendarPermissions`/`getCalendars`/`listEvents`). **Apple Reminders sync now built too** (`Calendar.requestRemindersPermissions`/`getCalendars(EntityTypes.REMINDER)`/`calendar.listReminders`, iOS only — Android has no EventKit-equivalent Reminders framework, so the card is conditionally hidden there) — read-only import mirroring the calendar card exactly, writing into `tasks` via a new `IngestionService.ingestDeviceReminder` (the first real writer into that table; `GET /v1/tasks`/`POST /v1/tasks/:id/complete` already existed and worked, they just had nothing to read). Dedup uses `tasks.externalSyncProvider`/`externalSyncId` — columns that existed in the schema for exactly this since the pipeline shipped but nothing had populated before now. Mobile's Life tab gained a "Reminders" section (list + inline "Done" completing a task) since otherwise synced reminders would land in a table nothing rendered. Verified live: typecheck/lint clean across the whole workspace, then a real native `expo run:ios` build (Xcode 26.2, iPhone 16 Pro Simulator) — this surfaced two real environment issues fixed along the way (CocoaPods needs `LANG=en_US.UTF-8` set in this shell environment or `pod install` crashes with a Ruby encoding error; this repo's own space-containing path breaks CocoaPods script phases beyond the one already-patched `expo-constants` script, so the build had to run from the already-documented space-free `~/veynlo-src` mirror, freshly re-synced from this repo's current `HEAD` plus working-tree changes via `pnpm install` + `pod install`) — confirmed `Build Succeeded`, installed, and launched to the real sign-in screen on the simulator, screenshotted for real. No `idb`/`applesimutils`-equivalent tap-automation tool is available in this environment to script the actual "sign in → Connections → tap Sync now" interaction, so the specific runtime call wasn't exercised end-to-end this pass — the correctness evidence is the direct source-read of `expo-calendar`'s real vs. stub implementations plus a clean native compile/link/launch, not a full interactive trace; a human tapping through it once on that same simulator would close the last gap. **IMAP itself remains not started** — researched and deliberately deferred, not because it doesn't fit the architecture (it does — no schema migration needed, the same `cursor`/`credentialRef`/`health` columns already work), but because it needs a local IMAP test server (none exists in this repo's dev infra — `docker-compose.yml` has no Dovecot/GreenMail) to verify the UID/UIDVALIDITY sync logic against something real rather than only-typechecked, and because it's the first connector that would store something as sensitive as a live mailbox password (not a revocable OAuth token) — worth an explicit decision on that posture and the "use an app-specific password" UI copy before building it, not a call to make silently. **Generic forwarding/import fallback (CAP-005) now built too** — the lowest-permission capture path the spec wants (§12.1/§52.1): a per-user unique inbound email address, no OAuth grant or shared inbox access required. Users get an opaque `inboundEmailAlias` (a random token, not the userId itself — generated at sign-up, deliberately rotatable independent of the account so a leaked/spammed alias can be replaced) surfaced as `u-{alias}@{INBOUND_EMAIL_DOMAIN}`. New `POST /v1/ingestion/inbound-email` accepts a Postmark-shaped inbound-parse payload (`To`/`From`/`Subject`/`TextBody`), sits outside `IngestionController`'s `AuthGuard` entirely (the caller is an email provider, not a signed-in user) in its own `InboundEmailController`, authenticates via a shared webhook secret header (same static-secret pattern as the RevenueCat webhook, not Stripe's raw-body HMAC — no `main.ts` raw-body wiring needed), resolves "which user" by parsing the alias out of the `To` header and looking it up, then reuses the exact same `IngestionService.ingestManualText` write path url-capture and manual-paste already share (new `kind: "inbound_email"`). An unrecognized/rotated-away alias returns `200 {routed:false}` rather than erroring, so a provider retries a bounced message forever exactly zero times, not indefinitely. Both `INBOUND_EMAIL_DOMAIN`/`INBOUND_EMAIL_WEBHOOK_SECRET` are optional — with neither set (this dev environment's default), the alias UI shows a clear "not configured on this deployment yet" instead of displaying an address that could never actually receive anything, matching every other optional-external-dependency degradation in this codebase. Web (`/connections`) and mobile (`app/connections.tsx`) both gained a "Forward emails to Veynlo" card: the live address, a Copy button, and a "Generate a new address" rotate flow with an explicit confirm step (old address stops working immediately, no grace period). Verified live end-to-end: restarted the real API with temporary test env vars, confirmed `GET /v1/auth/inbound-alias` correctly reports `configured:false` with neither var set and a real address once both are; simulated a real inbound webhook POST via curl (no live Postmark/Mailgun account exists, so this is the same "verify without live third-party credentials" approach already used for Google/Microsoft OAuth callbacks) and confirmed it created a real `source_events` row correctly attributed to the right user via the alias, correctly rejected with 401 on a wrong webhook secret, and correctly no-opped with `routed:false` on an unrecognized alias; confirmed via real Playwright sessions on both web and mobile that the address renders, Copy actually puts the real address on the clipboard, and rotating genuinely changes the displayed address and invalidates the old one. Restarted the API back to its unconfigured state afterward and confirmed the alias UI returns to its honest "not configured" state. |
| Ingestion pipeline | ✅ Deterministic prefilter + AI domain classification/extraction for receipts, bills, calendar events, warranties, and now subscriptions (`extractWarranty`/`extractSubscription`, surfaced on Life and Timeline). Travel is partially covered by the calendar extractor; school/home/vehicle extractors not started. **Subscription extractor fixed this pass**: nothing anywhere in the ingestion pipeline used to write to `subscriptions`/`recurring_streams` — the domain classifier already emitted a `"subscription"` label, but `classifyAndExtract` routed it into `extractBill` alongside `"bill"`, so a subscription renewal email was filed as a plain bill and the `recurring_streams`/`subscriptions` tables stayed permanently empty for every real user (seed data was the only thing ever in them — the same silently-empty-for-every-real-user shape as the `attention_items` gap fixed earlier this session). Added a real `extractSubscription` (mirrors `extractBill`'s shape: `SubscriptionExtractionSchema`, creates a `recurring_streams` row plus a `subscriptions` row, files an Inbox item) and split the classifier routing so `"subscription"` no longer falls into `extractBill`. Also wired the two gaps this surfaced: `CommerceService.subscriptionDetail`'s evidence was hardcoded `null` with a comment saying nothing could ever create one — now resolves real evidence via the same `evidenceViaInboxItem` pattern bills/warranties use; and `InboxService.correct()`'s switch had no `"subscription"` case (would 400 with `UNSUPPORTED_RESOURCE_TYPE` the moment a real one existed) — added `correctSubscription`, which spans both tables (serviceLabel/cadence/amount on the stream, cancellation URL on the subscription itself). Verified live end-to-end via the mocked-AI-boundary technique: a genuine renewal email ingested through unmodified `IngestionService.ingestManualText` correctly classified as `subscription`, created real `recurring_streams`/`subscriptions` rows, filed an Inbox item with working `confirm`/`correct` actions, resolved real evidence (subject/snippet/sender) on `subscriptionDetail`, and appeared in `subscriptions()`'s list — all test data cleaned up after. |
| Entity resolution | 🟡 Merchant-by-name with a real admin merge/unmerge UI + lineage (`apps/admin` `/dashboard/merchants`). No cross-source purchase/shipment/subscription reconciliation beyond what's in `ingestion.service.ts`. The owner-scoped `canonical_entities` knowledge-graph layer now has a real first writer (see item 13 below) — `extractReceipt` creates one `canonical_entities` row per purchase line and `extractWarranty` resolves back to it — but `relationships`/`facts`/`entity_merge_lineage` remain entirely unwritten (deliberately — see item 13). |
| Inbox (review/confirm/correct/archive/dismiss/snooze) | ✅ Built, including "correct" for all six linkable domains (purchase/bill/calendar_event/shipment/warranty/subscription — warranty and subscription were both gaps introduced alongside their own extractors, since `correct()`'s switch had no case for either; both fixed the same day their extractor shipped). Snooze is now a real user-facing action on both web and mobile (previously the backend method existed with zero UI entry point, and — more importantly — nothing ever resurfaced a snoozed item once its `snoozedUntil` passed; added a recurring `inbox-unsnooze` worker tick, mirroring the existing `connector-scan` tick's shape, that flips due snoozed items back to `reviewState: "new"`). "Merge" was assessed and deliberately not built — see below. **Manual capture UI now built too**: `POST /v1/ingestion/manual` (the "paste an email's text" entry point that already existed on the backend, doubling as the fastest way to test the pipeline without live Gmail/Outlook OAuth) had zero UI anywhere on web or mobile — an "Add manually" button on the Inbox page (both platforms) opens a subject/from/body form that posts to it and shows a deliberately honest, non-committal confirmation ("if Veynlo finds something worth reviewing, a card will appear here shortly") rather than assuming a card always appears, since extraction genuinely may find nothing. Verified live via a real Playwright session against the running web app: submitted a real bill-like text through the actual form, confirmed the real `201` response and the confirmation UI, no console errors. **URL capture now built too** (`POST /v1/ingestion/url` + a "Paste text" / "From a URL" mode toggle on the same capture form, both platforms) — the server fetches the page itself, which is a real SSRF risk if not handled carefully: a naive implementation would let a user submit `http://169.254.169.254/latest/meta-data/` (cloud instance metadata) or an internal `http://localhost:PORT/...` and use Veynlo's own server as a proxy into infrastructure the public internet can't reach. `SafeUrlFetcher` resolves the hostname via real DNS *before* fetching and rejects any address in a private/reserved range (RFC1918, loopback, link-local/metadata, CGNAT, multicast, IPv6 unique-local/link-local, IPv4-mapped-IPv6) — checked again on every redirect hop (redirects aren't auto-followed; each `Location` is re-resolved and re-validated, capped at 5 hops), with a response-size cap, a content-type allowlist (`text/html`/`text/plain` only), and a request timeout. Locked in with 11 real unit tests (`safe-url-fetcher.test.ts`) covering boundary cases most exploit attempts specifically target (e.g. `172.15.255.255` allowed vs. `172.16.0.0` blocked — one address either side of the RFC1918 range). Extracted title/text reuses the exact same `ingestManualText` write path as manual capture (`kind: "url_capture"`, source URL stored as the evidence `fromAddress`) rather than a parallel pipeline. Verified live end-to-end: real `curl` attempts against `localhost`, `127.0.0.1`, the cloud metadata address, and a `file://` scheme were all correctly rejected with `400 URL_UNREACHABLE`/`UNSUPPORTED_URL_SCHEME`; a real fetch of `https://example.com/` correctly extracted the page's actual title/body text into an encrypted `source_events` row (confirmed decrypted); confirmed via a real Playwright session that the web capture form's URL mode round-trips through the real endpoint with no console errors. |
| Home "Needs You" + caught-up state | ✅ Built and now actually populated. Until this fix, `attention_items` had zero real inserters anywhere in the app — only seed data — so this screen silently stayed permanently "caught up" for every real account no matter what actually needed attention, the worst kind of gap since nothing signals it's broken. `AttentionService.scanAndFileDeadlines` (called by a new hourly `attention-scan` worker tick, `queue-producer.service.ts`/`worker-main.ts`) now files real items for bills/returns/warranties with a deadline in the next 14 days, tiered `critical`/`important`/`useful` by days remaining, and checks for an existing item on that exact linked resource (any state, not just unresolved) before inserting so a dismissed/resolved item never silently reappears. Not yet handled: auto-resolving an item when its deadline is handled outside the app (bills have no "paid" state to check today) and surfacing already-overdue deadlines (same reason — no signal to tell "handled" from "missed"). |
| Ask / structured search | ✅ Built — grounded synthesis with evidence citations, `insufficientEvidence` flag. **Fixed a real, previously-undiscovered bug**: `structuredSearch` used SQL `ILIKE` against `bills.billerLabel`/`documents.title`/`calendarEvents.title` — all three are `encryptedText` columns (AES-GCM ciphertext at rest), so those predicates could never match a plaintext query; only `purchases.orderNumber` (unencrypted) actually worked. Structured search now fetches each owner's rows (Drizzle transparently decrypts) and matches in application code instead. Also: documents were completely excluded from `ask()`'s grounding context, and structured search never checked a document's OCR'd body text at all — despite the Documents page telling users OCR'd text "will be searchable later." Both are now wired: `documents.title` OR the current version's `ocrText` are matched in structured search, and `ask()`'s context now includes a truncated excerpt of each document's OCR'd text. Verified live: searching "City" now correctly matches an encrypted `billerLabel`, and a document titled "Generic Appliance Manual" with no matching title text was found by a term ("Kryptonite") that only appeared in its OCR'd body — both via structured search and confirmed reaching `ask()`'s grounding prompt. Semantic/vector search still not wired (pgvector column exists, unused) — deferred, needs a new paid embeddings API. |
| Timeline | ✅ Built — `TimelineController`/`TimelineService` (unified chronological read projection via `UNION ALL` across canonical tables), web route at `/timeline`, mobile screen at `app/timeline.tsx`. This line was stale (said "not built") until corrected 2026-08-28 — verify against the actual code before trusting a status line rather than the other way around. |
| Documents/vault | ✅ Upload (web UI at `/documents` + API), S3 storage, image OCR via Claude vision, PDF OCR via Anthropic's beta document-input surface (`client.beta.messages`, `betas: ["pdfs-2024-09-25"]`). **Fixed a real gap**: HEIC — the default photo format on iPhone, so a genuinely common real case — was explicitly listed as an accepted upload type (`ALLOWED_MIME_TYPES`, and the "isn't supported yet... Try PDF, JPG, PNG, HEIC" error copy) but OCR silently no-op'd for it (`return null`, since Claude's vision input doesn't accept HEIC directly), leaving the document permanently un-searchable with no error or indication anything was wrong — the same "declared capability does nothing" shape as the search/connection-deletion bugs fixed the same day. Now transcodes HEIC → JPEG via `heic-convert` before the same vision call every other image uses. Verified live and for real: converted an actual PNG in this repo to a genuine HEIC file via macOS's own `sips`, uploaded it through the real `DocumentsService.upload()` (mocking only the Anthropic call boundary, since this environment has no `ANTHROPIC_API_KEY`), and confirmed the vision call actually received `image/jpeg` bytes (not `image/heic`) and the resulting document landed with `processingState: "extracted"` and real OCR text — not just a typecheck-level claim. |
| Notifications | ✅ Preferences, daily/weekly brief composition, per-item email delivery, quiet-hours + intensity suppression — all real, running in the worker process (SMTP via Mailhog in dev). **Push channel now built.** Previously `deliver()` accepted a `channel` on the notification row (including `"push"`) but never actually read it — every notification silently sent via `mailer.send()` regardless, a real shipped bug (a "push" notification was actually an email the whole time). Added a real Expo push path: `devices.pushToken` (declared in the schema since early in the session but never written to or read by anything) is now populated by a new `POST /v1/auth/push-token` (resolves the caller's session to its device row — the only per-device identity a session carries — and updates that row) and read by `deliver()`, which now branches on `notification.channel`: `"push"` looks up the user's most-recently-active non-revoked device with a token and sends via a new `PushService` (`expo-server-sdk`, no external credential needed for classic sends — Expo's push API takes none). Falls back to the existing email path whenever there's no registered token, the token is malformed, or Expo's ticket comes back as an error — same "not configured" degradation as every other optional delivery mechanism, never a silently dropped notification. Mobile gained the client half: `expo-notifications` (installed via `expo install` for correct SDK-57 pinning) + a new `PushRegistration` component (mounted in `_layout.tsx`, fires once per sign-in) that requests permission and calls `getExpoPushTokenAsync`, then posts the token — but only on native platforms with a real EAS `projectId` configured in `app.json` (currently absent, so this deployment has no real project to register against yet, same as Google/Microsoft OAuth's "not configured" precedent); registration silently no-ops rather than throwing under `expo start --web` or with no project configured. Verified live end-to-end via the mocked-boundary technique: monkey-patched `PushService.send` on the real running worker process — a genuine `"push"`-channel notification with a device token delivered via the mocked push call with zero email sends; a failed/expired-token case correctly fell back to real email delivery; a user with no device row at all skipped push entirely and went straight to email; and `IdentityService.registerPushToken` correctly persisted a token onto the calling session's actual device row. Also verified via a live Playwright session against `expo start --web` that the new `PushRegistration` component mounts and no-ops cleanly with zero console errors and zero push-token requests attempted, as expected with no EAS project configured. **Desktop channel still not implemented** (no desktop notification integration exists; `channel: "desktop"` still falls back to email, which is the correct degradation, not a gap being tracked separately). `notificationPreferences.categoryOverrides` is stored/defaulted and a doc comment in `notification-delivery.service.ts` claims per-category "off" is an enforced suppression rule, but `deliver()` never reads that field — harmless today only because no UI exposes a per-category toggle and `updatePreferences`'s patch type doesn't even accept it, so the field is currently inert rather than actively broken. Left as-is; fix the comment or wire the check together whenever a per-category preference UI is actually built. **Notification history UI now built**: `GET /v1/notifications` already existed on the backend with no UI anywhere — only the preferences form was reachable. Added `/settings/notifications` on web and `app/notifications/index.tsx` on mobile, both linked from Settings, showing every notification (sent/queued/suppressed, with the suppression reason and would've-sent time when suppressed) newest first. Verified live via a real Playwright session against the running web app in both states — a real seeded "sent" notification rendering correctly, and the genuine empty state after it — no console errors. Mobile screen reuses the same `Screen`/`Card`/`Badge`/`EmptyState` components already live-verified on other pushed screens this session; typechecked but not independently re-verified live via `expo start --web` for this specific screen. |
| Background workers | ✅ Separate worker process (`services/api/src/worker-main.ts`, BullMQ + Redis) runs connector sync and notification dispatch/delivery durably — survives a process restart, retries with backoff, dedupes by job ID. |
| Billing/entitlements | ✅ Stripe checkout + webhook + entitlement resolution, plus a real RevenueCat webhook handler (`revenuecat.service.ts`) normalizing App Store/Play Store/web entitlements into the same table — live-tested including a real bug found and fixed via a synthetic webhook call. **Billing UI now built** (previously the gap this row used to describe): `GET /v1/billing/plans` (deployment's actually-sellable plans, sourced from new `STRIPE_PRICE_PLUS_MONTHLY`/`STRIPE_PRICE_FAMILY_MONTHLY` env vars — a plan with no price configured is omitted rather than shown with a broken "Subscribe" button) and `POST /v1/billing/portal-session` (Stripe's self-service Customer Portal) are new; `/settings/billing` on web and `app/billing/index.tsx` on mobile show current plan/capabilities, sellable plans, a working "Subscribe" flow, and "Manage billing". Building this surfaced and fixed two real, previously-shipped bugs blocking it: (1) `createCheckoutSession`'s Stripe metadata was only set on the CheckoutSession object, not propagated via `subscription_data.metadata` to the Subscription object it creates — meaning every subsequent `customer.subscription.updated`/`.deleted` webhook (the actual downgrade/cancellation-detection path) could never resolve which user it belonged to, silently breaking that logic for any real Stripe account since the day it shipped; (2) no `stripeCustomerId` was tracked anywhere (`users.stripeCustomerId` added, migration `0007`), so the Customer Portal — which requires a Stripe customer id, not just a subscription id — was structurally impossible to build; now captured from `session.customer` in the `checkout.session.completed` webhook handler, the only place a user's first checkout is ever seen. Verified live: rebuilt `@veynlo/db`/`services/api`, restarted the real API process, confirmed `GET /v1/billing/plans` returns `[]` and `POST /v1/billing/portal-session`/`checkout-session` return clean `NO_BILLING_ACCOUNT`/`BILLING_NOT_CONFIGURED` 503s (this dev environment has no `STRIPE_SECRET_KEY`/price IDs, so this is the correct "not configured" degradation, matching every other optional external dependency), and confirmed via a real Playwright session against the live web app that `/settings/billing` renders the free-tier capability list correctly and the "Manage billing" click surfaces the `NO_BILLING_ACCOUNT` error inline rather than crashing. **Explicitly out of scope per direct product decision**: account deletion does not cancel the Stripe/RevenueCat subscription (left as-is), and no past-due/grace-period handling for failed payments exists or should be built. **Still not built**: the mobile IAP SDK/native paywall itself (deliberately deferred — see `SECURITY.md`/roadmap testing-distribution section, since it can't be meaningfully tested without paid Apple/Google developer accounts either way), and real quota enforcement — `packages/core/src/entitlements/plans.ts` defines 15 real `CapabilityKey`s with an explicit comment that "every gate in the product should check a capability key here," `resolveCapability` correctly computes them, but nothing outside `billing.service.ts` calls it: no connector-count check, no Ask throttle, no storage cap beyond a flat 25MB-per-file limit, no household-size check. Now that real billing UI exists, this is a live gap rather than a deferred one — tracked as a follow-up. **Annual pricing now built** — the spec wants monthly/annual, and `plans()` previously only ever knew about one Price per plan. Added `STRIPE_PRICE_PLUS_ANNUAL`/`STRIPE_PRICE_FAMILY_ANNUAL` env vars (independently optional — a deployment can sell monthly-only, annual-only, or both); `GET /v1/billing/plans` now returns one row per configured (plan, interval) combination, each carrying its own real Stripe Price id. Both `/settings/billing` (web) and `app/billing/index.tsx` (mobile) group the rows by plan into one card with a Monthly/Annual segmented toggle (state kept per-plan, not global, so choosing Annual on Plus doesn't affect Family's toggle) and send whichever priceId is currently selected to `POST /v1/billing/checkout-session` — the checkout/webhook path itself needed no changes, since it already took a raw priceId rather than assuming monthly. Verified live end-to-end: restarted the real API with temporary test Stripe Price ids for all four (plan, interval) combinations, confirmed `GET /v1/billing/plans` returns exactly those four grouped rows with correct capabilities; via real Playwright sessions on both web and mobile, confirmed both plan cards render independent Monthly/Annual toggles, clicking Annual on Plus and Subscribe sent `{"planKey":"plus","priceId":"price_test_plus_year"}` to checkout (the real annual id, not the monthly default), and the resulting `BILLING_NOT_CONFIGURED` 503 (this dev environment still has no real `STRIPE_SECRET_KEY`) surfaced its real server message inline rather than crashing — same graceful degradation as before. Restarted the API back to its unconfigured state afterward and confirmed `plans()` returns `[]` again, leaving no test configuration behind. |
| Admin console | ✅ Separate app (`apps/admin`, its own port/origin) with real per-operator RBAC: sign-in, user lookup, connector health, audit log — all live, all audited. Now includes self-service admin account management (create/list/revoke, `/dashboard/admins`), gated to `superadmin` only via a real `SuperAdminGuard` — the first place `support` vs `superadmin` actually differs. **Admin billing support tooling now built**: the `entitlements.source` enum has included `"support_granted"`/`"promotional"`/`"grandfathered"`/etc. since the entitlements system shipped, but nothing anywhere ever wrote one — a support agent had no way to comp a user a plan (bug they hit, partner deal, goodwill) without a raw DB edit. The user-lookup panel now shows every entitlement (plan/source/effective window/reason) with a "Grant plan" form (plan + required reason + optional expiry) and a per-row "Revoke" action, both fully audited (`admin.entitlement_grant`/`admin.entitlement_revoke`). Deliberately can only touch admin-manageable sources — revoking a real Stripe/App Store/Play Store entitlement is refused with a clear message, since that must only ever change via that processor's own webhook, never diverge from what the processor actually believes happened. Gated at the ordinary `AdminGuard` (support-level, like merchant merge), not superadmin — this is a routine, reversible support action. Verified live end-to-end: granted a real 30-day Plus comp via curl, confirmed it immediately changed the actual `GET /v1/billing/entitlements` a real consumer session sees (not just the admin's own view of it); confirmed revoke immediately reverted them to free and a second revoke attempt correctly 400'd as already-expired; confirmed a real `web_stripe`-sourced entitlement is correctly refused; confirmed the audit trail recorded both actions; confirmed via a real Playwright session against the live admin app that granting/viewing/revoking all work through the actual UI. Break-glass/elevated-access workflow is still not built. **Model health monitoring now built too**: `extraction_runs`/`extractor_versions` have existed in the schema since the pipeline shipped, but nothing ever wrote to them — there was no way to see whether the AI extraction pipeline was actually healthy (success rate, latency, error patterns) without grepping process logs. `AnthropicExtractionService.extractStructured` now instruments every ingestion-pipeline call (domain classification + all six domain extractors — the ones with a real `source_events` row to attribute a run to; `documents.service.ts`'s OCR calls and `search.service.ts`'s Ask synthesis call stay uninstrumented since a document/Ask query has no single source event, an honest scope boundary rather than forcing the FK nullable) — one `extractor_versions` row per (extractorName, model) pair, deduped via an in-memory cache rather than inserted fresh on every call, and one `extraction_runs` row per call tracking status/latency/error, correctly recorded even when the underlying Anthropic API call throws (the original exception still propagates unchanged — this only adds an observability side-effect on the way out, never swallows an error). The admin dashboard's new "Model health" section shows a 7-day per-extractor success-rate/latency table plus the most recent failures. Verified live: a real mocked-boundary test (faking only the Anthropic client's `.messages.create`, exercising every other line of real code) confirmed a genuine success run and a genuine schema-validation-failure run both landed correctly in `extraction_runs` with the right status/latency/error detail, that the `extractor_versions` row was correctly deduped to one row across both calls, and that `AdminService.modelHealthSummary()`'s aggregation (total/success/failed/successRate) was exactly correct; confirmed via a real Playwright session against the live admin app that the section renders, including its honest empty state when no runs exist yet. **Per-user diagnostics + DSAR/privacy-workflow tracking now built** — the user-lookup panel's connections table only ever showed the aggregate `health` enum, never the `connections.healthDetail` column that's existed in the schema all along; `modelHealthSummary` was aggregate-only with no way to see whether ingestion was actually failing for one specific user; and there was zero visibility into a user's own data-export history or account-deletion status from support tooling. `AdminService.findUserByEmail` now also returns each connection's `healthDetail`, the user's most recent `export_jobs` (state/error/timestamps — `DataExportService` already had this query shape for the consumer-facing version, this is the same query scoped the same way), and `users.deletedAt` alongside the existing `status`. Recent extraction failures needed a real join: `extraction_runs` has no `userId` column at all (only `sourceEventId`), so ownership resolves via `source_events.ownerUserId`, the same indirect-evidence-resolution pattern this session has used repeatedly for bills/warranties evidence. The dashboard gained two new tables (Recent extraction failures, Privacy requests) plus a Detail column on the connections table and a red-flagged non-active status line. Verified live end-to-end via the real compiled app (not raw SQL, which silently corrupts `encryptedText` columns if written as plaintext — hit and fixed this exact bug mid-verification): seeded a real failed extraction run, a degraded connection with `healthDetail`, and a failed export job through actual Drizzle inserts, confirmed `AdminService.findUserByEmail` correctly resolved and decrypted all three, and confirmed via a real Playwright session against the live admin app that all three render with the genuine decrypted text, then deleted all seeded rows and confirmed the lookup returns to its honest empty state. **Feature flags (remote kill switches) now built** — previously excluded from this session's MVP-completion pass for lack of any concrete flag to gate; the Android notification-listener message-capture feature (in progress) is the first real one. A single `feature_flags` table (key/enabled/description) backs a read-only `GET /v1/feature-flags` any signed-in client can poll, and an admin-only `GET/POST /v1/admin/feature-flags[/:key]` pair (support-level `AdminGuard`, same reversible-action tier as an entitlement grant — this needs to be flippable by whoever's on call, not gated behind superadmin) to flip one instantly for every user with no app release, fully audited (`admin.feature_flag_enable`/`_disable`). A key with no row is off by default — a kill switch must fail closed, never open, for a flag nobody's configured yet. Deliberately NOT a targeting/experimentation system (no percentage rollout, no per-user override) — scoped to exactly what a kill switch needs, nothing more. New "Feature flags" admin dashboard section lists every flag with an Enable/Disable button. Verified live end-to-end: created and toggled the real `android_notification_capture` flag via curl, confirmed the consumer-facing endpoint reflected the change instantly, confirmed the audit trail recorded both actions, confirmed via a real Playwright session against the live admin app that the section renders and the toggle button actually flips server state; left the flag disabled (its correct pre-launch default) after verification. |
| Web app (Home/Inbox/Ask/Life/Connections/Settings) | ✅ Built, responsive, light/dark theme, real API integration. **Fixed a real MVP gap**: the Life page was list-only — zero `[id]` detail routes existed anywhere for purchases/bills/warranties/returns/subscriptions, and the spec's Absolute Product Rule "Evidence before assertion" ("why am I seeing this?") had no surface at all. Both are now built: `GET /v1/{purchases,bills,warranties,returns,subscriptions}/:id` (new for all but purchases, which already had one) return the full record plus a resolved `evidence` object, and `apps/web/src/app/(app)/life/{purchases,bills,warranties,returns,subscriptions}/[id]/page.tsx` render it with a shared `EvidenceCard` component. Evidence resolution had to solve a real architecture gap along the way: `source_events` never persisted anything about the original email (no subject, no snippet — only a hash and an always-empty `raw_content_ref`), so there was nothing to actually show. Added `subjectLine`/`snippet`/`fromAddress` columns to `source_events` (deliberately not the full body — see the column's schema comment on why), populated at ingest time for email, manual-entry, and ICS-feed sources alike. Bills/warranties have no direct `sourceEventId` column, so their evidence is resolved indirectly via the `inbox_items` row that filed them (the same pattern the connection-data-deletion job already relies on); a return case's evidence is its parent purchase's, since a return case is created inside the same extraction as the purchase. Verified live end-to-end: used the same mocked-AI-boundary technique as earlier work to create a real purchase+bill+return with genuine source links, confirmed all three detail endpoints return correctly decrypted evidence (subject/snippet/sender/received date), confirmed a nonexistent ID returns `null` cleanly rather than crashing, and confirmed via a real Playwright session that the Life page's rows are now real links and the detail page renders correctly (including the honest "no evidence available" fallback for seed data, which has no source link). Mobile got full parity — five new pushed screens (`apps/mobile/app/{purchase,bill,warranty,return-case,subscription}/[id].tsx`) and a matching `EvidenceCard`, wired from the Life tab's rows. **Appointments/events domain now built too** — a final MVP completeness pass found this was the one §52.1 domain (of seven: appointments/events, purchases, returns, shipments, subscriptions/bills, warranties, documents) with genuinely zero list/detail UI on either platform, despite a working `GET /v1/events` backend nothing ever called. Added `GET /v1/events/:id` (+ evidence resolution via the same indirect `inbox_items` pattern bills/warranties use — calendar_events has no direct `sourceEventId` column either), an "Appointments" section on the Life page/tab (both platforms), and `life/events/[id]/page.tsx` (web) / `app/event/[id].tsx` (mobile) detail screens with `EvidenceCard`. **Timeline rows are now clickable on both platforms too** (previously dead-end display only, confirmed via the same audit) — each row links to its real domain detail page using the row's own `resourceType`/`resourceId` (document rows link to the documents list, since no per-document detail page exists yet). **Web Connections page had no stable navigation entry point** (only reachable via a conditional "degraded connection" banner on Home) — added a persistent link from the web Settings page's "Your data" section. Verified live end-to-end: real `GET /v1/events`/`GET /v1/events/:id` calls against a genuine seeded event, a real Playwright session confirming the Life page → event detail → Timeline click-through chain all resolve to the same real event on both web and mobile, and confirming the Settings → Connections link navigates correctly. Also, `bills`/`warranties`/`subscriptions`/`shipments` now store `confidenceBand` on the row itself (previously only `purchases` did — the other four extractors computed it and passed it to the Inbox item, but never onto the domain record itself, a cheap gap to close alongside the above). |
| Mobile (iOS/Android) | ✅ Full screen parity with web: Home, Inbox, Ask, Life, Settings (tabs) plus Timeline, Documents, Connections (pushed screens) — Expo + expo-router (`apps/mobile`), light/dark theme, real API via bearer-token auth. **Real native builds produced and verified on both platforms**: `expo run:ios` on a real iPhone 16 Pro Simulator (Xcode 26.2) and `expo run:android` on a real Android emulator (API 36) — see docs/ARCHITECTURE.md's "Native mobile build" section for the three real upstream bugs found and fixed (all apply to both platforms) to get there. Every screen and nav path (Life → Timeline/Documents, Settings → Connections) also verified live via Playwright driving `expo start --web`, including real empty-state rendering for a fresh account. **Not done**: real device builds (only simulator/emulator so far); no widgets; OAuth connect from mobile opens the system browser and finishes there rather than deep-linking back into the app. Theme preference now persists locally via `expo-secure-store` (`src/lib/theme-store.ts`) — verified live end-to-end through `expo start --web` (sign in, set Dark, reload the page, confirm it's still Dark) — but is not synced across devices via the account's `users.themePreference` column, which nothing on either platform writes to yet. **Camera/document capture + upload now built**: the Documents screen (`app/documents.tsx`) was previously view-only — its own empty-state copy literally told users to "Upload... from the web app" — with no camera, gallery, or file picker anywhere on mobile. Added `expo-image-picker` (camera + photo library) and `expo-document-picker` (PDF/file), a document-type chip row mirroring web's type selector, and a real `api.upload()` on the mobile client hitting the same `POST /v1/documents/upload` the web app uses. **Found and fixed a real bug live**: the first upload attempt reached the server as a genuine HTTP request but with no file part at all (`400 NO_FILE`) — React Native's `fetch`/`FormData` specially recognizes a `{ uri, name, type }` object appended in place of a file, but under `expo start --web` this is a real browser `FormData`, which silently stringifies a plain object instead of attaching a file part. Fixed by branching on `Platform.OS`: web fetches the picker's `blob:` URL into a real `Blob` first, native keeps the `{ uri, name, type }` form. Verified live end-to-end via a real Playwright session driving `expo start --web`: picked a real file through the actual native-file-chooser event, confirmed a genuine `201` with a real `documentId`, confirmed the document appeared in the list with the correct title/type and `processingState: "extracted"` — not just a UI mock. Camera/photo-library capture itself (`launchCameraAsync`/`launchImageLibraryAsync`) can't be driven by a headless browser or verified without real hardware, so only the picker-triggers-upload path (shared code for all three entry points) was live-verified this way; not independently re-verified on a real device build this pass. **iOS Share Extension (CAP-001) now built too** — `expo-share-extension` (a community config plugin; its own compatibility table only lists up through SDK 54, but confirmed hands-on to work correctly with this app's SDK 57 via a real prebuild + native build, not just trusted from stale docs). `src/share-extension.tsx` is a small, self-contained UI (no access to the main app's theme/auth context — it runs as a genuinely separate process) showing what was shared with a Save/Cancel; on Save it hands off to the main app via a `veynlo://capture?subject=...&body=...` deep link rather than making its own authenticated API call — the extension has no access to the main app's Keychain-stored session (no shared access-group wired up, and the package's built-in shared-auth hook is Firebase-specific), so the already-authenticated main app does the real submit through a new `app/capture.tsx` route reusing the same `POST /v1/ingestion/manual` every other text-capture path already uses. Scoped to text and URL shares only via `activationRules` (matching the manual/URL capture surfaces already built elsewhere, not images/files/video). **Found and fixed a real build bug getting there**: the plugin's generated `VeynloShareExtension` Xcode target hardcodes `IPHONEOS_DEPLOYMENT_TARGET = 15.1` with no config option to change it, which fails to compile once any Expo module requiring iOS 16.4+ is linked in (this app already had one, `ExpoDomWebView` via `@expo/ui`, since CocoaPods' autolinking shares one `ExpoModulesProvider.swift` across every target) — fixed with a small local config plugin (`plugins/withShareExtensionDeploymentTarget.js`) that patches the target's build settings after the fact; had to be listed *before* `expo-share-extension` in `app.json`'s plugin array, not after, since Expo's same-mod-type plugin composition runs newer entries first, the opposite of the intuitive reading. Verified live: a real `expo prebuild` + native `expo run:ios` build (Xcode 26.2, iPhone 16 Pro Simulator) succeeded for both the main app and the separate `VeynloShareExtension.appex`, installed and launched correctly (screenshotted), and `xcrun simctl openurl` confirmed iOS recognizes and offers to open the `veynlo://` scheme this deep-link handoff depends on. **Not verified this pass**: the actual share-sheet-to-extension-to-app tap-through interaction — no `idb`/equivalent tap-automation tool is available in this environment (installing one required a system Command Line Tools upgrade tied to a newer Xcode, too invasive to the already-working toolchain to do unilaterally), so this needs either a human tapping through it once on a simulator/device, or that tooling added deliberately in a separate pass. A Shortcuts action comes largely for free once the Share Extension exists (iOS surfaces any share-sheet target inside the Shortcuts app automatically) — not separately built or verified. **Android message capture now built too** (`modules/veynlo-notification-capture`, this app's first custom native Expo Module — a Kotlin `NotificationListenerService`) — deliberately NOT a default-SMS-app takeover; the service filters `onNotificationPosted` down to SMS/RCS messaging-app package names only (Google Messages, Samsung Messages, AOSP default), silently ignoring every other app's notifications (WhatsApp/Signal/Telegram included, matching the spec's own §32 messaging boundary for those channels), and only title/text/timestamp are ever queued — never the full notification object. Three real gates stand between "the code exists" and "anything actually gets read": the remote `android_notification_capture` feature flag (off by default, a true kill switch — see the feature-flags work above, built specifically to cover this), Android's own OS-level Notification Access grant (no runtime dialog exists for this; the user is sent to `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS` directly), and a dedicated `/message-capture` screen the user must explicitly opt into locally (SecureStore-backed, `src/lib/notification-capture.ts`) — reachable from Settings only when the feature flag is on, so this deployment's default state (flag off) hides the entry point entirely rather than advertising a capability that isn't live. A queued capture is drained on next app foreground into the same `POST /v1/ingestion/manual` every other manual-text capture path already uses — no new domain-specific pipeline. Deliberately scoped out of the *first* Play Store submission per product decision (ship the app, establish review history, add this in a follow-up release) — the flag defaulting to off already achieves that without needing a separate build variant. **Found and fixed two real bugs getting a native Android build green**: the module's own `AndroidManifest.xml` (needed to register the listener service) omitted the `xmlns:android` namespace declaration once `android:name`/`android:exported` attributes were added — the scaffolded template started with a bare `<manifest></manifest>` that never needed it — which failed Android's manifest merger outright; and two Kotlin `Function(...)` closures ending in a bare `return@Function` (no value) alongside a `Unit`-typed tail expression failed to type-check against the Expo Modules DSL's expected `Any?` return, fixed by restructuring both as a single `?.let { ... }` expression instead of an early-return guard clause. Verified live: a real `expo run:android` build (Android Studio's bundled JBR as `JAVA_HOME`, `Medium_Phone_API_36.0` emulator) succeeded end-to-end including this module's own Gradle subproject compiling and the manifest merging correctly, installed and launched to the real sign-in screen (screenshotted), with a clean `logcat` (no runtime exceptions from the new native module at boot). **Not verified this pass**: the actual opt-in → Notification Access grant → a real SMS notification → drain-to-Inbox flow, for the same reason as the iOS Share Extension above — no scripted-tap tooling was used this pass (unlike iOS, `adb input tap`/`text` is genuinely available here, but this session's own prior native-build work already flagged it as too fragile for reliable field-by-field interaction against a keyboard-shifted layout, and re-litigating that tradeoff wasn't attempted this pass); needs a human pass or dedicated UI-automation follow-up. |
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

15. ~~**ICS calendar-feed connector**~~ — done. A calendar-feed-by-URL
    subscription (a school/team/shared calendar's `.ics` link), structurally
    nothing like Gmail/Outlook/a future IMAP connector: no OAuth, no email
    protocol, no AI extraction pipeline — a VEVENT already *is* a calendar
    event. `IcsAdapter` (`services/api/src/modules/connectors/ics.adapter.ts`,
    `node-ical` for parsing) has no deployment-wide config to gate on
    (`isConfigured()` is always `true` — what varies is per-connection, the
    feed URL/credentials, not a platform API key); `POST
    /v1/connectors/ics/connect` probes the feed synchronously before
    creating any row, so a bad URL is immediate, actionable feedback rather
    than a silently-degraded connection. Credentials are optional HTTP
    Basic Auth (most feeds are fully public or embed a secret in the URL
    itself, e.g. Google Calendar's private ICS links) via the same
    `CredentialVault` every other connector uses. New
    `IngestionService.ingestIcsEvent` write path: content-hash-based
    idempotency (not the plain per-item dedup every other `ingest*Message`
    method uses) so a resync is a no-op for an unchanged event but
    correctly updates one whose time/title/location changed, looked up and
    updated in place by `(ownerUserId, providerEventId)` — never inserting
    a duplicate. Reuses the existing 15-minute connector-scan tick (added
    `"ics"` to the provider array) — no IDLE/push mechanism needed, ICS has
    no delta protocol anyway so every "incremental" sync is really a full
    refetch. Filed as an Inbox item per new/changed event
    (`suggestedActions: ["dismiss"]` only — there's nothing to "confirm,"
    it's a deterministic sync, not an inference) purely so the existing
    `connection-data-deletion` worker's inbox-items-traced cleanup path
    (built for bills/warranties/shipments, which also have no direct
    `sourceEventId` column) covers calendar-feed events too, with zero
    changes to that job. Web and mobile Connections pages both gained an
    "Add feed" inline form (URL, optional name, optional username/password
    toggle) mirroring the existing sign-in-form pattern rather than a
    redirect, since there's no OAuth hop. Verified live end-to-end against
    a real local test feed (not a third-party URL, to keep the test
    self-contained): connected a two-event feed via the real API, confirmed
    both a timed event and an all-day event landed with correct
    precision/location; re-synced with unchanged content and confirmed zero
    new rows (idempotency held); edited the feed's content and re-synced,
    confirming the *same* `calendar_events` row updated in place (not
    duplicated) with a fresh notification; then disconnected with
    `deleteDerivedData: true` and confirmed the pre-existing
    connection-data-deletion job correctly emptied every table for this
    new connector with no code changes of its own required. **IMAP
    deliberately not built alongside this** — see the Email connectors row
    above for why.

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

- **Fixed a real, session-wide bug**: none of the three frontends (web,
  mobile, admin) had a global 401 handler. A revoked/expired session (sign
  out everywhere from another device, a session naturally expiring, an
  invalid token) meant every subsequent fetch on that screen just failed
  silently forever — SWR-based web pages render blank (`data` stays
  `undefined`, matching neither the loading nor empty-state branch) and
  `useEffect`+`.then().finally()` pages (no `.catch`) render an empty state
  indistinguishable from a genuinely empty account. All three
  `api-client.ts` files now redirect to sign-in on any 401 *except* from
  the sign-in/sign-up endpoints themselves (those legitimately 401 on wrong
  credentials, which the sign-in page needs to show inline, not have this
  silently redirect away from — verified live on both web and mobile-web
  that a wrong-password attempt stays on the sign-in screen with the real
  inline error, while an invalid/expired session on any other screen
  correctly redirects). Also fixed a related mobile bug found in the same
  pass: five screens' pull-to-refresh handlers (`(tabs)/index.tsx`,
  `(tabs)/inbox.tsx`, `(tabs)/life.tsx`, `connections.tsx`,
  `documents.tsx`) called `setRefreshing(false)` without a `try/finally`,
  so any failed request (exactly the 401 case above, or a plain network
  error) left the pull-to-refresh spinner spinning forever with no way out
  short of force-quitting the screen. Not fixed in this pass, a broader
  and more design-heavy gap: most data-fetching screens still show no
  error message at all for a failed fetch (distinct from the 401 case
  above, which now at least redirects) — a transient 500 or network error
  on `/timeline`, `/inbox`, etc. still just renders an empty state with no
  "something went wrong, retry" affordance. Worth a dedicated pass once
  the app has real users generating real transient failures to design
  around, rather than speculatively wiring error UI into every screen now.
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
