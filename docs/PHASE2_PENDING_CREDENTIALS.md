# Phase 2 — Items Needing Real Credentials, Money, or Your Input

Everything listed here is **code-complete** (built, typechecked, linted, tested) and will activate
the moment a real value is supplied — no further engineering work is needed, just the credential/decision
itself. Nothing on this list blocks anything else in the app; every feature degrades to a clear
"not configured" state in the meantime (same pattern as Google/Microsoft connectors already had).

## Blocking most of the AI-powered features (highest priority)

- **`ANTHROPIC_API_KEY`** (`services/api/.env`) — currently **blank in this dev environment**. This
  is not Phase-2-specific: it gates almost every AI extraction in the whole app (bill/purchase/
  subscription/warranty/store-credit extraction, document OCR, Ask's answer synthesis, and the new
  Phase 2 automation rule parser). Without it, ingestion still files raw inbox items but never
  extracts structured data from them, and `/v1/automation/rules` (rule creation) returns
  `AI_NOT_CONFIGURED`. **Action needed:** put a real Anthropic API key in `services/api/.env`.

## Phase 2 connectors needing their own paid/OAuth accounts

- **Dropbox** (`DROPBOX_CLIENT_ID`/`DROPBOX_CLIENT_SECRET`) — needs its own Dropbox App Console
  registration (not reusable from the Google/Microsoft OAuth apps). Code path fully built
  (`services/api/src/modules/connectors/dropbox.adapter.ts`).
- **Provider-side token revocation on disconnect** (`ConnectorsService.revokeProviderToken`, called from
  `disconnect()` for every `gmail`/`google_calendar`/`google_drive`/`google_tasks`/`dropbox` connection) is
  code-complete and unit-tested with a stubbed `fetch` proving the right request shape/token reaches the
  right endpoint (`connectors.revoke-provider-token.test.ts`) — but, same as everything else in this
  section, can't be live-verified end to end against a REAL Google/Dropbox account in this dev environment
  (no real `GOOGLE_OAUTH_CLIENT_ID`/`DROPBOX_CLIENT_ID` configured, so there's no real access token to
  actually revoke upstream). It's best-effort/defense-in-depth by design regardless (see the method's own
  doc comment) — the local `connection_credentials` delete, which already IS live-verified, is the real
  security boundary either way. Microsoft-family connections (`outlook`/`microsoft_calendar`/`onedrive`/
  `microsoft_todo`) intentionally make no revoke call at all — Microsoft's v2 identity platform has no
  application-callable token-revocation endpoint (see `MICROSOFT_NO_REVOKE_PROVIDERS`'s doc comment in
  `connectors.service.ts`).
- **Plaid** (financial aggregator: `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV`) — needs a real, paid
  Plaid account (sandbox is free to start, production requires a signed agreement). Fully built:
  schema, adapter, transaction-matching against existing purchases/bills, web UI with real Plaid Link
  widget integration (`services/api/src/modules/connectors/plaid.adapter.ts`,
  `apps/web/src/app/(app)/connections/page.tsx`'s `PlaidConnectCard`), and now mobile too via the native
  Plaid Link SDK — see "Mobile Plaid Link" under "Built this pass, but needs a real device/prebuild to
  verify" below.

## §43 CONN-001 "Webhook/push + reconciliation" — receiver code complete; live registration blocked

A spec-conformance audit found the `webhook_subscriptions` table defined with zero readers/writers
anywhere — no webhook endpoint existed for any provider. The RECEIVER side is now fully built and real:

- **`POST /v1/webhooks/gmail`** (`services/api/src/modules/connectors/webhooks.controller.ts`) — verifies
  the Google-signed OIDC token a Pub/Sub push subscription puts in `Authorization: Bearer <token>` against
  Google's real public JWKS (`https://www.googleapis.com/oauth2/v3/certs`), checking `iss`/`aud` exactly as
  Google's own docs specify (`webhook-verification.ts`'s `verifyGmailPushToken`). On a verified push, decodes
  the mailbox's `emailAddress` out of the (never-content-bearing) payload, looks up the matching
  `webhook_subscriptions` row, and enqueues the SAME `incrementalSync` job the recurring poll already uses
  (`QueueProducerService.enqueueConnectorSync`, deduped by jobId) — not a parallel ingestion path.
- **`POST /v1/webhooks/microsoft`** — handles both the subscription create/renew validation handshake (a
  `validationToken` query param echoed back verbatim as `text/plain`, exactly as Graph's docs require) and
  real change-notification batches, checking each item's `clientState` against a SHA-256 hash of the secret
  this app generated for that subscription (`verifyMicrosoftClientState`) — Graph has no per-request
  cryptographic signature, so clientState IS the documented authenticity mechanism.
- **`POST /v1/webhooks/plaid`** — verifies the ES256 JWS in the `Plaid-Verification` header against a key
  fetched from Plaid's real `/webhook_verification_key/get` endpoint (`PlaidAdapter.getWebhookVerificationKey`),
  checks token freshness (`iat` within 5 minutes, Plaid's own documented replay window), and compares the
  token's `request_body_sha256` claim against a SHA-256 of the EXACT raw request body — needing the raw
  bytes is why `main.ts`'s existing Stripe-only raw-body `preParsing` hook now also covers this route.
- All three verification algorithms (`webhook-verification.ts`) are exercised in
  `webhooks.controller.test.ts` against locally generated keypairs — real signature checks, real
  issuer/audience/clientState/body-hash logic, zero network calls — including the "valid signature enqueues
  a sync, invalid signature is rejected with no DB/queue side effect" case for each provider.
- New `webhook_subscriptions.provider`/`externalId` columns (migration in
  `packages/db/src/migrations`) let a receiver map a push notification — which never carries Veynlo's own
  `connectionId` — back to a connection: Gmail's mailbox `emailAddress`, Graph's assigned `subscriptionId`,
  Plaid's `item_id`.

**What's still genuinely blocked (needs real infra, not more code):** actually REGISTERING a subscription
with any of these three providers — Gmail's `users.watch`, Graph's `POST /subscriptions`, Plaid's
Link-time webhook URL — all require a publicly reachable HTTPS callback URL this dev environment doesn't
have, and Gmail's push delivery additionally requires a real Google Cloud Pub/Sub topic (Gmail delivers push
notifications via Pub/Sub, not a directly-configured webhook URL — Pub/Sub is what actually calls this
endpoint). Until a deployment has both, `webhook_subscriptions` has no rows in production either, and every
connector keeps working exactly as it does today via the existing 15-minute polling tick
(`worker-main.ts`'s `connectorScanWorker`) — a webhook is a freshness *optimization* (CONN-001 "achieve
fresh integrations without trusting push delivery as perfect"), never the only path to sync, so nothing
regresses in the meantime. The one remaining engineering task once a public URL exists is wiring the
provider-side subscribe/renew calls to populate `webhook_subscriptions` rows (external id + secret hash) —
the verification and enqueue logic on the receiving end needs no further changes.

### §19 Financial Intelligence (FIN-001/003/004/005) — a spec-conformance audit this session found these
genuinely undocumented, unbuilt gaps against the Financial Intelligence chapter; all four are now real,
tested, and live-verified against this dev environment's real Postgres — the only thing genuinely still
blocked is live verification of FIN-005's Plaid-side parsing against a REAL Plaid account (same root cause
as the Plaid bullet above: no paid Plaid account in this dev environment).

- **FIN-001 "per-account include/exclude"** — done, no credential needed. `financial_accounts.isIncluded`
  (nullable-in-spirit boolean, defaults `true`), `PATCH /v1/finance/accounts/:id`, and
  `FinanceService.summary` (the one place balances are actually summed) all respect it; the raw account
  list (`FinanceService.accounts`) deliberately still returns every account so the UI can show an excluded
  one dimmed/labeled rather than hidden. Real-DB tests in `finance.service.test.ts`; live-verified via
  Playwright on `apps/web`'s Connections page — excluding an account updated the "Total across included
  accounts" line and kept the account visible, dimmed, with an "Include" button to undo it.
- **FIN-003 "recurring income/outflow detection"** — done, no credential needed.
  `FinanceService.detectIncomeStreams` (amount tolerance ±5%, cadence classified from gap
  consistency — weekly/biweekly/semimonthly/monthly, min 3 occurrences, deposits only — see that
  method's own doc comment for the full precision-first reasoning) backed by a new
  `detected_income_streams` table that persists a per-stream `dismissedAt` so a "not income" correction
  survives re-detection. Surfaced read-only on the Connections page (web + mobile) as "Recurring income
  detected: ~$X every N from [description]" with a "Not income" dismiss action. Real-DB tests
  (`finance.income-detection.test.ts`) cover a true-positive biweekly paycheck AND three false-positive-
  avoidance cases (outflow, too few occurrences, irregular cadence); live-verified via Playwright.
- **FIN-004 "duplicate/unusual charge assistance"** — done, no credential needed.
  `FinanceService.detectAnomalousTransactions` runs on the existing hourly attention-scan tick
  (`worker-main.ts`, alongside `AttentionService.scanAndFileDeadlines`) and files two kinds of attention
  item via the same `AttentionService.fileIfNew` dedup path every other scan in that class uses: an
  exact-same-amount charge from the same merchant/account within ~2 days (`financial_duplicate_charge`),
  and a charge >25% above that merchant's own historical average — reusing
  `CommerceService.computeBillBaseline`'s exact threshold/sample-size discipline
  (`financial_unusual_charge`). Both carry `["looks_right", "dispute_with_bank"]` actions; "looks_right"
  is the item's normal resolve action, "dispute_with_bank" only ever expands a client-side guidance panel
  (web `apps/web/src/app/(app)/home/page.tsx`, mobile `apps/mobile/app/(tabs)/index.tsx`) — never an
  automated dispute, since no bank API for that exists or should be attempted. Real-DB tests
  (`finance.anomaly-detection.test.ts`) cover both true positives and the false-positive-avoidance cases
  (near-miss amount, outside the time window, modest baseline increase, too little history); live-verified
  end to end (real worker tick -> real attention_items row -> real Home page render -> "Get dispute
  guidance" expands inline with no navigation and no network call).
- **FIN-005 "liability tracking (minimum payment/due date)"** — data model, parsing, and UI are done; only
  the live Plaid call is blocked. New `liabilities` table (accountId FK, minimum payment, due date, APR in
  basis points, last statement balance) populated by `PlaidAdapter.syncLiabilities`, called on every sync
  alongside `syncAccounts` and wrapped in its own try/catch (a plain checking-only item legitimately has no
  liability data at all — that's a normal outcome, not a sync failure). `createLinkToken` now requests the
  `liabilities` product alongside `transactions` so a real connection actually gets consent for it.
  `FinanceService.accounts` left-joins each account's liability row so the account list UI can show
  "Minimum payment $X · due <date> · Y% APR" per credit-liability account with zero extra round trips, and
  renders nothing (not an error) when a liability row doesn't exist. Parsing is tested in
  `plaid.adapter.test.ts` against a response shaped exactly like Plaid's own documented
  `CreditCardLiability` schema (`account_id`, `aprs[]` — correctly picks the `purchase_apr` entry rather
  than just the first one, `minimum_payment_amount`, `next_payment_due_date`, `last_statement_balance`),
  including a re-sync-updates-in-place case. **What's still genuinely blocked:** this dev environment has
  no real Plaid account, so `/liabilities/get` has never been called against a live sandbox/production
  Item — the mocked-response test is real coverage of the parsing/storage code, but isn't proof Plaid's
  actual API returns exactly that shape today. Live-verified as far as possible without one: seeded a real
  `liabilities` row directly via the app's own encrypted-column write path and confirmed the account-list
  API/UI renders it correctly.
- **Google Drive / Google Tasks** — reuse the existing `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`
  (currently blank in this dev `.env` — Gmail/Google Calendar are equally unconfigured right now).
  Nothing extra needed once a real Google Cloud OAuth app with the right scopes exists.
- **OneDrive / Microsoft To Do** — reuse the existing `MICROSOFT_OAUTH_CLIENT_ID`/`MICROSOFT_OAUTH_CLIENT_SECRET`,
  which **are** already configured in this dev environment — these two should already work live once a
  real user connects them (verified: `/v1/connectors/onedrive/authorize` and
  `/v1/connectors/microsoft-todo/authorize` both return a real, working Microsoft OAuth URL today).
- **CAL-001 write-back — needs real `GOOGLE_OAUTH_CLIENT_ID`/`MICROSOFT_OAUTH_CLIENT_ID` (etc.) to
  live-verify the actual "push an event to the real provider" round trip.** The write-back code path itself
  is code-complete and real-DB tested (see "Fixed this pass" below), but this dev environment's Google
  OAuth app is unconfigured and the Microsoft one, while configured for read, has never had its consent
  screen click-through re-verified with the wider write scope — so the one thing that genuinely can't be
  proven here is a real Google/Microsoft user clicking through the write-scope consent screen and Veynlo
  successfully calling `events.insert`/`POST /me/events` against a live account. Live-verified as far as
  possible without that: hit the real (unconfigured) Google adapter's `createEvent` through the actual
  `POST /v1/calendar-events/:id/push` endpoint end to end via Playwright — it correctly fails closed
  (`writeBackStatus` flips to `"failed"`, the local event is left completely untouched, the UI shows "The
  last sync attempt didn't go through — this event is still saved in Veynlo") rather than throwing or
  silently succeeding.

## ONB-001/ONB-002 — Value-first onboarding

Not a Phase-2-chapter item (Core tier, §6/onboarding chapter) but recorded here since real credentials
intersect directly with how much of the flow could be live-verified in this dev environment. Previously
**zero code existed anywhere** for this flow — a new sign-up landed directly on an empty Home page. Now
fully built and code-complete:

- **New `onboarding_state` table** (`packages/db/src/schema/onboarding.ts`, migration `0049_...sql`) —
  one row per user, created at account-creation time (`IdentityService.signUp` /
  `findOrCreateOAuthUser`, both call `OnboardingService.initializeForNewUser`), tracking
  `currentStep`/`goal`/`recommendedConnector`/`historyDepthChoice`/`scanConnectionId`/
  `householdInviteOfferedAt`/`completedAt` — a dedicated table rather than a single
  `users.onboardingCompletedAt` timestamp, since the flow has multiple resumable stages a boolean can't
  represent. A pre-existing account (created before this feature shipped) has no row at all and is
  reported as `needsOnboarding: false` — never retroactively dropped into a first-run flow.
- **Goal selection → connector recommendation** (`services/api/src/modules/onboarding/onboarding.service.ts`)
  — a plain lookup table (not a model call — the spec doesn't ask for AI here) mapping the spec's six named
  goals to one recommended action each: important dates/purchases & returns/travel → Gmail; bills &
  subscriptions → Plaid (falls back to Gmail when Plaid isn't configured — **live-verified in this dev
  environment**, since `PLAID_CLIENT_ID`/`PLAID_SECRET` are blank here); family → create a household;
  things I own → add a vehicle/property manually.
- **Pre-permission screen** (ONB-001 "must explain exact reason and category, not unrelated scopes") — new,
  didn't exist anywhere in the prior connector-connect flow. `GET /v1/onboarding/consent-preview` returns
  real copy sourced from the same scope constants the adapters actually request
  (`gmail.readonly`/`offline_access, Mail.Read`/Plaid `transactions`), plus an explicit "we will NOT
  request" list (sending/deleting mail, contacts, Drive/Calendar, payments, credentials). Rendered on both
  web (`apps/web/src/app/(app)/onboarding/page.tsx`) and mobile (`apps/mobile/app/onboarding.tsx`).
- **Historical depth control** (ONB-002) — real enforcement, not UI-only: `EntitlementsService
  .resolveHistoricalBackfillDays(userId, requestedDays?)` clamps a user's chosen depth to their plan's real
  cap, threaded through Gmail/Outlook's OAuth `state` (signed, same mechanism as the existing CAL-001
  write-back fields) and Plaid's exchange request body — `GmailAdapter`/`OutlookAdapter`/`PlaidAdapter`'s
  `handleCallback`/`exchangePublicToken` all accept the new `requestedHistoryDepthDays` param.
  `PLAN_CATALOG.free.historical_backfill_days` raised from 30 → 90 to match ONB-002's own named Free-tier
  ceiling ("Forward only, 30 days, or 90 days"); Free is limited to those three choices, Plus+ unlocks
  6 months/1 year/"build my history" — gated server-side (`OnboardingService.setHistoryDepth` throws if a
  Free user requests a locked depth), not just hidden client-side. Real-Postgres regression coverage in
  `services/api/src/modules/onboarding/onboarding.service.test.ts`.
- **Bounded scan + discovery review** — reuses the existing connector adapters' `initialSync` (already
  durable/queued via `worker-main.ts`) rather than a parallel scan mechanism; progress is read live off
  `connections.health`/a count of real `inbox_items` created since the scan started (no separate
  progress-tracking table). The discovery-review screen reuses the existing `GET /v1/inbox` +
  `/v1/inbox/:id/confirm`/`/dismiss` endpoints — a brand-new onboarding user's Inbox has nothing else in
  it yet, so this naturally IS the scan-scoped view without a new filtered endpoint.
- **Skip-at-any-step, never trapped** — every step offers "Skip for now"; `(app)/layout.tsx` on web and
  `(tabs)/_layout.tsx` on mobile redirect to `/onboarding` only while `needsOnboarding` is true, resuming at
  the saved `currentStep` (real-DB-tested: a fresh `OnboardingService` instance against a new db connection
  reads back the exact step/goal a prior instance left, simulating a server restart or a different
  request). **Real bug found and fixed via live Playwright verification this pass**: skipping used to bounce
  the user straight back to `/onboarding` instead of reaching Home — `apps/web`'s shared `(app)` layout
  keeps one persistent SWR cache entry for `/v1/onboarding/state` across the client-side navigation from
  `/onboarding` to `/home` (Next.js doesn't remount a shared route-group layout on a sibling navigation),
  and the skip action wasn't invalidating that cache before navigating away, so the layout's redirect effect
  read stale `needsOnboarding: true` data and bounced right back — exactly the "trap" ONB-001 rules out.
  Fixed by awaiting an explicit `mutate()` before navigating (`apps/web/src/app/(app)/onboarding/page.tsx`'s
  `skip()`). A second, related gap found in the same pass: the very first step (goal selection) rendered
  with no skip option at all on either platform — fixed by wiring the same skip handler through to it.

**What could and couldn't be live-verified in this dev environment** (`GOOGLE_OAUTH_CLIENT_ID` blank,
`MICROSOFT_OAUTH_CLIENT_ID` real, `PLAID_CLIENT_ID` blank, `ANTHROPIC_API_KEY` blank):

- Live-verified end to end via Playwright on web (1280×900 and 390×844) and the mobile Expo web preview
  (390×844): sign-up → goal selection (all 6 goals) → pre-permission consent screens (Gmail scope copy,
  Plaid→Gmail fallback copy) → historical-depth screen with Free-tier options correctly locked behind a
  "Plus+" badge → clicking "Connect Gmail" surfaces the graceful `CONNECTOR_NOT_CONFIGURED` message (Google
  OAuth is unconfigured here, same degradation as the existing Connections page) rather than crashing →
  skip-at-any-step reaching a normal Home → resumability across a hard page refresh mid-flow → the family
  goal's household-creation screen instead of a connector consent screen.
- **Not verifiable here**: an actual completed Gmail/Plaid OAuth grant and the resulting bounded scan
  producing real discoveries, since neither is configured in this environment. Outlook's OAuth app IS
  configured with real credentials, but completing a live third-party Microsoft login isn't something this
  pass could script without real test-account credentials. The zero-discovery path this would otherwise
  exercise (`ANTHROPIC_API_KEY` unset → `IngestionService.classifyAndExtract` files nothing without a
  known-sender match) is instead covered by a real-Postgres integration test
  (`onboarding.service.test.ts`'s "graceful zero-discovery completion" case: a real `connections` row
  flipped to `health: "healthy"` with zero `inbox_items` correctly reports `{status: "complete",
  discoveredCount: 0}`), and the discovery-review screen's empty state explicitly says so when
  `aiConfigured` is false rather than showing a generic "nothing here."

## PEO-001..005 (§14 "Contacts, People & Relationships") — status

Not a Phase-2-chapter item (§14 is its own, earlier-numbered spec chapter, Core-tier — not gated behind a
paid plan), but recorded here per this pass's own instruction since real credentials/decisions intersect
it. Built end-to-end this pass: schema (`packages/db/src/schema/people.ts` — `people`, `organizations`,
`contactSources`, `aliases`, `personRelationships`, `personNotes`, `personImportantDates`,
`personMergeLineage`), `PeopleService`/`PeopleController` (`services/api/src/modules/people/`), reversible
merge/unmerge (PEO-002, mirrors `AdminService.mergeMerchants`'s snapshot+repoint+lineage shape), a minimal
opt-in relationship-label suggestion (PEO-003 — only from a user-supplied organization type, always lands
as `relationshipLabelSource: "suggested"`, never auto-applied), PEO-004's generic `relatedEntityIds` linking
into bills/documents/maintenanceRecords/calendarEvents/tasks/warranties/vehicles/properties, and PEO-005
important-date reminders wired into `AttentionService.scanAndFileDeadlines` (mirrors
`ResurfacingService.evaluateBirthdayRule`'s yearly-recurrence math). Private-by-default access control
(mirrors `HealthLogisticsService`'s own doc comment: plain household membership never grants visibility —
only an explicit `visibility: "household"` the owner opts into, plus a new `"people:read"` caregiver-
delegation scope, plus direct SHARE-001 resource grants). Real-Postgres regression tests: merge/unmerge
reversibility, relationship-label editing, important-date reminder firing (including the "must fire again
next year, not just once" recurrence case), household-visibility vs. private-by-default, and adversarial
cross-household/outsider access denial — all passing (`people.service.test.ts`, `people.merge.test.ts`,
`attention.person-important-date.test.ts`). Live-verified against the real dev API/Postgres via curl:
create/list/detail/aliases/contactSources/important-dates and merge-candidate detection all round-trip
correctly.

Full web UI built and Playwright-verified end to end against the real dev app (localhost:3000/4000): a
"People" section on `/life` (`apps/web/src/app/(app)/life/page.tsx`) with an inline add-person form
(relationship-label quick-pick chips matching `PERSON_RELATIONSHIP_SUGGESTIONS` exactly), a full person
detail page (`/life/people/[id]`) with relationship-label editing/confirm-suggestion, visibility toggle,
aliases, notes, important dates, relationships, linked history, and the shared `ShareResourcePanel`, and a
duplicate-review page (`/life/people/merge`) with a survivor-picker and merge history/undo. Live-verified
end to end via a real headless-Chromium Playwright script: signed up a fresh account, added a person through
the actual UI form (`POST /v1/people` → 201), opened its detail page (relationship label, notes, important
dates, sharing all rendered), added a second person sharing the same email, confirmed the merge-review page
correctly surfaced a "Matching email address" candidate group with a working "Merge into selected" button,
and confirmed the Connections page lists both "Google Contacts" and "Microsoft Contacts" with the same card
styling as every other connector — zero browser console errors at any step. Mobile UI (Expo/React Native)
built to the same scope: a People section on the Life tab, `apps/mobile/app/person/[id].tsx` detail screen,
`apps/mobile/app/person/merge.tsx` duplicate review, and Google/Microsoft Contacts cards on the Connections
screen — typechecked clean; see the device-import bullet below for the one piece of this that needs a real
device/prebuild to verify visually.

- **Google Contacts / Microsoft Contacts sync (PEO-001)** — code-complete
  (`services/api/src/modules/connectors/google-contacts.adapter.ts`/`microsoft-contacts.adapter.ts`),
  wired into `ConnectorsModule`/`ConnectorsController` with real `/v1/connectors/google-contacts/authorize`
  and `/v1/connectors/microsoft-contacts/authorize` routes confirmed live-mapped on server boot. Reuses the
  SAME `GOOGLE_OAUTH_CLIENT_ID`/`MICROSOFT_OAUTH_CLIENT_ID` Gmail/Calendar already use (an extra consent
  scope — `contacts.readonly`/`Contacts.Read` — not a new OAuth app), exactly like this codebase's own
  Google Calendar/Microsoft Calendar connectors. Same blocked-on-credentials state as every other
  Google-family connector in this file: `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` is blank in this dev environment,
  so Google Contacts can't be live-verified against a real Google account here (same caveat as Gmail/Google
  Calendar/Drive/Tasks above). Microsoft Contacts, like OneDrive/Microsoft To Do, reuses the
  `MICROSOFT_OAUTH_CLIENT_ID`/`SECRET` that **are** already configured in this dev environment, so it
  should already work live once a real user clicks through Microsoft's consent screen with the added
  `Contacts.Read` scope — genuinely unverified only insofar as no real Microsoft account has clicked through
  it in this session. Deliberately does NOT gate either connector behind `EntitlementsService
  .assertConnectorQuota` — Contacts is Core-tier, not part of the email/calendar/storage/financial
  categories that function gates.
- **Apple Contacts / local device address book (PEO-001)** — Apple has no server-side Contacts API (same
  class of gap as Apple Reminders/Apple Calendar being correctly unbuilt server-side per this file's own
  TASK-002-equivalent entries elsewhere in this document) — a real device-contacts import can only ever be
  a native on-device picker, not a backend connector. See the "Built this pass, but needs a real
  device/prebuild to verify" section below for exactly what was built for this and what genuinely needs a
  real device/prebuild to verify.

## PERS-001..005 (§"Personalization & Adaptation") and DEC-001 (§"Rules/decision engine") — status

Also not Phase-2-chapter items (both Core-tier), recorded here per this pass's own instruction. Audited what
already existed first, then built the genuinely missing pieces.

- **PERS-001 Appearance (light/dark/system)** — already solid, confirmed still working, not rebuilt.
  `users.themePreference` column + `AppThemeProvider`/`ThemeProvider` on both web and mobile; each platform
  persists locally (localStorage / expo-secure-store) rather than syncing the account-level column — a
  pre-existing, narrower gap ("sync across devices") that's a separate, larger follow-up than this pass's
  scope and was left alone rather than half-fixed.
- **PERS-002 Home customization** — was completely missing (Home's module list was hardcoded); built this
  pass. New `homeModulePreferences` table (`packages/db/src/schema/preferences.ts`) storing per-user
  `moduleOrder`/`hiddenModules` for the three OPTIONAL modules below Needs You (Today, Money at risk &
  savings, Household — Today). "Needs You" is not a storable key at all — rejected by the DTO's own enum
  and filtered again server-side, so it can never be hidden/reordered by any request.
  `PreferencesController`/`PreferencesService` (`services/api/src/modules/preferences/`) expose
  `GET`/`PUT /v1/home-module-preferences`; both web (`apps/web/src/app/(app)/home/page.tsx`) and mobile
  (`apps/mobile/app/(tabs)/index.tsx`) Home screens now render the three modules in whatever order/visibility
  is stored, defaulting to their original fixed order for a user with no saved preference. Settings UI: a new
  "Home layout" section (up/down + show/hide) on `apps/web/src/app/(app)/settings/personalization/page.tsx`
  and `apps/mobile/app/personalization.tsx`.
- **PERS-003 Category preferences** — was completely missing (no user-level opt-out existed independent of
  plan entitlement); built this pass. New `categoryPreferences` table + `CategoryDomainKeySchema`
  (`packages/core/src/entitlements/category-preferences.ts`: purchases/finance/travel/family/home/health/pets,
  each mapped to the exact `IngestionService.classifyAndExtract` domain-classifier labels it gates, plus a
  specific "explains retained existing data" copy string per category). Wired into
  `IngestionService.classifyAndExtract` ALONGSIDE (never instead of) the existing plan-entitlement checks —
  same "no row = most permissive default" posture `EntitlementsService.getCapability` already has. "home"
  (warranty tracking) had no entitlement gate at all before this, so the category preference is its only
  gate. Settings UI: per-category toggle list with live disable-explanation copy, same two pages as PERS-002
  above. Real regression tests against real Postgres
  (`services/api/src/modules/ingestion/ingestion.category-preferences.test.ts`): disabling "purchases" stops
  NEW receipt/store-credit extraction (extractor never even called) while a pre-existing purchase row is left
  completely untouched; re-enabling resumes extraction without disturbing what was created while disabled;
  an unrelated category's default-enabled state is unaffected.
- **PERS-004 Naming and language** — partially existed, rest built this pass. Object nicknames were ALREADY
  fully satisfied (`vehicleProfiles.label`/`propertyProfiles.label`/`petProfiles.label`/`homeAssets.label` —
  each asset table's own editable display label). Locale/timezone already existed on `users` (unused by any
  settings UI, left as-is). Genuinely missing: a preferred display name distinct from the account's real
  `displayName`, plus week-start and time-format preferences — none existed anywhere. New
  `personalizationPreferences` table + settings UI (same two pages). `apps/web/src/lib/format.ts` and
  `apps/mobile/src/lib/format.ts`'s `formatTemporal` now accept an optional `timeFormat` param (backward
  compatible — omitted, it's the original browser/OS-locale behavior); wired into the Home page's date/time
  rendering as the flagship surface. Full app-wide wiring of time-format/week-start into every other date
  call site (there are many) is intentionally NOT done in this pass — scoped to the primary Home surface
  plus the underlying shared helper, not a mechanical find-replace across the whole app.
- **PERS-005 AI tone/verbosity** — was completely missing; built this pass. `askResponseStyle`
  (concise/balanced/detailed) and `suggestionIntensity` (quiet/balanced/proactive) on
  `personalizationPreferences`. `SearchService.ask` now appends a STYLE-ONLY addendum
  (`SearchService.ASK_CORE_SYSTEM_PROMPT + this.askStyleAddendum(...)`) after the entire hardcoded
  injection-defense/evidence-grounding system prompt — never interleaved with it, never replacing any clause
  of it. Real regression test
  (`services/api/src/modules/search/search.ask-response-style.test.ts`) asserts the exact
  `ASK_CORE_SYSTEM_PROMPT` string (injection-defense framing, "answer only from evidence," insufficientEvidence
  instruction) is present byte-for-byte in the model-bound prompt for all three style settings, and that only
  the addendum after it differs.
- **DEC-001 "View why"** — the underlying data (`attentionItems.reasonCode`/`reasonText`) already existed and
  was already specific per-instance text (`AttentionService.scanAndFileDeadlines`'s own reasonText strings),
  but there was no dedicated UI action for it — the reason line was just always-visible summary text, not a
  distinct "view why" affordance, and there was no rule-LEVEL (as opposed to instance-level) explanation
  anywhere. Built this pass: `packages/core/src/entities/attention-reasons.ts` maps every one of the 17
  `reasonCode`s this codebase actually files to a genuinely specific rule-level explanation (spot-checked;
  none are generic "this is important" filler), with an honest fallback for an unrecognized future code. New
  "Why am I seeing this?" button on each Home attention-item card (web and mobile) expands to show the
  reasonText reframed in the spec's own example phrasing ("We reminded you because...") plus the rule-level
  explanation. Live-verified against the real dev API/Postgres via Playwright: seeded a real
  `return_window_closing` attention item, confirmed the button renders, expands to the correct framed text
  plus "Return window closing" / the matching rule explanation, and collapses again via "Hide why."

Live-verified end-to-end via Playwright against the real dev web app (localhost:3000) and API/Postgres
(localhost:4000 / :5433): sign-up → Home-module visibility toggle (persisted across reload, and genuinely
removes a module with real backing data from the render, not just visually) → module reorder via up/down →
category-preference toggle (with disable-explanation copy appearing) → week-start/time-format/Ask-style
selection (all persisted across reload) → "View why" on a real seeded attention item. Mobile screens
(`apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/personalization.tsx`) are code-complete and typecheck
clean but weren't live-verified on-device (no simulator/prebuild in this environment — same caveat as this
file's other mobile-only entries).

## Resolved product decisions (this pass)

- **`packages/authz` — deleted.** You said "do whichever is better." It was dead, unused code
  (`resolveAccess`/`requireAccess`/`resolveShareLinkAccess`, zero imports anywhere), duplicated what
  object sharing already does better (argon2 passcode hashing vs. its weaker `!==` comparison, real
  FAM-006 delegation support vs. its unsupported household model). Removed entirely rather than kept
  around unused and misleading.
- **Automation external-writes scope — kept Veynlo-internal, per your explicit answer.** Added a new
  `add_calendar_event` automation action kind (`services/api/src/modules/automation/rule-schemas.ts`)
  that creates a local `calendar_events` row only — no connector writes, no new OAuth scopes, no
  re-consent. It schedules the event N days (0-90, AI-controlled, clamped) after the rule fires, since
  the trigger event payload carries no due-date of its own to anchor to more precisely. Real DB test:
  `automation.service.test.ts`'s "approving an add_calendar_event action..." case.

## UTIL-001 (utility tracking baseline) and AUTH-001 (passkey sign-in) — status (this pass)

Neither of these needed a paid account or API key — both are recorded here per instruction, and because
AUTH-001's mobile half genuinely does have one real "needs your input" item (a production domain — see
below).

- **UTIL-001 "Shows current bill vs prior/seasonal baseline"** — **no credential needed, fully built and
  live-verified.** `bills.billerCategory` (a small keyword heuristic over the biller name — see
  `services/api/src/modules/commerce/biller-category.ts`'s own doc comment for why an unrecognized name
  stays uncategorized rather than guessed) and `CommerceService.computeBillBaseline` (average of a biller's
  own last up to 12 prior bills; a documented >25% threshold flags "significantly above baseline") are new;
  `billDetail`'s response now embeds `baselineComparison` and both apps' bill-detail pages render it as a
  banner. Also built: explicit-only "equipment return obligations" capture
  (`bills.equipmentReturnDeadline`/`.equipmentReturnInstructions`, populated only when a bill/cancellation
  email literally states a hardware-return deadline — never inferred) and its own
  `AttentionService.scanAndFileDeadlines` reminder (`equipment_return_due`, filed under linkedResourceType
  `bill_equipment_return` rather than `bill` — see that scan block's own comment for why reusing `bill`
  would have silently collided with `bill_due`/`bill_overdue`'s dedup key for the same row). "Outages/
  notices from source messages" was left out: nothing in this codebase's source connectors (Gmail/Outlook)
  distinguishes a real outage notice from ordinary bill correspondence, and inventing a heuristic for it
  risked false positives with no source-fact basis — a genuinely new extractor for that specific case, not
  attempted this pass. Real Postgres regression tests: `commerce.bill-baseline.test.ts`,
  `attention.equipment-return.test.ts`, `ingestion.bill-equipment-return.test.ts`. Live-verified via
  Playwright against the real dev API/web app: seeded a real biller's bill history through the real
  extraction-adjacent schema, signed in through the real UI, and confirmed the exact banner text ("This
  bill is $60.00 higher than your typical Electric bill... Based on your last 3 bills from City Electric
  Co, averaging $100.00") rendered on the real `/life/bills/:id` page — screenshot taken, not just an API
  assertion.
- **AUTH-001 "passkey" (web)** — **no credential needed, fully built and live-verified end to end,
  including the actual cryptographic ceremony.** Added `@simplewebauthn/server` (API) and
  `@simplewebauthn/browser` (web) as real dependencies — a genuinely free, no-API-key W3C standard, exactly
  as the brief anticipated. New `PasskeyService`/`PasskeyController`
  (`services/api/src/modules/identity/passkey.{service,controller}.ts`) implement the real registration
  (`generateRegistrationOptions`/`verifyRegistrationResponse`) and authentication
  (`generateAuthenticationOptions`/`verifyAuthenticationResponse`) ceremonies, extending the schema's
  pre-existing-but-unused `passkeys` table (added `transports`/`deviceType`/`backedUp`/`label`/
  `lastUsedAt`) rather than a redundant new table. A verified passkey assertion issues a session via
  `IdentityService.issueSessionForExternalAuth` — the exact same `sessions` row/cookie/JWT mechanism email
  and OAuth sign-in already use, not a parallel auth system. Web UI: "Sign in with a passkey" on the
  sign-in page (a genuine usernameless/discoverable-credential flow — no email typed first) and "Add a
  passkey"/manage-list on `/settings/security`.
  - **Live end-to-end verification, not just documented as unverifiable:** Chromium DOES support a real
    virtual authenticator via Chrome DevTools Protocol's `WebAuthn` domain, and it was used — a Playwright
    script (`WebAuthn.enable` + `addVirtualAuthenticator({protocol:"ctap2", hasResidentKey:true,
    hasUserVerification:true, ...})`) drove a **real browser** through the **real UI**: signed up a real
    account, clicked the real "Add a passkey" button (a real `navigator.credentials.create()` ceremony
    against the virtual authenticator, verified server-side by the real `verifyRegistrationResponse` crypto
    path), confirmed the credential appeared in the real "Manage your passkeys" list, signed all the way
    out, then clicked the real "Sign in with a passkey" button (a real `navigator.credentials.get()`
    ceremony, verified server-side by the real `verifyAuthenticationResponse` crypto path) and landed back
    on `/home` with a real new session. Every step of this round trip is real; nothing was mocked in this
    run. Vitest regression suite (`passkey.service.test.ts`, real Postgres) mocks only
    `verifyRegistrationResponse`/`verifyAuthenticationResponse` themselves (the one step that needs a
    physical/virtual authenticator a plain Node test process can't provide) to cover PasskeyService's own
    logic — challenge-to-user binding, credential/identity_links persistence, counter/lastUsedAt updates,
    unknown-credential rejection, suspended-account rejection, and ownership checks on list/remove.
  - **A real, unrelated bug found and fixed along the way:** `packages/core/src/index.ts`'s main barrel
    re-exported `util/token.ts`, which does a bare `import ... from "node:crypto"` — a real Node built-in
    with no browser equivalent. Since `apps/web`'s client components already import other things from that
    same barrel (e.g. `home/page.tsx`'s `getAttentionReasonExplanation`), EVERY page that imports anything
    from `@veynlo/core` transitively pulled in `node:crypto`, and webpack's client bundler refuses to build
    that at all (`UnhandledSchemeError`) — this broke literally every page in the web app (`/sign-in`,
    `/home`, `/settings/security`, `/life`, ...) the moment a stale `.next` cache was cleared, not just the
    pages touched this pass. Fixed by moving `generateOpaqueToken`/`hashOpaqueToken`'s three real callers
    (`IdentityService`, `HouseholdService`, `AdminService` — all server-only) to import from
    `@veynlo/core/dist/util/token` directly instead of the main barrel (added that subpath to
    `packages/core/package.json`'s `exports`), and removed `util/token` from the barrel's own `export *`
    list. Confirmed fixed: every page in `apps/web` returns 200 again, verified live via curl and the
    Playwright run above.
- **AUTH-001 "passkey" (mobile)** — see the dedicated bullet below (needs a real device AND a real
  production domain to verify, unlike web).

## Built this pass, but **needs a real device/prebuild to verify** (not available in this environment)

Everything below is real, complete code — not a stub — that has been typechecked but never run on an
actual iOS/Android build, because that requires `expo prebuild` + Xcode/Gradle, which this environment
cannot do. Each one needs someone with a real device (or simulator/emulator with the native toolchains
installed) to prebuild, run, and click through it once before shipping.

- **Mobile Google/Microsoft/Apple sign-in** — done. `apps/mobile/src/components/oauth-sign-in-buttons.tsx`
  opens the same `/v1/auth/<provider>/authorize` endpoints the web app uses, in the system browser;
  `apps/mobile/app/auth-callback.tsx` receives the `veynlo://auth-callback` deep link the API now issues
  for native platforms (`services/api/src/modules/identity/identity.controller.ts`'s `finishOAuthSignIn`)
  and stores the session the same way email sign-in already does. Live-verified as far as possible without
  a real account: the authorize→state→callback→platform-aware-redirect mechanics were confirmed end to end
  via curl (Microsoft, since Google's OAuth app isn't configured in this dev environment either) — what's
  unverified is the actual "tap the button, complete Google's real consent screen, land back in the app"
  round trip on a device.
- **Android share target** — done. `expo-share-intent` was added (`apps/mobile/app.json`, configured
  `disableIOS: true` so it doesn't touch the existing, working iOS share extension — see the package's own
  README for why that flag exists) and wired through `apps/mobile/src/components/android-share-intent-drain.tsx`
  into the same `/capture` screen the iOS extension already hands off to. **Adding this native module means
  the mobile app can no longer run in plain Expo Go** — it already couldn't, in practice, once the iOS share
  extension (also a custom native module) was added earlier; `apps/mobile/package.json`'s `android`/`ios`
  scripts now read `expo run:android`/`expo run:ios` (which builds a dev client) rather than
  `expo start --android/--ios`. Worth knowing before your team's next `pnpm dev` on mobile.
- **EAS/dev-client build config** — done, proactively, without being asked twice. Added `expo-dev-client`
  as a dependency + plugin (`apps/mobile/app.json`) and a real `apps/mobile/eas.json` with `development`
  (dev client, internal distribution), `preview` (internal), and `production` build profiles. What's
  still missing is a real EAS account/project: `app.json` has no `extra.eas.projectId` because that only
  gets assigned by `eas init`/`eas build` against a logged-in Expo account, which needs your credentials —
  everything else (config, plugin wiring, profiles) is in place and will work the moment that exists.
- **iOS share extension — image/file capture** — done (built in an earlier pass this session, listed here
  for the same "needs a device" reason): `activationRules` now include `image`/`file`, not just
  `text`/`url`, and the capture screen uploads a shared file straight to `/v1/documents/upload`.
- **PEO-001 "Apple Contacts / local device address book" import** — done. Added `expo-contacts` (`~57.0.4`,
  matching this app's already-installed SDK 57 line, same tilde-pinning convention as `expo-calendar`/
  `expo-clipboard`) plus its config-plugin entry in `apps/mobile/app.json` (a `contactsPermission` string —
  Expo's CNG plugin handles `NSContactsUsageDescription`/Android `READ_CONTACTS`+`WRITE_CONTACTS`
  automatically, the same pattern `expo-calendar`'s entry already uses). This is native-module territory the
  app had already crossed for other reasons (the iOS share extension, Android share-intent, and Plaid Link
  above all already required `expo prebuild`/a dev-client build — see the "no longer runs in plain Expo Go"
  note above), so adding one more native module changes nothing about that constraint. Real, working code —
  not a stub — at `apps/mobile/app/person/import-device-contacts.tsx`: requests contacts permission, shows a
  denial/settings-redirect state on refusal, then a checkbox multi-select list (nothing checked by default,
  with search + select-all-shown/clear-all) so PEO-001's "never automatically upload the entire device
  address book without explicit consent" is enforced by the UI itself, not just a permission prompt — no
  network request happens until the user taps "Import N selected," at which point each checked contact
  becomes one `POST /v1/people` call (with `source: "apple_local"` so the resulting `contactSources` row
  correctly records it as a device import rather than a manually-typed contact). One real bug caught and
  fixed during this build: `expo-contacts`'s plain entrypoint now resolves to a new class-based API, and the
  package's own re-exported `getContactsAsync`/`requestPermissionsAsync` names are deprecated stubs that
  THROW at runtime (confirmed by reading the package's own `src/legacyWarnings.ts`) — the working import is
  from `expo-contacts/legacy`, not `expo-contacts` itself. What's genuinely unverified without a real
  device/simulator build: the actual native permission-prompt UI and picker list rendering — everything
  above that (the TypeScript, the request/response wiring, the multi-select logic) has been typechecked and
  code-reviewed but never run against a real iOS/Android contacts store.
- **Mobile Plaid Link** — done. Added `react-native-plaid-link-sdk` (v13, the current session-based API —
  the SDK dropped the older `<PlaidLink>` component/`usePlaidEmitter` hook in this version) as a real
  dependency; no Expo config-plugin entry was needed (confirmed against the package's own build metadata —
  it autolinks via Expo Modules, no `app.json` plugin block like `expo-share-intent`'s). `apps/mobile/app/
  connections.tsx`'s new "Connect a bank" button mirrors `apps/web`'s `PlaidConnectCard` exactly: fetches a
  link token from the same `/v1/connectors/plaid/link-token`, opens Plaid Link, and posts the resulting
  public token to the same `/v1/connectors/plaid/exchange` the web app uses — no new backend surface, since
  Plaid Link's token exchange is already platform-agnostic. The user-closed-without-finishing case (Link's
  `onExit` with no `error`) is handled as a quiet "back to idle," not an error banner; an actual Link error
  (bad credentials, institution down, etc.) surfaces its `displayMessage`. Because the SDK calls
  `requireNativeModule` unconditionally at import time (not lazily behind a runtime check), it throws
  immediately under `expo start --web` — a plain `Platform.OS === "web"` guard *inside* one shared module
  isn't enough to stop that (unlike `expo-share-intent`'s hook, which stays import-safe everywhere and is
  merely runtime-disabled). Fixed by splitting the integration into `src/lib/plaid-link.native.ts` (the real
  SDK) and `src/lib/plaid-link.web.ts` (a stub returning a clear "not available in this preview" result) so
  Metro's platform-extension resolution picks the right one per bundle and the real SDK is never referenced
  in a web build at all; added `"moduleSuffixes": [".native", ""]` to `apps/mobile/tsconfig.json` so `tsc`
  (a single, non-per-platform pass) resolves the same pair consistently. Verified: `pnpm --filter
  @veynlo/mobile run typecheck` is clean, and the Connections screen renders correctly under `expo start
  --web` (shows the "not available in this preview" message, no crash). What's unverified — no real device,
  no real `PLAID_CLIENT_ID`/`PLAID_SECRET` in this dev environment (see the "Plaid" bullet above), and this
  environment can't run `expo prebuild` + Xcode/Gradle — is the actual native flow: opening the real Link UI
  on iOS/Android, completing a sandbox institution login, and confirming the public-token exchange lands a
  working connection end to end on-device.
- **Mobile passkey sign-in (AUTH-001)** — done. Added `react-native-passkey` (v3.6.1, real dependency, no
  API key) — its own request/response JSON shapes (`PasskeyCreateRequest`/`PasskeyCreateResult`,
  `PasskeyGetRequest`/`PasskeyGetResult`) already follow the W3C WebAuthn dictionaries field-for-field, the
  same shape `@simplewebauthn/server` speaks on the API side, so `src/lib/passkey.native.ts`'s mapping is
  close to a pass-through rather than a real protocol translation. Split into `passkey.native.ts` (the real
  library) / `passkey.web.ts` (a stub, same reasoning as `plaid-link.web.ts` — the native module is required
  at import time) / `passkey.types.ts` (shared JSON shapes), following the exact `.native`/`.web` pattern
  this session already established for Plaid Link, reusing the same `"moduleSuffixes": [".native", ""]`
  tsconfig entry. Wired into `app/sign-in.tsx` ("Sign in with a passkey", via a new `signInWithPasskey` on
  `auth-context.tsx` that stores the returned bearer token exactly like `completeOAuthSignIn` already does)
  and `app/security/index.tsx` ("Add a passkey" + manage list), both gated on `passkeyAvailable &&
  isPasskeySupported()` so they simply don't render where unsupported. **No Expo config-plugin exists for
  this library** (checked its own README, not just assumed) — unlike Plaid, it needs *manual* native
  configuration: an iOS "Associated Domains" capability plus a `/.well-known/apple-app-site-association`
  file, and an Android `/.well-known/assetlinks.json` file, both hosted over real HTTPS on the app's actual
  production domain and matching its real bundle ID / signing certificate. Verified: `pnpm --filter
  @veynlo/mobile run typecheck` is clean, and `expo start --web` bundles successfully (1575 modules, "Web
  Bundled" with no errors) with the passkey code resolving to the inert web stub, confirmed by inspecting
  the served bundle. **UNVERIFIED ON A REAL DEVICE**, and for a more specific reason than this session's
  other native additions: unlike when the Plaid Link entry above was written, this environment's
  `apps/mobile/ios`/`apps/mobile/android` directories **do already exist** (an `expo prebuild` was run in
  an earlier pass for the share-extension/Plaid work) and Xcode + a booted iOS Simulator are genuinely
  available here — so the "can't prebuild" framing above doesn't fully apply to this one. What's actually
  missing is the associated-domain infrastructure itself: Apple/Google's passkey ceremony validates the
  well-known files over a **real, live network fetch to the app's real production domain** at ceremony
  time, which no local build, simulator, or sandboxed dev environment can substitute for — there is no
  amount of local tooling that closes this gap, only owning the real domain and deploying those two files
  to it. A full Xcode/Simulator build was deliberately not attempted this pass: even a successful build
  would still fail the associated-domain check for this exact reason, so the build effort wouldn't have
  bought real verification.

## SYS-001..008 (§36 "Widgets, Voice, Wearables & System Integrations") — status

All eight spec items in this chapter (iOS widgets, Android widgets, Apple App Intents/Shortcuts, Android
system actions, voice capture, Apple Watch, Wear OS, Live Activities) share **one identical** "Backend
behavior" line verbatim: *"Platform bridge queries minimal authorized projection APIs; caches only required
snapshot; deep links use signed/internal routes; voice capture enters standard source pipeline."* That
shared backend half is now real, tested, code-complete. The native UI half of each — the actual
WidgetKit/Glance/App-Intents-framework/watchOS/Wear-OS/ActivityKit code — needs a real Xcode/Android Studio
native build this environment cannot produce (same class of gap as this session's Plaid Link/geofencing/
share-intent work below), so it was deliberately **not** written blind: there is no untested, unverifiable
Swift/Kotlin/widget-timeline code anywhere in this pass pretending to be real.

**Built and real-DB-tested this pass:**

- **Schema** (`packages/db/src/schema/widgets.ts`) — `widget_preferences` (per user, per widget-kind
  `privacyMode`/`enabled`) and `app_intent_log` (one row per App Intent/Android-action/wearable-action
  invocation, for the spec's own "shortcut success... wearable action completion" analytics signal).
  **No `device_projections` cache table** — a deliberate scope decision, not an oversight: every projection
  endpoint below reads the live tables fresh on each call, since a cache adds real staleness/invalidation
  complexity this app's current widget-install volume doesn't yet justify (see the schema file's own doc
  comment). **No separate `voice_source_event` table** either — SYS-005's own line is "voice capture enters
  standard source pipeline," and `IngestionService.ingestVoiceNote` already files a `kind: "voice_note"` row
  directly into the existing `source_events` table (built in an earlier pass) — exactly that reuse, not a
  parallel idempotency mechanism.
- **Minimal authorized projection APIs** (`services/api/src/modules/widgets/`) — `GET /v1/widgets/
  today-summary` (Needs You count + next 1-2 items), `GET /v1/widgets/next-trip`, `GET /v1/widgets/
  deliveries`, all behind the same `AuthGuard` every other authenticated route uses (a native widget
  extension shares the app's own Keychain/Keystore session via App Group, same as this session's iOS share
  extension). Each returns ONLY the minimal fields a widget needs — a delivery's tracking number, for
  example, is never even selected out of the database, structurally impossible to leak rather than just
  filtered after the fact.
- **Privacy mode, enforced server-side, verified adversarially** — `PUT /v1/widgets/preferences/:widgetKind`
  sets `privacyMode` (`"detail"` | `"count_only"`) per widget kind; every projection endpoint resolves it
  from the STORED preference, never a client-supplied hint, so there is no query-param a widget could pass
  to bypass masking. `today-summary` additionally always shows a generic per-category label (never real
  summary text) for `health_appointment`/`identity_document`/`vehicle` items regardless of privacy mode —
  the spec's own "never a health appointment detail beyond what privacy mode allows... no raw VIN" line,
  enforced unconditionally rather than only when masked. Real Postgres test (`widgets.service.test.ts`):
  a masked request's entire serialized response is asserted to never contain a seeded secret string (a
  fake purchase detail, a fake destination, a fake tracking number) — an adversarial check, not just "the
  documented field is absent."
- **Signed deep-link helper** (`services/api/src/common/signed-deep-link.ts`) — a real, stateless
  HMAC-SHA256-signed token (`base64url(payload).base64url(signature)`) encoding resource type + id +
  expiry, minted by the projection endpoints and resolved by an unauthenticated `GET /v1/widgets/resolve`
  (deliberately unauthenticated — this is exactly what lets a LOCKED device's widget tap hand off into the
  app without an interactive sign-in round trip first, per the spec's own "Locked device" edge case; it
  never returns resource content, only a route, and the app's normal authorization runs again once that
  route loads the real object). New `DEEPLINK_SIGNING_SECRET` env var, separate from `SESSION_JWT_SECRET`
  (different blast radius), added to `PRODUCTION_REQUIRED_SECRETS`. Real, pure-function test suite
  (`signed-deep-link.test.ts`, no DB needed): valid round-trip, a flipped signature byte, a
  payload/signature "frankenstein" swap between two tokens, a decoded-edited-re-encoded-but-not-resigned
  payload, and an expired token are all correctly rejected.
- **App Intent audit log** — `PUT /v1/widgets/app-intents` records one invocation (platform, intent kind,
  resource, outcome) for SYS-003/004's analytics signal; real DB test confirms a logged row round-trips.

**Needs a real Xcode/Android Studio native build this environment cannot produce (not built, not stubbed):**

- SYS-001/002 — actual WidgetKit (iOS) / Glance (Android) widget UI code, timeline providers, and
  configuration intents that would call the projection APIs above.
- SYS-003/004 — actual `AppIntent`/`AppShortcutsProvider` (iOS) and App Actions/app-shortcuts (Android)
  declarations that would call the domain endpoints and log to `/v1/widgets/app-intents`.
- SYS-006/007 — an actual watchOS companion app / Wear OS Tile+app, which need their own Xcode/Android
  Studio targets, simulators, and (for a real device) paired-hardware verification.
- SYS-008 — actual `ActivityKit` Live Activity UI/Dynamic Island code.

None of this was written speculatively — no Swift/Kotlin files, no widget-timeline stubs, nothing that
would look like real native code but never actually compile or run. The moment a real Xcode/Android Studio
environment is available, every native surface above has a real, tested backend already waiting to be
called.

## MSG-001 (§"Share-message extraction") — status

Found, on audit, to be a genuine gap: the existing share-sheet capture flow (iOS Share Extension/Android
share intent → `/capture` → `POST /v1/ingestion/manual` with `kind: "share_capture"`) ran every shared TEXT
through the EMAIL-shaped `domain_classifier_v1` (receipt/bill/subscription/calendar_event/warranty/school/
health_appointment/pet/store_credit/shipment/travel/identity_document/home/vehicle/saved_item/irrelevant) —
a classifier with no "task"/"address"/"person"/"note"/"recommendation" domain at all, so a plain
task-shaped or recommendation-shaped share (the common case for a forwarded text message) silently landed
on "irrelevant" or a dead-end domain like `saved_item` with nothing ever filed. A shared SCREENSHOT (image)
was worse — it went straight to generic Documents storage with no classification whatsoever, OCR or
otherwise.

**Fixed, built, and real-DB-tested this pass:**

- A dedicated `share_message_classifier_v1` extractor (`ShareMessageClassificationSchema`,
  `services/api/src/modules/intelligence/extraction-schemas.ts`) with the spec's own exact category set —
  date/task/event/address/purchase/recommendation/person/note — used ONLY for `kind: "share_capture"`;
  every other manual-capture kind is unaffected.
- Real routing, reusing every existing extractor rather than building parallel ones
  (`IngestionService.classifyAndRouteShareMessage`): "purchase" → the existing `extractReceipt`; "event"/
  "date" → the existing `extractCalendarEvent`; "task" → a real new `tasks` row (no prior extractor
  existed for this) plus an inbox item; "address" → an inbox-item candidate (deliberately NOT an
  auto-saved `places` row — matches `LocationService.extractPlaceCandidate`'s own already-established
  "extraction only, user explicitly saves" precedent elsewhere in this codebase); "recommendation"/
  "person"/"note" → a real Saved Memory (`MemoriesService.create`, reusing SAVE-001's own dedup/
  classification pipeline). A share that fails category-specific extraction (e.g. classified "purchase"
  with no clear receipt fields) falls back to a plain saved note rather than silently vanishing — a
  deliberate user action always produces something reviewable.
- **Never asserts sender identity** — structurally, not just by prompt promise: `ShareMessageClassificationSchema`
  has no field for a "from"/sender claim at all (`personMentioned` is explicitly scoped to a person named
  WITHIN the content, e.g. "call Jake back," never who shared it) — the same "schema shape is the second
  structural layer" discipline `HealthAppointmentExtractionSchema` already uses. Real DB test asserts the
  resulting Saved Memory row has no sender-shaped column at all.
- **Screenshot capture now genuinely classified**, not just stored: `DocumentsService.transcribeSharedImage`
  (a public wrapper reusing the EXACT SAME Claude vision OCR call `processOcr`'s background worker already
  uses for a regular document upload — see that method's own doc comment) feeds a new, synchronous
  `IngestionService.ingestShareScreenshot` (`POST /v1/ingestion/share-screenshot`), which OCRs the image and
  routes the transcribed text through the identical `classifyAndRouteShareMessage` pipeline text shares use.
  An unreadable screenshot still gets a source event and an honest "couldn't read this" inbox item rather
  than being silently dropped. `apps/mobile/app/capture.tsx` now routes an image share to this endpoint
  instead of generic Documents storage; a shared PDF/other file is unaffected.
- Real Postgres tests (`ingestion.share-message.test.ts`): a task-shaped share creates a real `tasks` row
  (not a generic note — the exact gap this closes) with the extracted due date; a purchase-shaped share is
  proven to call through `receipt_extraction_v1` (the real, existing extractor, not a reimplementation); a
  recommendation-shaped share creates a real Saved Memory with the mentioned person preserved in notes and
  no sender field anywhere; an unclassifiable share still produces a fallback saved note; and an ordinary
  (non-share) manual capture is proven to still use the original `domain_classifier_v1` unchanged.

Nothing about this feature is native-build-gated — it's pure server-side routing/classification logic, so
there is no "needs a device" caveat here.

## Explicitly deferred (real product/engineering decisions, not just a missing key)

- **Automation actions beyond L0/L1** (`services/api/src/modules/automation/rule-schemas.ts`) — `notify`,
  `add_task`, and now `add_calendar_event` (all L0/L1, all Veynlo-internal) exist; nothing at spec §34.1's
  L2 ("external low-risk mutation... connector write scope required") or above — that still needs a real
  per-action-kind design decision (which connector, which write API, what confirmation UI), not a
  mechanical enum addition, and you've now explicitly said to keep automation Veynlo-internal rather than
  add connector-write scopes at all.
- **✅ Fixed — an automation-created `calendar_events` row never ran through CAL-003 conflict detection, and
  `undoRun` never reversed a CAL-001 write-back push.** Originally found during an adversarial audit of
  AUTO-006 undo against the concurrently-built CAL-001/CAL-003 work; both halves are now built.
  - `AutomationService.executeRun`'s `add_calendar_event` branch now calls `ScheduleService.createEvent(
    ownerUserId, dto, "automation")` instead of inserting directly into `schema.calendarEvents` —
    `createEvent` gained a third `source` parameter (defaulting to `"manual"` for the public API, which
    `ScheduleController` never passes) precisely so this route could keep tagging automation-created rows
    `source: "automation"` while still going through the one method that calls `ConflictService.
    detectOverlaps`. Wiring this needed `ScheduleService` injected into `AutomationModule` — safe, one-
    directional (`ScheduleModule` never imports `AutomationModule`, directly or transitively). Real DB test
    added (`automation.service.test.ts`): an automation event created to land exactly on an existing event's
    time now produces a real, unresolved `schedule_conflicts` row naming both events.
  - `GoogleCalendarAdapter`/`MicrosoftCalendarAdapter` each gained a real `deleteEvent(connectionId,
    providerEventId)` (Google: `calendar.events.delete()`; Microsoft: `DELETE /me/events/{id}` via Graph,
    reusing each adapter's existing OAuth/credential-refresh machinery exactly like `createEvent`/
    `updateEvent`; both treat a 404/410 — "already gone on the provider" — as success, not an error).
    `CalendarWriteBackService` gained a matching `deleteEvent({eventId, ownerUserId})`: best-effort deletes
    the provider-side copy FIRST (log-and-continue on failure — same "local deletion is the real boundary,
    provider-side is defense-in-depth" stance this codebase already uses for connector-token revocation),
    then deletes the local row unconditionally — the single place both the new generic `DELETE /v1/
    calendar-events/:eventId` endpoint and `AutomationService.undoRun` now go through. `undoRun`'s
    `add_calendar_event` branch replaced its plain `db.delete` with a call to this method.
  - Wiring `undoRun` to `CalendarWriteBackService` (in `ConnectorsModule`) surfaced a REAL module cycle this
    doc didn't originally anticipate: `ConnectorsModule` imports `IngestionModule`, which already imports
    `AutomationModule` (for `IngestionService.fileInboxItem` → `AutomationService.evaluateEvent`) — so
    `AutomationModule` importing `ConnectorsModule` closes the loop
    (`Automation -> Connectors -> Ingestion -> Automation`). Fixed with NestJS's documented `forwardRef()`
    circular-dependency resolution — genuinely new to this codebase (grepped: zero prior usage) — on both
    the module import (`automation.module.ts`) and the constructor injection (`@Inject(forwardRef(() =>
    CalendarWriteBackService))` in `AutomationService`). A plain top-level `import { CalendarWriteBackService
    }`/`import { ConnectorsModule }` still recreated the SAME cycle one level down at the CommonJS
    `require()` level (confirmed live: booting crashed with "Cannot access 'IngestionService'/'IngestionModule'
    before initialization", a classic circular-require TDZ symptom) — the actual fix uses `import type` for
    the class/module references plus a lazy `require()` call inside each `forwardRef(() => ...)` arrow
    function, deferring resolution until DI actually runs, well after every file has finished its own
    initial `require`. Verified by actually booting the full Nest module graph (`NestFactory.create(
    AppModule)` against the real dev Postgres) end to end, not just by TypeScript compiling — logged
    `BOOT_OK` with every route (including the new ones) mapped.
  - Real DB tests added to `automation.undo.test.ts`: undoing a run whose event was pushed to a connected
    calendar calls the (fake, no real OAuth creds in this dev environment) adapter's `deleteEvent` with the
    right connection/provider-event id before deleting the local row; a simulated provider-side failure is
    logged and swallowed, and the local row is still deleted.

- **CAL-003 conflict detection never expands a recurring event's future occurrences — it only ever checks the
  single stored row's own `start`/`end`.** Found during a follow-up adversarial audit specifically targeting
  whether TASK-003 (recurrence) and CAL-003 (conflict detection) — built concurrently by two different
  agents this session — actually work *together*. Confirmed by reading `ConflictService.detectOverlaps`
  (`services/api/src/modules/schedule/conflict.service.ts`): it never imports or calls `expandOccurrences`
  (`packages/core/src/util/recurrence.ts`), and reads only `calendarEvents.start`/`end`/`isAllDay` for the
  event being checked and every candidate. Live-verified two ways:
  - Real Postgres integration test: a weekly-recurring event anchored on 2026-10-05 and a one-off event on
    2026-10-19 (the recurring series' third occurrence, same time slot) produce **zero** conflicts in either
    direction, even though a human would clearly call that a double-booking.
  - Same result reproduced end to end through the real running dev API (`POST /v1/events` with a weekly
    `recurrenceRule`, then a second one-off `POST /v1/events` on that series' third occurrence date) — the
    response's `conflicts` array is empty, and `GET /v1/schedule-conflicts` confirms nothing was recorded.
  Practical impact: conflict detection today only ever catches a collision against a recurring event's own
  *anchor* date (or, for `days_before`, whatever date it currently resolves to) — every other occurrence of
  that series is invisible to CAL-003. This is a real, meaningful gap beyond the four cases the doc comment on
  `ConflictService` already scopes out (double-booked shared assets, travel time, email-vs-calendar
  disagreement) — it affects the one case (true overlap) that *was* built.
  **Now fixed** — `ConflictService.occurrenceRanges` expands any recurring event (the one being checked AND
  every candidate) over a bounded window (90 days forward from "now", documented in `conflict.service.ts`'s
  own constant comment — a deliberate, separate choice from `previewOccurrences`'s UI-preview window, which
  caps by occurrence *count* rather than days). Each distinct colliding occurrence-date gets its own
  `schedule_conflicts` row (a new `occurrenceDate` column dedupes per pair-per-date, not just per pair), so a
  recurring series colliding with the same other event on three different future dates records three
  independently-resolvable conflicts instead of one that silently also covers the other two. Re-verified via
  the exact repro above: the weekly-recurring-event-anchored-2026-10-05 vs. one-off-on-2026-10-19 case now
  correctly produces a conflict (`conflict.service.recurring.test.ts`, 5 real-DB cases — including a case
  confirming a collision past the 90-day window is correctly NOT flagged, and that the same recurring
  occurrence-date collision re-detected later reuses its row rather than duplicating).

- **CAL-004's reschedule-reconciliation update path silently goes stale against an already-write-back-pushed
  connected calendar — it never re-pushes, and never even flags `writeBackStatus` as stale.** Found during the
  same follow-up audit, specifically the question "does a second email updating a discovered event's date
  propagate to write-back re-push, or at least not silently go stale?" It does not.
  `IngestionService.extractCalendarEvent`'s update-in-place branch (the CAL-004 dedup fix) only ever sets
  `start`/`startSort`/`isAllDay`/`location`/`updatedAt` on the existing row — it never calls
  `CalendarWriteBackService.pushEvent`, unlike `InboxService.correctCalendarEvent` (the user-initiated
  "Correct" action on an inbox item), which *does* re-push when `writeBackConnectionId` is set. Confirmed by
  code read (`IngestionService`'s constructor has no `CalendarWriteBackService` dependency at all — 8 params,
  none of them the write-back service) and live-reproduced via a real Postgres integration test: an event
  seeded with `writeBackConnectionId`/`providerEventId`/`writeBackStatus: "pushed"` (simulating a prior
  successful `InboxService.addToCalendar` push), run through two `ingestManualText` calls (an initial
  discovery, then a reschedule email moving the date a week later) — the local row's date updates correctly,
  but `writeBackStatus` stays `"pushed"` and `providerEventId` is untouched, i.e. the UI still shows "Last
  synced successfully" while the actual Google/Microsoft Calendar event nobody re-pushed now disagrees with
  Veynlo's own record. **Not fixed in this pass — this is architectural, not a small edit.**
  `CalendarWriteBackService` lives in `ConnectorsModule`, and `ConnectorsModule` already imports
  `IngestionModule` (so `GmailAdapter`/`OutlookAdapter` can call `IngestionService` on new mail) — injecting
  `CalendarWriteBackService` back into `IngestionService` would create a circular module dependency. This
  codebase has no precedent for NestJS `forwardRef()` (grepped — zero hits) and no event-emitter/pub-sub
  infrastructure to decouple the two modules another way (also grepped — no `@nestjs/event-emitter`
  anywhere). A real fix needs one of: introducing `forwardRef()` circular-DI (new pattern, needs its own
  careful verification across the whole module graph), extracting a smaller, dependency-free "push" primitive
  into a lower-level module both sides can import, or standing up an event-emitter to decouple ingestion from
  connectors — each a real, scoped follow-up, not something to bolt on under audit time pressure. Until then,
  a discovered event that gets legitimately rescheduled after being pushed to a connected calendar needs a
  manual re-push (the event detail page's existing "Push" button) to catch up — it is not automatic, and
  nothing currently surfaces that it's needed.

  **Update — partially closed by CAL-004's consent fix (see that entry, further down this doc).** Building
  `InboxService.applyRescheduleChange` (the "offer, don't auto-apply" fix) meant `InboxService` — which
  already depends on `CalendarWriteBackService`, no cycle involved — became the place a reschedule actually
  gets APPLIED whenever no trusted rule covers the sender, and it does re-push on apply. So the staleness
  bug described above is now real only for the TRUSTED-sender auto-apply path still living in
  `IngestionService.extractCalendarEvent` itself, which still has no `CalendarWriteBackService` dependency
  and would still need one of the three fixes above (or now, additionally, an option this doc didn't have
  before: this session also introduced this codebase's first `forwardRef()` usage elsewhere — see
  AUTO-006/CAL-001's "an automation-created `calendar_events` row..." entry above — proving the circular-DI
  path works end to end in this app, if that's the direction a future pass wants to take here too).

## Fixed this pass

- **The API's CORS config never allowed the `PATCH` HTTP method, so every real browser call to a `PATCH`
  endpoint failed silently.** Found live during the same adversarial CAL-001/CAL-002/CAL-003/TASK-003
  integration audit above, while specifically testing whether the Connections page's write-back toggle
  actually persists across a reload (not just "renders correctly," which is as far as the original CAL-001
  live-verification went). Clicking the toggle in a real Playwright-driven browser produced a CORS preflight
  rejection in the console (`Method PATCH is not allowed by Access-Control-Allow-Methods`) — the click did
  nothing, `ConnectorsService.setWriteBack` was never reached, and the switch silently reverted to unchecked
  on reload. Root cause in `services/api/src/main.ts`: `app.enableCors({ ..., methods: [...] })` listed
  `GET`/`HEAD`/`POST`/`PUT`/`DELETE` but not `PATCH` — the exact same class of bug as the PUT and DELETE gaps
  already documented inline at that call site (`@fastify/cors`'s own default is `GET,HEAD,POST` only, and
  each method has historically been added only after a real browser call needed it, since a same-process
  curl/Postman request never triggers a CORS preflight and so can't catch this). `PATCH /v1/connectors/:id/
  write-back` was simply this app's first real browser-originated `PATCH` call; the same fix also unblocks
  two other pre-existing `PATCH` routes that had no live browser caller yet (and so had never surfaced the
  bug either): `PATCH /v1/households/:householdId` / `:householdId/members/:membershipId`
  (`household.controller.ts`) and `PATCH /v1/emergency-binder/:householdId/settings`
  (`emergency-binder.controller.ts`). Fixed by adding `"PATCH"` to the `methods` array, with the same inline
  comment convention the PUT/DELETE additions already used. Live re-verified via Playwright after the fix, at
  both 1280×900 and 390×844: the write-back toggle now flips on with one click and correctly stays on after a
  full page reload (re-fetched from the backend, not local state) — confirmed via `GET /v1/connectors` and
  a direct DB read, not just the UI. No existing automated test covers `main.ts`'s CORS config (matching this
  codebase's own established pattern for this exact class of bug — the PUT and DELETE additions before it were
  also caught and confirmed by live browser testing, not a unit test, since exercising a real CORS preflight
  needs an actual cross-origin browser request, not just an in-process HTTP call).



- **TASK-003 "Recurrence engine" — was entirely unbuilt, now real.** `tasks.recurrenceRule`/
  `calendarEvents.recurrenceRule` were stored-but-inert `text` columns — confirmed via grep before this
  pass that neither was ever read or expanded anywhere in non-test backend code. Built:
  - A structured `RecurrenceRule` discriminated union (`packages/core/src/util/recurrence.ts`) covering
    daily/weekly/monthly/yearly, "nth weekday" (e.g. "2nd Tuesday"), "business day" (every Nth weekday),
    "X days before" (anchored to another calendar event/task's own date), and an optional
    `weekendAdjustment` (nearest/next/previous weekday) applying to the first five kinds — plus a pure,
    fully unit-tested `expandOccurrences(rule, anchorDate, window)` function doing calendar-date (never
    wall-clock/instant) arithmetic in UTC, consistent with `TemporalValue`'s own "date" precision. Covered
    by 13 cases in `packages/core/src/util/recurrence.test.ts`.
  - Both columns changed from `text` to `jsonb().$type<RecurrenceRule>()` (migration
    `0029_salty_the_anarchist.sql` — also handles the dev DB's few pre-existing legacy free-text values by
    discarding the unparseable ones rather than failing the migration, since nothing ever read them).
  - `ScheduleService.upcomingEvents`/`tasks` now attach a `nextOccurrences` preview (a handful of future
    ISO dates) to every recurring row — computed on read, not materialized as separate rows/a cron job
    (this codebase has no job-scheduling infrastructure at all — grepped for "cron"/"@nestjs/schedule"/
    "ScheduleModule", genuinely nothing exists — so computed-on-read avoids standing up new infra for this
    one feature; see the doc comment on `ScheduleService.previewOccurrences` for the full reasoning,
    including why occurrences aren't multiplied into synthetic rows with fabricated ids).
    `ScheduleService.completeTask` now rolls a recurring task's due date forward to the rule's next
    occurrence instead of marking the whole series "completed" (matches how reminders apps generally treat
    a repeating chore); a rule that can't produce a further occurrence falls back to ordinary one-time
    completion.
  - New `POST /v1/events` (`ScheduleService.createEvent`) — there was previously no way to create a
    calendar event from the UI at all (every row came from AI discovery or a provider sync); this is also
    what gives TASK-003's "let the user set a recurrence on an event" requirement something to attach to.
    Plus `PUT /v1/tasks/:id/recurrence` / `PUT /v1/events/:id/recurrence` for editing an existing row's
    rule.
  - UI: a shared `RecurrencePicker` component (`apps/web/src/components/recurrence-picker.tsx`,
    `apps/mobile/src/components/recurrence-picker.tsx`) — a kind selector plus the relevant sub-fields
    (interval, weekday pills, day-of-month, nth+weekday) — wired into both apps' new "+ Add an event" form,
    the existing "+ Add a reminder" form, and a new "Recurrence" card on the event detail page (both
    platforms). "Days before" and mileage-based recurrence are deliberately NOT offered by the picker (see
    below) — everything else the engine supports is settable from the UI.
  - **Deliberately deferred, not silently skipped:**
    - **Mileage/usage-condition recurrence** ("every 5,000 miles") — `packages/db/src/schema` has no
      mileage/odometer tracking on vehicles at all (confirmed via grep), so there's no data source to
      evaluate a mileage condition against. Building one would mean inventing a whole odometer-tracking
      feature blind, not closing a scoped recurrence-engine gap.
    - **"Provider-derived cycles"** (a synced Google/Microsoft Calendar event's own RRULE) — neither
      `google-calendar.adapter.ts` nor `microsoft-calendar.adapter.ts` reads or stores the provider's
      recurrence payload today; wiring that in is a connector-adapter change, separate from the core engine
      built here.
    - **"Days before" has a known staleness limitation**: it resolves the anchor entity's *currently
      stored* date on every read, so the preview/next-occurrence logic reacts correctly if the anchor moves
      — but the dependent row's own `dueSort`/`startSort` (used for the SQL-level upcoming-window filter)
      is set once, at creation, and doesn't automatically follow the anchor if it's rescheduled later. A
      full fix would need either a DB trigger or an event listener on the anchor entity's own writes, which
      is out of scope for this pass; documented inline on `ScheduleService.resolveDaysBeforeAnchorDate`.
  - Verified: `packages/core`'s `recurrence.test.ts` (13 cases), `services/api`'s
    `schedule.recurrence.test.ts` (real-DB: recurrence set at creation, `nextOccurrences` surfaced,
    completion rolling a recurring task forward vs. a one-off task completing normally,
    `setTaskRecurrence` owner-only set/clear) — 5 real-DB cases, all passing. Live-verified end to end via
    Playwright on both web (1280×900) and the Expo web preview (390×844): created a weekly recurring
    reminder and a weekly recurring event through the real picker UI, confirmed `nextOccurrences` render
    correctly ("Repeats weekly — also 2026-10-19, 2026-10-26, 2026-11-02"), and confirmed the event detail
    page's Recurrence card round-trips a rule created via the API.

- **CAL-003 "Conflict detection" — was entirely unbuilt, now built for the one high-confidence case the
  spec asks for, with the rest precisely scoped out.** `schedule_conflicts` had zero writers anywhere
  (confirmed via grep and, independently, two prior audit passes). Built:
  - **True overlap** (`services/api/src/modules/schedule/conflict.service.ts`,
    `ConflictService.detectOverlaps`) — flags two events for the same owner, or the same household
    (respecting the exact visibility rules `ScheduleService.ownerOrDelegatedHousehold` already enforces for
    reads: owner's own events, plus any non-`private` event in a household they belong to or are delegated
    into), whose effective time ranges intersect. An event's effective range comes from its own `start`/
    `end`/`isAllDay` — never fabricated from an approximate/date-only precision — except that an event with
    a known start instant but no known end defaults to a 60-minute duration (a deliberate, documented
    estimate matching common calendar-UI defaults, needed because *some* duration policy is unavoidable for
    a useful overlap check; it only affects which pairs get compared, never anything stored or displayed).
    Precision-first dedup, same stance as `findExistingDiscoveredCalendarEvent`/`findExistingBill`
    elsewhere: re-detecting the same collision on a later save reuses the existing unresolved
    `schedule_conflicts` row rather than creating a duplicate.
  - Runs synchronously on `ScheduleService.createEvent` (returns any newly-found conflicts in the response
    so the UI can show them immediately) and as a backstop in `IngestionService.extractCalendarEvent`
    (discovered/rescheduled appointments never go through `createEvent`, so this is the only place they get
    checked — best-effort, logged and swallowed on failure so it can never block filing the event itself).
  - `GET /v1/schedule-conflicts` (unresolved conflicts for the current user) and
    `POST /v1/schedule-conflicts/:id/resolve` (the spec's "resolve conflict" action — dismiss/acknowledge,
    owner-of-either-event only) — surfaced as a banner naming the conflicting events with a "Dismiss"
    button on both web's Life page and mobile's Life tab.
  - **Recurring-event expansion (now built)** — `detectOverlaps` used to only ever compare each event's own
    stored `start`/`end`, so a recurring event's future occurrences were invisible to conflict detection
    (see this doc's own earlier entry on that gap, now marked fixed). `ConflictService.occurrenceRanges`
    expands any recurring event — the one being checked AND every candidate — over a bounded 90-day-forward
    window, comparing every occurrence pairwise with the same overlap logic. Each distinct colliding
    occurrence-date gets its own `schedule_conflicts` row (`occurrenceDate` column), reusing the existing row
    for the same pair+date on re-detection rather than duplicating.
  - **Double-booked shared assets (now built, vehicle-only slice)** — the spec's own example ("a car needing
    to be in two places at once"). `vehicleProfiles` is the only genuinely bookable shared-resource concept
    this app has; a calendar event now tags "using this vehicle" via `calendarEvents.relatedEntityIds`
    (`ScheduleService.createEvent`'s new optional `vehicleProfileId` field, and a new `PUT /v1/events/:id/
    vehicle` for tagging an existing event) — the column was previously declared and written nowhere.
    `ConflictService.vehicleConflicts` flags the SAME vehicle referenced by two overlapping events, including
    across two DIFFERENT household members' own events, reusing the exact same recurring-expansion/dedup
    machinery as true overlap. New vehicle picker on the event-creation form on both web (`AddEventForm`)
    and mobile (`AddEventRow`); a `vehicle_double_booked` conflict shows a distinct banner message ("needs
    the same vehicle as", not the true-overlap "overlaps with" wording) with its own live conflict-count
    entry. Deliberately NOT generalized to arbitrary "shared resources" beyond vehicles — no other
    bookable-asset concept exists in this app to hang that on.
  - **Email-vs-calendar date disagreement (now built, narrowed slice)** — not the fuzzy "is this the same
    appointment" guess this entry used to defer on. `IngestionService.checkCalendarDateDisagreement` reuses
    the exact same precision-first matching discipline CAL-004's reschedule reconciliation and CAL-001's
    cross-source linking already use (same owner, exact normalized title, "more than one candidate → no
    match", gated on a high-confidence extraction) to find an existing calendar event from a DIFFERENT
    source (a provider sync — `providerEventId` set) whose date disagrees with what a newly-processed email
    states. Never auto-updates (CAL-004 already does that for a same-source match) and never silently drops
    the discrepancy (the old cross-source behavior) — files a `schedule_conflicts` row (kind
    `email_calendar_date_disagreement`, deduped so a second email about the same still-unresolved
    disagreement doesn't spam a duplicate) plus a resolvable inbox item offering
    `["use_email_date", "keep_calendar_date", "dismiss"]` (`InboxService.resolveDateDisagreement` — "use
    email date" reuses `correctCalendarEvent`, including its write-back re-push). Deliberately excluded from
    the Life page's plain dismiss-only conflict banner (`ConflictService.unresolvedConflicts`) — that
    banner's generic "Dismiss" would settle the conflict without ever applying either date, defeating the
    whole point; found live during this pass's own verification (two same-titled test events rendered a
    confusing "X overlaps with X" there before this exclusion was added).
  - **Still deliberately deferred** (see `ConflictService`'s own doc comment): **Impossible travel time /
    dependent transportation conflicts** — both need real geolocation (geocoding two `location` strings plus
    a travel-time estimate). No geocoding/maps API integration exists anywhere in this codebase (grepped for
    "geocod"/"maps"/"distance" across `services/api` — zero hits) and none of Phase 2's already-configured
    providers offer it; needs a paid API dependency and a product decision on which one. Left exactly as
    scoped — not touched by this pass.
  - Verified: `conflict.service.test.ts` (5 real-DB cases, true overlap), `conflict.service.recurring.test.ts`
    (5 real-DB cases — the documented 3rd-occurrence repro now correctly flags, symmetric from either side,
    per-occurrence-date dedup, three distinct occurrence-date collisions get three distinct rows, and a
    collision past the 90-day window is correctly NOT flagged), `conflict.service.vehicle.test.ts` (5 real-DB
    cases — cross-owner double-booking flagged, different vehicles not flagged, non-overlapping bookings not
    flagged, dedup, no-vehicle-tagged event returns nothing), and `ingestion.date-disagreement.test.ts` (4
    real-DB cases — conflict + inbox item filed, second email about the same disagreement doesn't duplicate,
    both `use_email_date`/`keep_calendar_date` resolutions verified end to end, low-confidence extraction
    correctly does not fire) plus `schedule.recurrence.test.ts`'s `createEvent` case. Live-verified via
    Playwright at 1280×900, 390×844, and the Expo web preview (390×844): created a vehicle and two
    overlapping events tagging it through the real UI on both web and the Expo preview, confirmed the
    "needs the same vehicle as"/"already booked for an overlapping event" messages appeared immediately and
    persisted after a full reload; seeded a real date-disagreement scenario end to end through
    `ConflictService.recordDateDisagreement` and confirmed the Inbox item's "Use email date"/"Keep calendar
    date" buttons render on web, the 390px web viewport, and the Expo preview, and that clicking "Use email
    date" actually updates the calendar-side event's date and resolves the conflict (checked directly against
    Postgres, not just the UI's optimistic state).

- **Emergency binder was a document-only subset, not the spec's cross-domain packet** — closed, with a
  deliberately conservative scope. Real, tested (`services/api/src/modules/emergency-binder/emergency-
  binder.household-scope.test.ts`, real-DB) additions:
  - **Aggregation view** (`EmergencyBinderService.getBinder`, `GET/POST /v1/emergency-binder/...`, web page
    `apps/web/src/app/(app)/emergency-binder/page.tsx`, mobile screen `apps/mobile/app/emergency-
    binder.tsx`) that pulls together, read-only, from data that already existed: household roster
    (`householdMemberships` + `users`), dependents (`dependentProfiles`), vehicles/properties
    (`vehicleProfiles`/`propertyProfiles`, filtered by household rather than by owner — a new query shape,
    since the existing `AssetsService` methods answer "what can this user see" not "what belongs to this
    household regardless of owner"), and the existing flagged-document binder items
    (`DocumentsService.emergencyBinderItems`, read directly rather than via that service, to avoid pulling
    in its entire upload/OCR/sharing surface for one read).
  - **Household-level free text**: two new nullable `encryptedText` columns directly on `households` —
    `medicationsNotes`/`emergencyInstructions` (migration `0030_swift_vance_astro.sql`). Deliberately NOT a
    new one-row-per-household settings table (the household row itself was the simpler fit) and
    deliberately NOT a real medications-tracking domain (dosages, schedules, prescribers) or a contacts/CRM
    domain — both are separately-reserved Phase 2 future features per spec §53's Future Feature Inventory,
    out of proportion to what's needed here. Editable by any adult household member
    (`EmergencyBinderService.updateSettings`, same owner-or-adult-member gate `household.service.ts` uses
    elsewhere), surfaced on the existing household settings page (`settings/household/page.tsx`) —
    deliberately NOT step-up gated itself (see below).
  - **Biometric/step-up protection**: the full aggregated packet is gated server-side by the same §28.9
    `verifyStepUpPassword` check every other sensitive action uses (`POST /v1/emergency-binder/:id/unlock`
    takes a password, 401s with `PASSWORD_REQUIRED`/`INVALID_CREDENTIALS` otherwise — a no-op for an
    OAuth-only account, same as data-export/connector-disconnect). Web reuses the existing step-up-password
    UI pattern. Mobile adds a real local biometric prompt (`expo-local-authentication` — already a
    dependency, not newly added) in front of that same server call, falling back to the password flow
    automatically when no biometric hardware/enrollment exists; a device-local biometric proves "this
    device, right now," not "still knows the account password," so it's a gate in *addition* to the
    server's step-up check, not a replacement for it (see the mobile screen's own doc comment). The two
    fields alone (outside the aggregated view) are intentionally left ungated, matching every other single
    household-settings field's permission model — it's the *combination* of roster + vehicles + property +
    medical info in one place that the spec calls "biometric-protected," not any one field of it in
    isolation. The gate re-triggers on every screen *navigation* focus, AND (see the adversarial-audit
    addendum below) on the app being backgrounded and foregrounded while the screen stays the active route —
    the latter needed a real fix, it wasn't automatic.
  - **Offline-capable (mobile)**: after a successful unlock, the payload is cached via
    `@react-native-async-storage/async-storage` (newly added — verified nothing suitable already existed;
    `expo-secure-store`, used for the auth token/theme, has real per-item size limits this structured,
    multi-KB payload could exceed). A "last synced" line shows under the lock screen; the cached view
    renders on a fetch failure once the gate has already been passed, and the gate itself (biometric or
    password) re-triggers on every screen open — see the adversarial-audit addendum below for two real gaps
    found in the original "the cache never bypasses it" claim, both now fixed.
  - **Export**: no PDF-generation library exists anywhere in this app (checked `data-export.service.ts`,
    the only other export-shaped feature — it's JSON-only) and adding one just for this one button would be
    disproportionate. Web uses the browser's own print-to-PDF via a `@media print` stylesheet; mobile uses
    React Native's built-in `Share.share` (zero new dependencies) to hand a plain-text summary to
    Messages/Mail/AirDrop/a printer driver — whatever the device already offers.
  - **Explicitly out of scope, on purpose**: no contacts/CRM domain (schema has no `contacts` concept at
    all — confirmed via grep before starting; skipping it entirely rather than building one from scratch,
    per spec §53's own separate reservation for it). No real medications-tracking domain (dosages,
    schedules, refill dates) — just the one free-text field. No multi-household picker on mobile (the
    screen follows the same "first household" simplification the Home tab's family-today card already
    makes — no picker exists there either).
  - **Adversarially re-verified in a follow-up audit pass — one security check confirmed clean, three real
    bugs found and fixed.**
    1. **Unlock endpoint bypass attempts (curl, not the UI) — none succeeded, no fix needed.** Signed up two
       real accounts and hit `POST /v1/emergency-binder/:householdId/unlock` directly: no password → 401
       `PASSWORD_REQUIRED`; wrong password → 401 `INVALID_CREDENTIALS`; a real member's household hit by an
       *outsider* account using that outsider's own valid password (i.e. trying to unlock someone else's
       binder by guessing/enumerating household ids, not by cracking their password) → 403 `NOT_A_MEMBER`,
       checked before the password verification even runs; no session cookie at all → 401 `UNAUTHORIZED`.
       All four confirmed live against the real running dev API (not just the existing
       `emergency-binder.household-scope.test.ts` real-DB service-layer coverage, which already asserted the
       same outcomes one layer down). This app's "step-up" isn't a separate token that can go stale — it's a
       live password re-check on every call — so there is no stale-token bypass surface to begin with.
    2. **Mobile biometric gate did NOT actually re-trigger on backgrounding, contrary to the original
       self-reported claim — fixed.** `apps/mobile/app/emergency-binder.tsx` only used expo-router's
       `useFocusEffect`, which (confirmed by reading expo-router's own bundled implementation) subscribes
       solely to React Navigation's `focus`/`blur` events — i.e. *navigating* to/from this screen. It does
       **not** fire when the OS app is merely backgrounded and foregrounded while this screen stays the
       active route, unlike what the screen's own doc comment claimed. Fixed by adding a second, explicit
       `AppState` listener (the same mechanism the app-wide `biometric-lock-context.tsx` lock already uses),
       scoped to only re-lock while this screen is actually focused.
    3. **Offline cache had no user/household scoping and was never cleared on sign-out — a real cross-account
       data leak, fixed with two independent guards.** Nothing cleared the
       `veynlo_emergency_binder_cache_v1` AsyncStorage key on sign-out, and `unlockWithPassword`'s
       fetch-failure fallback would show whatever was cached with no check on whose data it was. On a
       shared/multi-user device: sign out of Account A (having viewed the binder), sign in as Account B,
       open the binder screen while offline (or the API is briefly unreachable) → Account B would see
       Account A's cached household roster/vehicle VINs/property addresses/medications, entirely bypassing
       Account B's own membership and step-up checks (those only run against the live server call, never
       against the local fallback). Fixed two ways, deliberately redundant: (1) `signOut()` in
       `auth-context.tsx` now clears the cache; (2) independently, every cache entry is now tagged with the
       `ownerUserId` it was fetched as (extracted into a new shared `src/lib/emergency-binder-cache.ts`), and
       the fetch-failure fallback in `emergency-binder.tsx` refuses to show a cached payload whose
       `ownerUserId` doesn't match the currently signed-in user — so a stale cross-account cache can't
       surface even if a future code path skips the sign-out clear (e.g. a forced/background session expiry
       that never calls `signOut()`).
    4. **The "Share / Print" button crashed the whole screen on any platform/browser without the Web Share
       API — fixed.** Confirmed live via the Expo web preview: clicking it threw an uncaught
       `"Share is not supported in this browser"` error (react-native-web's `Share.share()` throws
       synchronously rather than rejecting a promise there), taking over the whole screen with Expo's dev
       red-box — because, unlike RET-006's `purchase/[id].tsx` `ResalePanel.share()` (which already wraps
       its own identical `Share.share()` call in try/catch), this one had no error handling at all. Fixed by
       wrapping it the same way; re-verified live that clicking it no longer crashes and the binder stays
       visible.
    - **AsyncStorage plaintext-at-rest — was an accidental gap in this doc, now a documented, deliberate
      tradeoff.** The original "Offline-capable" bullet above justified AsyncStorage over `expo-secure-store`
      on *size* grounds but never stated the actual security consequence: AsyncStorage has no at-rest
      encryption of its own, so the cached household roster/VINs/addresses/medications sit in plaintext in
      the app's local storage file (SQLite on Android, a plist/RocksDB file on iOS), protected only by the
      OS's own device-level encryption when locked — nothing Veynlo adds on top. This is now spelled out
      explicitly in `emergency-binder-cache.ts`'s own doc comment as a deliberate tradeoff (the whole point
      of this cache is being readable *offline*, in an emergency, when the server can't be reached to
      decrypt anything — an encrypted-at-rest cache would need a key that either sits right next to the
      ciphertext or requires the same round trip this cache exists to avoid), not an oversight.
    - Regression coverage: no mobile component-test infrastructure exists in this repo (confirmed — no
      `*.test.tsx` anywhere under `apps/mobile`, matching this codebase's established convention of
      real-DB/backend tests plus live Playwright verification rather than RN component unit tests), so these
      four fixes are covered by `pnpm --filter @veynlo/mobile run typecheck`/`eslint` passing clean plus live
      Playwright re-verification: full unlock flow (wrong password → `Incorrect password.`, no data shown;
      correct password → real vehicle/property/VIN created via the API render correctly) on web at 1280×900
      and 390×844 and the Expo web preview at 390×844, and the fixed Share button confirmed not to crash on
      the Expo web preview. The existing `emergency-binder.household-scope.test.ts` (7 real-DB cases) was
      re-run and still passes unmodified — none of these four fixes touch the code it covers.

- **Documents mobile detail view** — `apps/mobile/app/documents.tsx` used to only open the raw file
  externally (`Linking.openURL`), with no in-app screen for OCR'd/extracted text. Added `GET
  /v1/documents/:id` (`DocumentsService.documentDetail`, same owner/household/grant access-check shape as
  the existing `signedUrl` method) returning metadata plus the current version's `ocrText`/`ocrConfidence`,
  and a new pushed screen `apps/mobile/app/document/[id].tsx` (title, document type, sharing/processing
  badges, a scrollable monospace block for the extracted text, a graceful "No extracted text yet" message
  when OCR hasn't run or found nothing, and an "Open original file" button that keeps the existing external-
  open capability). The documents list now navigates here on tap while the "Open" button stays as a direct
  external-open shortcut. Web has no document detail page either (confirmed via `apps/web/src/app/(app)/
  documents/page.tsx`) — this was mobile-only work per the identified gap, not a pre-existing web feature to
  mirror. Verified live via Playwright (`expo start --web`, 390×844): signed up, uploaded a `.txt` file
  (which `DocumentsService.upload` extracts synchronously, no AI call needed for plain text), tapped into
  the new screen, confirmed the uploaded text rendered verbatim with a confidence line and no console
  errors. `ANTHROPIC_API_KEY` is blank in this dev environment (same credential gap as every other AI-
  powered feature — see the top of this file), so OCR for images/PDFs doesn't run here; confirmed via code
  read that `DocumentsService.processOcr` leaves `ocrText: null` on a failed/skipped extraction and the new
  screen's fallback branch renders "No extracted text yet" rather than crashing in that case.
- **RET-004 (price-adjustment opportunity) and RET-006 (resale handoff)** — previously named, entitlement-
  gated Phase 2 spec sections with no schema, service, or UI at all; the spec gives each only a name and a
  one-line purpose, not enough to build against blindly. Built to a deliberately conservative, explicitly
  scoped-down design rather than guessing at the full intent:
  - **RET-004** extends the existing `price_observations` mechanism (previously only used for subscription
    price-change detection, spec SUB-003, in `IngestionService.extractSubscription`) to purchases.
    `IngestionService.extractReceipt`'s
    new-purchase-line path (`findMostRecentPriorPurchaseLine`) now checks, for every line item on a newly
    filed purchase, whether the user bought the exact same product before (normalized `productLabel` match,
    same encrypted-column "fetch owner-scoped candidates, compare decrypted values in application code"
    pattern `findMatchingPurchaseLine` already used) at a HIGHER price, with that earlier purchase within a
    flat 30-day-from-original-purchase-date window — a deliberately simple heuristic documented inline as
    such, not a real per-merchant policy lookup (no such data source exists). A match writes a
    `price_observations` row (`subjectEntityId` = the original, more expensive purchase line's own id) and
    files a `price_adjustment` inbox item ("The price of X dropped from $Y to $Z since you bought it on
    [date] — you may be eligible for a price adjustment", actions `["view_purchase", "dismiss"]`). Veynlo
    does not file the claim itself — no merchant API integration exists or was attempted. Scoped to the
    "bought the same real-world item twice" case (duplicate purchase, a gift, buying for someone else) only;
    the spec's other plausible trigger — a merchant marketing/sale email mentioning a product the user
    already owns — would need reading non-receipt marketing email content the way no extractor here
    currently does, so it's a deferred stretch case, not attempted blind. Surfaced on the purchase detail
    page (web `life/purchases/[id]`, mobile `purchase/[id]`) as a warning-toned banner next to the
    affected line item, same tone/placement pattern as RET-003's "Refund received" badge. Covered by two
    real-DB tests in `ingestion.dedup.test.ts` (fires within the window and when cheaper; does not fire
    outside the window or when not actually cheaper) plus a `CommerceService` read-back test
    (`commerce.resale-and-price-adjustment.test.ts`).
  - **RET-006** adds a `purchaseLines.resaleStatus` column (`"not_listed" | "listed" | "sold"`, migration
    `0031_clean_pandemic.sql`) — the one piece of state this feature persists, patchable via the existing
    `PUT /v1/purchases/lines/:id`. A "List for resale" panel on the same purchase detail pages generates a
    resale listing draft (title from `productLabel`; description combining merchant, purchase date, and a
    free-text condition field defaulting to "Used, working condition") and hands it off via the platform's
    native share capability — web `navigator.share` with a copy-to-clipboard fallback for browsers without
    it, mobile React Native's `Share.share()` (no prior in-app precedent for the OS share sheet existed to
    mirror; the "Share" button elsewhere in the app is object-sharing/grants, not the share sheet).
    Deliberately NOT a marketplace API integration — eBay/Facebook Marketplace/Craigslist all require paid
    partner agreements, correctly out of scope — this only pre-fills a block of text the user pastes into
    whatever marketplace app they choose. No photo attachment: purchases have no existing document-linking
    mechanism to draw from, and building new photo-upload infrastructure for this one feature was
    explicitly out of scope for this pass. No buyer/transaction tracking — a real marketplace feature this
    app correctly doesn't need to replicate.
  - Live-verified visually (Playwright, 1280×900 and 390×844): the RET-004 warning-toned banner on a
    purchase with a genuine price drop, the RET-006 panel opening with its default condition and a
    live-updating draft preview as the condition is edited, and the `not_listed` → `listed` → `sold`
    round trip actually persisting (each state re-fetched from the backend, not just local UI state).
    Done against a temporary same-shape mock of the two endpoints these pages call
    (`GET/PUT /v1/purchases/...`) rather than the real API process, because the shared dev API/web
    servers in this environment were mid-recompile on unrelated concurrent work (a CAL-001 write-back
    compile error, and multiple concurrent `next dev` instances corrupting the shared `.next` cache) for
    the entire window this verification needed; the backend logic itself is separately covered by the
    real-DB tests above, which don't depend on either dev server.
  - **Adversarially re-verified in a follow-up audit pass, against the real (not mocked) dev API/web
    servers this time.** Three specific concerns, each checked directly rather than trusted from the
    original build:
    1. **"Most recent prior" vs. "always the first purchase"** — traced `findMostRecentPriorPurchaseLine`
       and confirmed it sorts candidates by `purchaseDateSort` descending and takes index 0, so a THIRD,
       still-cheaper repeat purchase correctly anchors its alert to the *second* purchase, not the first.
       Verified with a new real-DB case in `ingestion.dedup.test.ts` (three purchases at $100 → $80 → $60):
       the second alert's `price_observations` row is anchored to the second line's id, not the first's, and
       the first line never picks up a second, spurious observation.
    2. **30-day window boundary** — `PRICE_ADJUSTMENT_WINDOW_MS` is `30 * 86_400_000` compared with `<=`, so
       a repeat purchase exactly 29 days later fires and one 31 days later does not (confirmed both with a
       new real-DB case). No off-by-one found.
    3. **Encrypted-column matching** — grepped `ingestion.service.ts` for any `eq()`/`where()` clause against
       `purchaseLines.productLabel`; confirmed none exists (all matching is candidate-fetch-then-`.filter()`
       in application code, per `findMostRecentPriorPurchaseLine`'s own doc comment) — the CAL-004-era bug
       class this doc's own convention warns about was not repeated here.
    `resaleStatus` transition validation: confirmed live via curl against `PUT /v1/purchases/lines/:id` that
    a nonsense enum value 400s (`VALIDATION_FAILED`, `ResaleStatusSchema` is a strict 3-value zod enum) and
    that a "backwards" transition (`listed` → `not_listed`) succeeds — a deliberate choice (a user un-listing
    something is legitimate), not an oversight; locked in with a new `commerce/dto.test.ts` covering both
    halves. Playwright re-run against the real dev API/web servers (1280×900, 390×844, and the Expo web
    preview at 390×844, using a real purchase seeded directly in Postgres — `ANTHROPIC_API_KEY` is still
    blank in this dev environment) confirmed the RET-004 banner and RET-006 panel render correctly on all
    three, and that clicking "Share listing" doesn't crash on any platform: web's `navigator.share` branch is
    skipped in headless Chromium (no Web Share API) and correctly falls through to the clipboard fallback
    with the "Copied!" confirmation; mobile's `purchase/[id].tsx` `ResalePanel.share()` already wrapped
    `Share.share()` in try/catch, so react-native-web's synchronous "Share is not supported in this browser"
    throw is caught cleanly with no crash. (Contrast with the emergency binder's own "Share / Print" button,
    which had the identical unguarded-`Share.share()` bug and *did* crash — see that entry below.)
- **AUTO-006 "Undo / compensation" didn't exist** — every reversible action should expose an Undo for a
  defined period; there was no undo endpoint for any automation-executed action. Product decision made and
  built: `notify` is *not* undoable (by the time a run succeeds its notification has already been created/
  delivered — there's no meaningful "un-notify," so it's excluded rather than wired to a no-op button, and
  the reasoning is documented inline at `UNDOABLE_ACTION_KINDS` in `automation.service.ts`); `add_task` and
  `add_calendar_event` are undoable within a fixed 5-minute window after execution (`UNDO_WINDOW_MS`), long
  enough to notice a run that just fired (the automations page's "Recent activity" list already polls every
  15s) without leaving a stale undo option around once the created row may already be in use elsewhere.
  `AutomationService.executeRun` now records the created task/event's id on the run
  (`automation_runs.result_resource_id`, added via migration `0028_majestic_blade.sql`) so
  `AutomationService.undoRun` (`POST /v1/automation/runs/:id/undo`) knows exactly what to delete, then marks
  the run `undone` — a new terminal state alongside `succeeded`/`failed`/`canceled`, reflected in both
  frontends' `RUN_STATE_TONE` maps. An expired window returns a clear `UNDO_WINDOW_EXPIRED` error (never a
  silent no-op); a `notify` run or an already-undone run returns `ACTION_NOT_UNDOABLE`/`RUN_NOT_UNDOABLE`.
  Ownership is enforced by reusing `AutomationService`'s existing `ownedRun` check — the same one
  `approveRun`/`rejectRun` already use — rather than a new access pattern. `GET /v1/automation/runs` now
  also returns a server-computed `canUndo`/`undoExpiresAt` per run (never left for the client to derive from
  a possibly-skewed clock), which both `apps/web/src/app/(app)/automations/page.tsx` and
  `apps/mobile/app/automations.tsx` use to show/hide an "Undo (Xm left)" button on eligible runs in Recent
  activity — verified it actually disappears once the window closes, not just that it appears. Covered by
  five real-DB integration tests in `automation.undo.test.ts`: successful undo of both undoable action
  kinds (task/event row actually deleted, run marked `undone`), rejection of a `notify` undo, rejection past
  the window (via a backdated `updatedAt`), and rejection of a non-owner's attempt. Live-verified via
  Playwright: created a rule, triggered and approved a run, confirmed the Undo button appears, clicked it,
  confirmed the task disappeared and the badge changed to "undone", at both 1280×900 and 390×844.
- **Account emails were case-sensitive everywhere** — a real bug an exhaustive visual+functional audit
  found: sign-up stored whatever case you typed, and sign-in/forgot-password/household-invite-accept/
  document-share-by-email all compared raw strings against it. Signing up as `Foo@Example.com` then
  signing in as `foo@example.com` failed with a false "Incorrect email or password," and the same address
  could be registered twice with different casing as two unrelated accounts. Fixed with a shared
  `NormalizedEmailSchema` (trim + lowercase) applied to every account-identifying DTO across identity,
  household, documents, and admin. Covered by `normalized-email.test.ts` and a real DB integration test
  (`identity.email-case.test.ts`); live-verified end to end via curl.
- **The shared `Switch` component rendered its thumb outside its own track (and outside whatever card it
  sat in) whenever toggled on** — found via a deliberately much stricter visual re-inspection after you
  called out that a screenshot showed an obviously broken toggle. Root cause: the thumb had no explicit
  `left` position, so its base position fell back to the browser's "auto" static-position algorithm, which
  didn't reliably resolve to 0 — the `translate-x` meant to move it a further 18px compounded on top of
  that unpredictable base, pushing it visibly past the button and the card border. This affected every
  toggle in the entire app (settings, notifications, privacy, household, automations), which is almost
  certainly what was behind "the styling is messed up 99% of the time." Fixed with one explicit `left-0`
  in `apps/web/src/components/ui/switch.tsx`; verified via precise `getBoundingClientRect` measurements
  before/after plus zoomed-in screenshots on multiple pages.
- **FAM-003 "Assignment has acceptance/decline/complete" had no acceptance/decline** — `tasks.assignedToUserId`
  was a plain reassignment field. Added a real `assignmentStatus` lifecycle (unassigned → pending →
  accepted/declined) plus `assignmentNotes`, new `POST /v1/tasks/:id/accept`/`/decline` endpoints, an
  assignee notification on assignment and an owner notification on decline, and Accept/Decline controls
  on both web and mobile's Reminders sections. Covered by `schedule.assignment.test.ts`; live-verified via
  Playwright (a real cross-account assignment, accept, and the resulting "Done" state).
- **AUTO-010 "Automation kill switch" didn't exist** — added an account-wide pause toggle
  (`notification_preferences.automations_paused_at`) checked before any rule can even match in
  `AutomationService.evaluateEvent`, plus `GET`/`PUT /v1/automation/kill-switch` and a "Pause all
  automations" switch on both web and mobile automations screens. Covered by a real DB test; live-verified
  via curl and Playwright.
- **RET-003 "detect whether promised refund actually arrived" was unimplemented** — `return_cases.refundObservedTransactionId`
  was a reserved-but-dead schema column (same pattern `packages/authz` and the Lists tables turned out to
  be). `PlaidAdapter.matchTransaction` now also matches an incoming refund (negative-amount) bank
  transaction against open return cases by amount, recording the link on both sides (new
  `financial_transactions.matchedReturnCaseId` + the existing `refundObservedTransactionId`). Surfaced as
  a "Refund received" badge on both web and mobile's return-case detail screens. Covered by an extended
  `plaid.adapter.test.ts`; live-verified visually.
- **FAM-006 caregiver delegation grants had no time-bound UI, and the web grant form was missing the
  "Lists" scope entirely** — the backend already supported `expiresAt` and `lists:read` (added earlier
  this pass for the new Lists feature), but the household settings page's local scope list was never
  updated and the grant form only offered "until revoked." Added a "Lists" toggle and an optional
  expiration date picker to `settings/household/page.tsx`, plus showing the expiration (or "Until
  revoked") on each active grant. Live-verified end to end: granted "Lists" access with a 7-day
  expiration, confirmed it displays correctly and revokes correctly.
- **`evidenceRefs` table never written to** — now fixed. `IngestionService`'s purchase-line-asset and
  warranty-expiration facts (`extractReceipt`/`extractWarranty`) each create a real `evidence_refs` row
  citing the source email, and the new Entities pages (`/entities`) display it under "Why". Covered by a
  real DB test (`ingestion.evidence.test.ts`).
- **Object sharing was web-only** — now on mobile too (`apps/mobile/app/documents.tsx`'s
  `ShareDocumentPanel`), same grants/passcode-linked-share-link flow as web.
- **CAL-004 "Reschedule reconciliation" only worked for provider-synced calendars, not discovered
  events** — `IngestionService.extractCalendarEvent` (the AI path that turns an appointment/reservation
  email into a calendar event) had zero dedup logic, unlike every other extractor in that file. A second
  email about the same appointment (a reminder, or a genuine reschedule notice) always inserted a sibling
  event instead of updating the existing one, silently duplicating the user's calendar. Fixed with a new
  `findExistingDiscoveredCalendarEvent` (exact-normalized-title match against the owner's still-upcoming
  `discovered_from_evidence` events, "more than one candidate → treat as no match", same precision-first
  stance as `findExistingBill`/`findMatchingPurchaseLine`) — a match now updates the row's date/time/
  location in place instead of inserting a duplicate. Provider-synced events (Google/Microsoft/ICS) were
  already correctly deduped by `providerEventId` and are untouched by this change. Covered by two new
  real-DB tests in `ingestion.dedup.test.ts`.
- **Object sharing (grants/share-links) was document-only, not generic** — `resourceGrants`/`shareLinks`
  were polymorphic in schema (`resourceType`/`resourceId`, a generic index on the pair) but every real
  write site hardcoded `resourceType: "document"`; lists, purchases, properties, and vehicles had no
  sharing/grant/link capability at all despite the tables being built to support it. Fixed by extracting
  the token/passcode/grant mechanics out of `DocumentsService` into a new, resource-agnostic
  `SharingService` (`services/api/src/modules/sharing/`) that DocumentsService, ListsService,
  CommerceService, and AssetsService all now call — each keeps its own ownership check and any
  resource-specific gate (documents/properties/vehicles block a public link on `sensitivity: "highly_
  sensitive"/"secret"`; lists/purchases have no sensitivity column, so no such gate applies to them).
  New endpoints mirror documents' exact shape: `POST/GET :collection/:id/grants`, `DELETE :collection/
  grants/:grantId`, `POST/GET :collection/:id/share-links`, `DELETE :collection/share-links/:linkId` for
  `/v1/lists`, `/v1/purchases`, `/v1/properties`, and `/v1/vehicles`. Each resource's own access-check
  helper (`ListsService.assertListAccess`, `CommerceService.assertCommerceAccess` for purchases,
  `AssetsService.assertAssetAccess` for properties/vehicles) now also honors a direct `resourceGrants` row
  for that specific id, same as documents' `signedUrl`/`documentDetail` already did — and each resource's
  own list()-shaped method (`listLists`, `purchases`, `listProperties`, `listVehicles`) now OR's granted
  ids in alongside owner/household visibility, mirroring `DocumentsService.list`'s original shape.
  The public, unauthenticated redemption path (`GET/POST /v1/share/:token/access`, previously baked into
  `DocumentsService.accessShareLink`) is now `SharingService.resolveShareLink` (generic token/passcode
  validation, unchanged security properties — see that method's own doc comment) plus a new
  `PublicShareService` that dispatches the resolved `resourceType` to the owning service's own
  `publicShareContent`/`publicPropertyContent`/`publicVehicleContent` method for a redacted, read-only
  view (deliberately narrower than the authenticated detail view for purchases/properties/vehicles — e.g.
  a purchase's public view omits returns/shipments/evidence, which can carry source-email snippets; a
  vehicle's omits its VIN even when the sensitivity gate already allowed a link). `apps/web/src/app/
  share/[token]/page.tsx` now renders whichever resource type the token resolves to; the old document-only
  `ShareDocumentPanel` (web and mobile) is now a shared `ShareResourcePanel` component parameterized by
  `resourceId`/`collectionPath`, reused on the Lists, Purchases, Properties, and Vehicles detail pages on
  both platforms. No schema migration was needed — `resourceType`/`resourceId` were always plain `text`
  columns with no CHECK constraint restricting their values. Covered by real DB tests mirroring
  `documents.sharing.test.ts`'s structure: `lists.sharing.test.ts`, `commerce.sharing.test.ts` (purchases);
  `documents.sharing.test.ts` itself was updated for the new SharingService split and gained a third case
  covering the sensitivity gate. Live-verified via Playwright: created a list, added a private and a
  public item, generated a share link, and confirmed the public redemption page (both 1280×900 and
  390×844) shows only the public item, read-only, with no Veynlo session.
- **A `pnpm add` side effect**: adding `expo-share-intent` briefly dropped `@veynlo/core` from
  `apps/mobile/package.json`'s dependencies (it had been there since the app was created, unused by any
  current mobile code, but present) — caught and restored before finishing this pass. Flagging it here
  rather than letting it pass silently, since an unreviewed dependency-list rewrite is exactly the kind of
  thing worth surfacing even when the practical impact turned out to be zero.
- **A second `pnpm add` side effect, found the same way**: mid-session, `apps/mobile/package.json`/
  `pnpm-lock.yaml` were briefly caught in an unrelated tooling accident (a stray `git stash` on the shared
  working tree momentarily reverted every uncommitted file in the whole repo back to HEAD, this doc
  included — recovered via `git stash pop` with no work lost, but the recovery left `@react-native-async-
  storage/async-storage` present in the lockfile without its `package.json` dependency line, presumably
  from other concurrent work). Restored the dependency line and re-ran `pnpm install` to confirm the
  lockfile and package.json agree. Flagging it for the same reason as the bullet above.
- **CAL-001 "write-back capability" — built.** `google-calendar.adapter.ts`/`microsoft-calendar.adapter.ts`
  gained real `createEvent`/`updateEvent` methods (Google `calendar.events.insert`/`.patch`; Microsoft Graph
  `POST`/`PATCH /me/events`), reusing the exact same `client(connectionId)`/`graphRequest` OAuth/credential-
  refresh machinery `initialSync` already relied on — no new auth code path. A new `connections.
  write_back_enabled` boolean (migration `0032_huge_namor.sql`) is **off by default on every connection**,
  matching the spec's "requested only when user enables write-back" consent model; `ConnectorsService.
  setWriteBack` refuses to turn it on unless the connection's stored `scopes` already contain the provider's
  write scope (`https://www.googleapis.com/auth/calendar` for Google, `Calendars.ReadWrite` for Microsoft),
  throwing `WRITE_SCOPE_REQUIRED` otherwise — since every calendar connection made before this feature
  existed only ever requested the readonly scope. The client-side fix for that is a real reconnect flow, not
  just a "coming soon" dead end: `GET .../authorize?writeBack=true&reconnectId=<id>` requests the broader
  scope (Google via `include_granted_scopes: true` incremental auth; Microsoft by requesting the union scope
  directly) and, via a new `reauthConnectionId`/`writeBack` pair signed into the existing OAuth `state` JWT
  (the same "state is the trust boundary, not client-supplied query params" pattern the platform-aware
  redirect already used), `handleCallback` rotates the *existing* connection's credentials/scopes in place
  instead of inserting a duplicate connection row. New `CalendarWriteBackService` (`services/api/src/
  modules/connectors/calendar-write-back.service.ts`) owns the actual push: decides create-vs-update by
  whether the event already has a `writeBackConnectionId`/`providerEventId` for that connection, and — this
  was explicitly called out in the build brief — **a provider-side failure is logged and flags
  `calendarEvents.writeBackStatus = "failed"`, it is never thrown and never touches/loses the local event**.
  Wired into two real entry points: `POST /v1/calendar-events/:id/push` (manual push, e.g. right after
  creating an event via `ScheduleService.createEvent`) and `InboxService.addToCalendar` (the CAL-002
  destination choice below), plus `InboxService.correctCalendarEvent` now re-pushes an already-synced
  event's corrections automatically. UI: a "Write new events back to this calendar" switch on every Google/
  Microsoft Calendar connection card (web `connections/page.tsx`, mobile `connections.tsx`, both using the
  existing `Switch` component) that transparently kicks off the reconnect flow above when the scope isn't
  there yet; a "Sync to a connected calendar" card on the event detail page (web `life/events/[id]/page.tsx`,
  mobile `event/[id].tsx`) showing push status and a manual "Push" button. Real DB tests, no mocked
  `googleapis`/Graph HTTP — a fake adapter object standing in for "the real provider call succeeded/failed"
  proves `CalendarWriteBackService`'s own logic (`calendar-write-back.service.test.ts`: never calls the
  adapter when write-back is off; a simulated provider failure never corrupts the local event; a second push
  to the same connection updates instead of duplicating) and `ConnectorsService.setWriteBack`'s scope gate
  (`connectors.write-back-toggle.test.ts`). **What can't be proven here**: an actual Google/Microsoft user
  clicking through the real write-scope consent screen — see the new credentials-section bullet above.
  Live-verified as far as possible without that: signed up a real user via Playwright, inserted a write-
  back-enabled `google_calendar` connection directly (standing in for a completed reconnect, since this dev
  environment has no real Google OAuth app), created a manual event with `POST /v1/events`, confirmed the
  toggle and the "Sync to a connected calendar" card both render correctly, then clicked "Push" for real —
  it correctly failed closed against the real (unconfigured) Google adapter, set `writeBackStatus:
  "failed"`, left the event's title/location/etc. completely intact, and the UI showed "The last sync
  attempt didn't go through — this event is still saved in Veynlo" rather than an unhandled error.
- **CAL-002 "offers Add to calendar with chosen destination and reminder defaults" — built.** Two real gaps
  closed:
  1. **Reminder defaults.** `calendarEvents` had no lead-time/notification field at all. Added
     `reminderMinutesBefore` (nullable integer, migration `0032_huge_namor.sql`) — null means "use the
     default for this event," computed once by a single shared `defaultReminderMinutes(isAllDay)` helper
     (`ingestion/temporal.util.ts`: 60 minutes for a timed event, 1440/one day for all-day) so every writer
     (`IngestionService.extractCalendarEvent`/`ingestFeedCalendarEvent`, `ScheduleService.createEvent`,
     `AutomationService`'s `add_calendar_event` action) can't drift from each other. The actual reminder-
     producing consumer was the real gap: `AttentionService.scanAndFileDeadlines` (already the writer behind
     bill/return/warranty/trial deadlines on the Home "Needs You" queue) gained a new calendar-event block —
     files an `event_reminder` attention item once `now` crosses the event's own lead time, with its own
     minutes/hours/days wording (`relativeTimeText`) rather than reusing the existing `daysUntil` helper,
     since a 60-minute lead time would render as a useless "in 0 days" otherwise. A user can set/edit the
     lead time on both platforms — a "Remind me" picker on the event detail page (`PUT /v1/events/:id/
     reminder`, new `ScheduleService.setEventReminder`) and inline in the destination-choice flow below.
  2. **Destination choice.** Previously a discovered appointment auto-inserted into `calendar_events` and
     filed an inbox item whose `"add_to_calendar"` suggestedAction did nothing beyond what `"confirm"`
     already did (confirmed via grep of `InboxService`/`AttentionController` — no handler for it existed).
     This app has no multi-calendar-per-user concept beyond the single `calendar_events` table (confirmed
     before building — no "calendars" table, no per-list concept for events the way Lists has for saved
     items), so "destination" realistically means: keep the already-real local event in Life Inbox only, or
     also push it to a specific write-back-enabled connected calendar. New `InboxService.addToCalendar`
     (`POST /v1/inbox/:id/add-to-calendar`) does exactly that — `destinationConnectionId: null` never calls
     `CalendarWriteBackService` at all, a real connection id does — then confirms the item either way (a
     provider failure during push still confirms; see CAL-001's "never lose the local event" stance above).
     A real destination-picker UI on both platforms: the Inbox page's existing "Confirm"/"Correct"/"Snooze"/
     "Archive"/"Dismiss" row gains an "Add to calendar" button (only for `linkedResourceType ===
     "calendar_event"` items) that opens an inline picker — a destination `<select>` plus the same reminder
     picker as the event detail page on web, a row of chip-style buttons on mobile (no native `<select>`).
     Deliberately did not rearchitect discovery into a "pending, not yet committed" model (the event already
     existing locally the instant it's discovered is arguably better UX, and changing it risked destabilizing
     the reschedule-reconciliation dedup logic (`findExistingDiscoveredCalendarEvent`) other work in this
     session depends on) — "destination choice" is additive on top of the existing auto-file, not a
     replacement for it.
  Real DB tests, no AI/network mocking needed since neither path calls a model or a provider directly:
  `attention.event-reminder.test.ts` (5 cases — fires within lead time, doesn't fire yet, defaults correctly
  when null, never fires for a cancelled event, never duplicates on a re-scan) and `inbox.add-to-
  calendar.test.ts` (4 cases — "Life Inbox only" never calls the pusher, a real destination does with the
  right args, confirms the item even when the push itself fails, rejects a non-calendar-event item). Live-
  verified visually (Playwright, 1280×900 and 390×844): the Connections page toggle, the event detail page's
  "Remind me"/"Sync to a connected calendar" cards (rendering correctly alongside the concurrent TASK-003
  recurrence work's own "Recurrence" card on the same page — confirmed no layout collision), and the
  Connections/Inbox empty states. The Inbox destination-picker UI itself wasn't screenshotted with a real
  discovered item in it — `ANTHROPIC_API_KEY` is blank in this dev environment (same gap as every other AI
  extraction), so no real discovered `calendar_event` inbox item could be produced to click through; the
  picker's logic is covered by the real-DB test above instead.
- **A `git stash` accident affecting the whole shared working tree, and its recovery.** Mid-session, while
  another agent's concurrent edits and this pass's own work were both mid-flight uncommitted, something ran
  a plain `git stash` against the shared repo working tree — which reverts every TRACKED file's uncommitted
  changes back to `HEAD` (untracked new files are unaffected by a plain `git stash`, which is why this
  wasn't total loss). Caught immediately via the "file changed on disk" tool warnings suddenly showing
  pre-Phase-2 file contents; recovered with `git stash pop`, which hit two second-order conflicts from
  edits that landed in the brief window between the accidental stash and the recovery
  (`packages/db/src/schema/automation.ts`, identical content — just checked out to `HEAD` and let the pop
  reapply it cleanly; `apps/mobile/package.json`/`pnpm-lock.yaml` — see the dependency bullet above) —
  resolved without discarding anything, then verified nothing was lost by re-running the full API test
  suite (all passed) and re-diffing the schema files against what this pass and the concurrent TASK-003/
  CAL-003 work both expected to be there. Flagging this prominently since it's exactly the kind of silent
  data-loss risk this document's own "flag it, don't let it pass silently" convention exists for — no actual
  work was lost, but it easily could have been.
- **Adversarial audit of AUTO-006 (undo) x AUTO-010 (kill switch) x CAL-003/CAL-001 (concurrent calendar
  work) found two real, verified bugs in `AutomationService`, both fixed with regression tests; everything
  else tested held up.** Real dev Postgres + real running API/web/Expo-web servers throughout, not mocks.
  - **Kill switch didn't block execution of a run that was already `approval_required` before the pause —
    only new rule matches.** `evaluateEvent` checks `automationsPausedAt` before a rule can match (so a
    paused account creates zero *new* runs), but `approveRun` never checked it at all. Live-reproduced: sat
    a run in `approval_required`, flipped the kill switch on via `PUT /v1/automation/kill-switch`, called
    `POST /v1/automation/runs/:id/approve` — it executed anyway (`state` went straight to `succeeded`, a real
    `calendar_events` row got created) with the kill switch still on. Directly contradicts AUTO-010's "pause
    all automation actions immediately." Fixed: `approveRun` now checks `getKillSwitchStatus` before doing
    anything and throws `AUTOMATIONS_PAUSED` (leaving the run untouched, still `approval_required`, so
    approving again works once unpaused) — re-verified live the same way, now blocked, then re-verified it
    goes through immediately after unpausing. New test in `automation.service.test.ts`. Also fixed the two
    frontend `approveRun`/`rejectRun` handlers on `apps/web/src/app/(app)/automations/page.tsx`, which had no
    try/catch at all (unlike `undoRun` on the same page, and unlike every handler on the mobile equivalent) —
    before this pass that was latent since approve essentially never failed; this fix makes `AUTOMATIONS_
    PAUSED` a real, reachable rejection, so a bare unhandled-promise-rejection on click needed fixing too.
  - **`undoRun` had no concurrency guard — two near-simultaneous undo requests for the same run both
    "succeeded" instead of one winning cleanly.** Reproduced directly (not inferred): 5-way concurrent
    `Promise.allSettled` calls to `undoRun` on the same freshly-succeeded run, 15 trials — 14/15 trials had
    all 5 calls report success (only 1/15 landed the "expected" single-winner outcome by sheer timing luck).
    Root cause: `undoRun` read `run.state`, checked it in memory, then did an unconditional delete + update —
    no transaction, no conditional write, so every concurrent caller that read the same "succeeded" snapshot
    passed every check independently. Not exploitable as data corruption today (`DELETE ... WHERE id = X` and
    the state `UPDATE` are both naturally idempotent, so a double-undo doesn't crash or double-delete
    anything real), but it is exactly the missing guard a future *non-idempotent* undo (a provider-side
    refund call, a write-back deletion — see the new deferred item below) could not tolerate, and today it
    already means a client can get multiple "undo succeeded" responses for one run. Fixed: the state flip to
    `undone` is now a single conditional `UPDATE ... WHERE id = $1 AND state = 'succeeded' RETURNING id` —
    only the caller whose UPDATE actually matches a row (necessarily just one, by Postgres's own row-level
    write serialization) proceeds to delete the task/event; every other concurrent or already-undone caller
    gets zero returned rows and the same `RUN_NOT_UNDOABLE` a plain re-undo already returned. Re-ran the same
    15-trial harness after the fix: 15/15 exactly one winner. New test in `automation.undo.test.ts`.
  - **Also specifically checked and found correct, no fix needed:** the 5-minute undo window's boundary
    (verified allowed 2s before expiry, rejected 2s after, both via a real backdated `updated_at`); non-owner
    undo (real cross-account HTTP call, real `403`-shaped rejection via the existing `ownedRun` check, not a
    mocked one); that undoing a real `add_calendar_event` run actually deletes the `calendar_events` row and
    leaves zero orphaned `schedule_conflicts` rows — confirmed this is because `AutomationService.executeRun`
    inserts calendar events by writing `calendar_events` directly rather than going through `ScheduleService.
    createEvent`, so an automation-created event is never run through `ConflictService.detectOverlaps` in the
    first place (see the new deferred item below); undo through the live API, live UI (Playwright, both
    1280×900 web and 390×844 Expo mobile web — approve via the real button, watch the "Undo (Xm left)"
    countdown, click it, confirm the task/event actually vanishes from `/life`'s tasks/events lists, not just
    the automations page's own activity feed).

- **Round 4 (browser extension ↔ API ↔ web integration audit): signing out of the browser extension never
  actually revoked the session server-side.** Found live via Playwright driving a real `launchPersistentContext`
  with the unpacked extension loaded, signed into a real account, then re-testing the exact bearer token the
  popup had just "signed out" with directly against `GET /v1/auth/me` — it still returned `200`, not `401`.
  Root cause: `apps/browser-extension/public/popup/popup.js`'s shared `apiFetch()` helper unconditionally set
  `content-type: application/json` on every request, including the sign-out button's bodyless
  `POST /v1/auth/sign-out`. Fastify's default JSON body parser rejects any request that declares that content
  type with an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`, "Body cannot be empty when content-type is set to
  'application/json'") before the request ever reaches `AuthGuard` or `IdentityController.signOut` — so the
  call 400'd server-side every time. The popup's own `.catch(() => {})` around that call swallowed the failure
  (`fetch()` only rejects on a network error, never on a 4xx/5xx HTTP response), so the UI still cleared its
  local token and rendered the signed-out view, masking the fact that the session itself was never touched:
  the same bearer token kept working against the API indefinitely (until natural 2-week expiry), exactly the
  "session revocation" seam this round was asked to check, since a round-2 fix already made suspension/
  revocation real everywhere else. `apps/web/src/lib/api-client.ts` and `apps/mobile/src/lib/api-client.ts`
  both already guard this exact Fastify quirk correctly (`...(init?.body ? {"Content-Type": ...} : {})`) — the
  extension's separate, newer `apiFetch` implementation just hadn't followed the same defensive pattern. Fixed
  by making it conditional the same way. Re-verified live end-to-end after the fix: the sign-out network
  response is now `201` (not `400`), and the pre-sign-out bearer token now correctly gets `401` from
  `/v1/auth/me` afterward. No unit-level regression test was added for this specific failure mode — it's an
  HTTP-framework body-parsing interaction that only manifests through the actual Fastify request pipeline, and
  every existing test in `services/api/src` calls services directly against Postgres rather than going through
  an HTTP-injection layer (no `supertest`/`app.inject()` usage anywhere in this suite), so this class of bug
  isn't reachable by this codebase's current test conventions without first adding that kind of harness.
  Also confirmed clean in the same audit pass (no fix needed): a list item added via the extension's "Quick
  list" action is visible, with identical sharing/grant behavior, to a second account granted access via
  `POST /v1/lists/:id/grants` — `lists.controller.ts`/`memories`/`ingestion` controllers have zero
  platform-specific branching, so extension-originated writes go through the exact same code path as web/
  mobile by construction; a page saved via "Save to Saved" and an item added via "Quick list" both showed up
  correctly on the real web app's `/saved` and `/lists/:id` pages for the same signed-in account (checked in a
  separate, non-extension browser context, not just the extension's own UI).

- **CAL-001's "duplicate copies visually collapse while preserving originals" — built.** Previously
  documented as not built (a real appointment discovered independently as BOTH a provider-synced calendar
  event and a separately-discovered email produced two permanent, never-linked `calendar_events` rows,
  each shown as its own list item forever). Built as a genuine cross-source LINK, never a merge:
  - New nullable, non-FK `calendarEvents.linkedEventId` column (`packages/db/src/schema/schedule.ts`,
    migration `0041_ambitious_vampiro.sql`) — same "same-table lineage pointer, no `.references()`"
    precedent as `merchants.mergedIntoMerchantId`. Set on the SECOND of a linked pair to arrive, pointing at
    the FIRST; the first row's own `linkedEventId` stays null, so a group's "leader" is always
    `linkedEventId ?? id`. Neither row is ever mutated beyond that one column — both keep their own
    independent `title`/`start`/`location`/evidence forever.
  - `IngestionService.findCrossSourceCalendarEventMatch` (`services/api/src/modules/ingestion/
    ingestion.service.ts`) — called from each of `extractCalendarEvent`'s and `ingestFeedCalendarEvent`'s own
    "insert a new row" branch (never the "update existing" branch — an event already matched within its own
    kind isn't a first-time arrival of the other kind). Matches same-owner, same-`"discovered_from_evidence"`-
    source candidates of the OPPOSITE kind — `providerEventId` nullness is what actually distinguishes a
    provider/device sync from an email discovery, since both kinds already shared that one `source` string
    (confirmed via grep before this pass) — within a ±3 hour window of the new event's own start time, with
    an EXACT normalized-title match (trim + lowercase, no fuzzy/substring matching) and "more than one
    candidate → treat as no match," the same precision-first discipline as every other dedup helper in this
    file (`findExistingBill`, `findExistingPurchaseByAmountAndDate`, `findExistingDiscoveredCalendarEvent`).
    A false-positive link (two genuinely different appointments joined) is strictly worse than a missed one.
  - Fixed one adjacent, pre-existing bug found while building this: `findExistingDiscoveredCalendarEvent`'s
    own candidate query never filtered on `providerEventId`, so — despite its call site's comment claiming
    provider-synced events were "out of scope" — a provider sync sharing the same `"discovered_from_evidence"`
    source and matching title/window could have been silently reschedule-reconciled (fields overwritten in
    place) by an unrelated later email, rather than being cross-source LINKED as a separate, preserved
    record. Now scoped to `providerEventId IS NULL` candidates only, making that comment's claim true and
    routing the actual cross-source case to the new link path instead.
  - UI (`apps/web/src/app/(app)/life/page.tsx`'s Appointments section and
    `life/events/[id]/page.tsx`; `apps/mobile/app/(tabs)/life.tsx` and `app/event/[id].tsx`) — a
    cross-source-linked pair collapses into ONE list card with a "N sources" badge; tapping it expands an
    inline disclosure listing each underlying record ("Discovered from email" vs. "Synced calendar") by
    title, still individually tappable through to that record's own detail page. The detail page adds an
    "Other sources for this appointment" card listing the other linked record(s) in full, each with its own
    evidence citation (`ScheduleService.eventDetail`'s new `linkedCalendarEventGroup`, resolved via the same
    `evidenceViaInboxItem` indirection the primary event already used) — nothing is ever hidden, deleted, or
    merged. `ScheduleService.upcomingEvents` does the list-level grouping itself (a lean projection with no
    per-member evidence join, to avoid an N+1 query on every list row) via a new `groupLinkedCalendarEvents`
    helper, backfilling the "leader" row from a second query when it's fallen outside the `startSort >= now`
    window the list endpoint itself filters on (e.g. the earlier-created member's start time has already
    passed while its linked duplicate's hasn't).
  - One known, honestly-scoped caveat: `extractCalendarEvent`'s own temporal conversion
    (`toTemporalValue`/`temporal.util.ts`) already discarded the model's separately-extracted `startTime`
    field for every email-discovered event, before this pass and unrelated to it (confirmed via grep — no
    caller ever passed it through) — so a discovered event's `startSort` always lands at UTC midnight of its
    date, never its real time of day. This pass's ±3h window therefore only actually catches a timed
    appointment's provider-synced counterpart when its real UTC instant happens to fall within 3 hours of
    that midnight (true for many real timezones, and always true for all-day events on both sides) — a full
    fix needs a timezone-aware wall-clock-to-UTC conversion this codebase has nowhere else either, which
    would be inventing a new time-conversion primitive as a side effect of this pass rather than fixing the
    diagnosed CAL-001 gap, so it's left as a documented follow-up rather than rushed in here.
  - Tested: 4 new real-Postgres integration cases in
    `services/api/src/modules/ingestion/ingestion.calendar-cross-source-link.test.ts` (forward order — email
    discovered, then provider-synced — links correctly with both rows independently readable; the reverse
    ordering also links correctly; two genuinely different same-titled events more than 3 hours apart do NOT
    link; two ambiguous same-window/same-title candidates do NOT auto-link, matching the "more than one
    candidate → no match" convention). All passing, plus the full existing `ingestion`/`schedule` suites
    (`npx vitest run --no-file-parallelism`) re-run clean except one pre-existing failure unrelated to this
    work (`ingestion.dedup.test.ts`'s reschedule-reconciliation case, broken by a concurrently-built CAL-004
    trusted-rule feature changing that code path's behavior — not touched here, flagged for whoever owns
    that pass).
  - Live-verified via a real Playwright browser session (seeded through the real `IngestionService` +
    `FakeModelProvider`, this codebase's established test pattern, against the real dev Postgres) at both
    1280×900 and 390×844 on web and 390×844 on the mobile Expo web preview: a genuine cross-source duplicate
    pair ("Dr. Chen Annual Physical," one discovered from a confirmation email, one synced from a connected
    Google Calendar with a different location string) rendered as ONE collapsed card with a working "2
    sources" disclosure on both apps, while an unrelated third event ("Quarterly Budget Review") correctly
    stayed its own separate card; tapping through from the disclosure to each underlying record's own detail
    page showed its own independent data plus an "Other sources" card citing the other record's own evidence.
    All seeded test data cleaned up afterward.

## Independent requirements re-audit (this pass) — corrected ratings

A follow-up pass independently re-verified the 9 items above against the spec's own §13/§16/§34/§35 text
(not just the "Fixed this pass" bullets' own self-reported claims), by reading the actual code and running
the real-DB test suites against the live dev Postgres. Two items hold up fully as claimed; several others
are real and tested but narrower than the spec's full text — recorded precisely below rather than left as
a blanket ✅. One small, cleanly-scoped gap (SHARE-001's missing grant expiration) was fixed directly in
this pass, with a new regression test; the rest are documented, not built, per this doc's own "small fix
now, large gap documented" convention.

- **CAL-001 "Unified calendar projection" — ✅ (with one documented precision caveat).** Write-back
  (create/update against Google/Microsoft, off by default, scope-gated, fails closed) is real and matches
  the spec's permissions language. The spec's own UX line — **"Duplicate copies can visually collapse while
  preserving original records"** — is now built too (see "Fixed this pass"): `IngestionService.
  findCrossSourceCalendarEventMatch` links a provider-synced event to an already-discovered email copy of
  the same real appointment (or vice versa) via a new `linkedEventId` column, using an exact-title/±3h-
  window/no-ambiguous-match precision discipline; `ScheduleService.upcomingEvents`/`eventDetail` group a
  linked pair into one card/"Other sources" disclosure without ever merging or deleting either row. The one
  caveat carried forward honestly rather than glossed over: `extractCalendarEvent`'s own temporal conversion
  discards the model's extracted time-of-day for every email-discovered event (a separate, pre-existing gap
  this pass didn't fix — see that entry's own caveat for why), so the ±3h window only reliably catches a
  TIMED appointment's cross-source pair when the provider-synced side's real UTC instant happens to land
  within 3 hours of UTC midnight; all-day events and same-day matches near that boundary link correctly
  regardless. Two same-source duplicates (e.g. the same event synced from two different connected
  providers) are still never linked to each other — out of scope by design, since that's a different pairing
  than the one CAL-001's own UX line and this pass's live-verified repro describe.
- **CAL-002 "Discovered-event suggestion" — ✅.** Reminder defaults are genuinely automatic, not
  manual-only: every writer of `calendar_events` (`IngestionService`, `ScheduleService.createEvent`,
  `AutomationService`) sets `reminderMinutesBefore` via one shared `defaultReminderMinutes()` helper (60
  min timed / 1440 min all-day), and `AttentionService.scanAndFileDeadlines` reads
  `event.reminderMinutesBefore ?? defaultReminderMinutes(...)` — a user who never touches the reminder
  picker still gets a reminder. Destination choice (`InboxService.addToCalendar`, "Life Inbox only" vs. a
  specific write-back-enabled connection) is a reasonable reading of "choose calendar/list" given this app
  has no multi-calendar-per-user model at all (confirmed — one `calendar_events` table, no `calendars`
  concept). Verified via `attention.event-reminder.test.ts` and `inbox.add-to-calendar.test.ts` (real DB,
  9 cases, all passing).
- **CAL-003 "Conflict detection" — ⚠️ mostly built (previously ⚠️ partial, only 1 of 5 named types).** A
  follow-up pass closed two more of the gaps this entry originally documented as genuinely unbuilt, plus
  fixed the recurring-event-expansion bug a separate adversarial audit found (see that entry above, now
  marked fixed):
  - **True overlap** (real, tested, live UI banner + resolve action, verified via `conflict.service.test.ts`,
    5 real-DB cases) — now also expands recurring events over a bounded 90-day window
    (`conflict.service.recurring.test.ts`, 5 real-DB cases), where it used to only ever check a recurring
    event's own stored anchor.
  - **Double-booked shared assets** — now built for the one bookable-shared-resource concept this app
    actually has: household vehicles. A calendar event can be tagged "using this vehicle"
    (`calendarEvents.relatedEntityIds`, previously written nowhere); `ConflictService.vehicleConflicts`
    flags the same vehicle double-booked across two events, including two different household members' own
    events. New vehicle picker on event creation (web + mobile). Verified via
    `conflict.service.vehicle.test.ts` (5 real-DB cases) and live Playwright on web (1280×900, 390×844) and
    the Expo web preview.
  - **Email-vs-calendar date disagreement** — now built as a precision-first slice: a HIGH-CONFIDENCE
    email extraction whose title tightly matches an existing DIFFERENT-source calendar event with a
    disagreeing date files a resolvable conflict + inbox item
    (`["use_email_date", "keep_calendar_date", "dismiss"]`) rather than auto-updating or silently dropping
    the discrepancy. Verified via `ingestion.date-disagreement.test.ts` (4 real-DB cases) and live Playwright
    (web, 390px viewport, Expo preview) confirming both resolve actions actually change the right row.
  - **Still genuinely unbuilt** — impossible travel time and dependent transportation conflicts, exactly as
    this entry originally found: both need real geolocation (geocoding two `location` strings plus a
    travel-time estimate), and no geocoding/maps API integration exists anywhere in this codebase (confirmed
    still true via grep). Needs a paid API dependency and a product decision on which one — correctly left
    deferred, not attempted.
- **CAL-004 "Reschedule reconciliation" — ✅ now fully built (previously ⚠️ partial).** The duplication bug
  was already fixed (`findExistingDiscoveredCalendarEvent`), and the spec's own consent language —
  **"Offer update or auto-update only when user has an explicit trusted rule"** — is now honored too. A new
  `calendarRescheduleTrustedRules` table (`packages/db/src/schema/calendar-reschedule.ts`) is the trusted-
  rule concept this doc previously found missing entirely: owner-scoped, keyed on the reschedule email's
  sender domain (`normalizeSenderDomain`, `services/api/src/modules/intelligence/deterministic-prefilter.
  ts`), off by default. `IngestionService.extractCalendarEvent`'s update-in-place branch now checks it
  (`hasTrustedRescheduleRule`) before touching the existing row: with NO trusted rule, the proposed change
  is filed as a `calendarRescheduleProposals` row + an inbox item offering it (`["apply_change", "dismiss"]`
  suggestedActions, summary "'<title>' may have moved — review the proposed change before it's applied")
  and the existing event is left completely untouched; WITH a trusted rule, it auto-applies exactly as
  before. `InboxService.applyRescheduleChange` is the "apply_change" action: applies the proposal's
  snapshotted fields, re-runs CAL-003 conflict detection (the event's time is actually changing at that
  point), re-pushes to a connected write-back calendar if one was set, and — via `trustSender: true` — can
  insert the trusted rule itself, the "Always trust reschedule emails like this one" checkbox reachable
  directly from the offered-change card in the Inbox (both web and mobile). A standalone settings page
  (`/settings/calendar-trust` on web, `/calendar-trust` on mobile) lists/adds/removes trusted senders
  independent of any specific offered item. Real DB tests: `ingestion.reschedule-trust.test.ts` (offer
  filed + untouched event when untrusted; auto-apply + no offer for a subsequent email once trusted; direct
  add/remove) plus an updated `ingestion.dedup.test.ts` case (dedup mechanic itself, now exercised via the
  trusted-sender path). Live-verified end to end via a real Playwright-driven browser against the real dev
  API: signed up a fresh account, added/removed a trusted sender on the settings page (real `POST`/`DELETE
  /v1/inbox/reschedule-trust-rules`), then seeded a discovered event + an untrusted-sender offer directly in
  Postgres and drove the Inbox UI through "Review change" → checked "Always trust..." → "Apply change" (a
  real `POST /v1/inbox/:id/apply-reschedule` returning `{"trustedSenderAdded":true}`) — confirmed via a
  follow-up DB read that the event's date/location actually changed, the inbox item is `confirmed`, and the
  `united.com` trusted rule now exists. One related gap this did NOT touch, still open: the separate
  "reschedule-reconciliation update path silently goes stale against an already-write-back-pushed connected
  calendar" issue documented above — `applyRescheduleChange` (the offer-then-apply path) DOES now re-push on
  apply, but the TRUSTED auto-apply branch in `extractCalendarEvent` still doesn't call
  `CalendarWriteBackService.pushEvent`, for the same circular-module reason described there (now solvable
  the same way this pass solved AUTO-006/CAL-001's analogous `AutomationModule`/`ConnectorsModule` cycle —
  see the `forwardRef()` entry earlier in this section — but not done here to stay scoped to the consent gap
  this pass was asked to close).
- **TASK-001 "Life Inbox native obligations" — ✅** (pre-existing, not part of this pass's build list, but
  in scope for this re-check). `tasks` carries due date/condition, recurrence, assignee (person),
  `relatedEntityIds` (object), evidence via the inbox-item trace (`evidenceViaInboxItem`), consequence,
  priority, `snoozedUntil`, `state` (completion), and FAM-003's accept/decline delegation lifecycle — all
  confirmed present in `packages/db/src/schema/schedule.ts` and read/written by `ScheduleService`.
- **TASK-002 "External task sync" — ✅ with one named gap.** Google Tasks and Microsoft To Do adapters
  both exist and dedup via `(externalSyncProvider, externalSyncId)` on `ScheduleService.upsertExternalTask`
  (confirmed in `schedule.upsert-external-task.test.ts`). Apple Reminders is not connected — Apple has no
  server-side Reminders API to integrate against (it's EventKit, device-local only), and no native bridge
  was built for it, so the spec's explicit "Apple Reminders/Google Tasks/Microsoft To Do" list is only
  2/3 covered. This is a real platform constraint, not an oversight, but the spec does name it.
- **TASK-003 "Recurrence engine" — ✅, precisely 4-of-6 on the spec's own vocabulary, transparently so.**
  Confirmed real and tested (`packages/core/src/util/recurrence.test.ts`, 13 cases;
  `schedule.recurrence.test.ts`, 5 real-DB cases): RRULE-like daily/weekly/monthly/yearly, **nth weekday**
  ("2nd Tuesday"), **business-day** cadence, and **"X days before event"** (anchored to another row, with a
  documented staleness caveat on `dueSort` not following a moved anchor) are all real and exercised.
  **Mileage/usage conditions** and **provider-derived cycles** are not built — correctly so: this codebase
  has no odometer/mileage tracking on vehicles at all (nothing to evaluate a mileage condition against) and
  neither calendar adapter reads a provider's own RRULE payload. Both gaps are named inline in
  `recurrence.ts`'s own doc comment rather than silently absent.
- **RET-004 "Price-adjustment opportunity" — ⚠️ partial, but the specific gap this audit named
  ("Policy engine stores sourced retailer terms with effective dates; deadline calculator") is now real,
  not just the flat 30-day-for-everyone heuristic described above.** Built this pass, real and tested
  (`merchant_price_adjustment_policies` table; `price-adjustment-policy.ts`'s `resolvePriceAdjustmentPolicy`/
  `priceAdjustmentDeadline`/`daysUntil`; `ingestion.price-adjustment-policy.test.ts`,
  `commerce.price-adjustment-policy.test.ts`, both real-DB, all passing; live-verified via Playwright —
  screenshots of the purchase-detail banner, its inline policy editor, and the Inbox card, both before and
  after a user correction):
  - **A real per-merchant policy lookup.** `findMostRecentPriorPurchaseLine`'s window check
    (`IngestionService.extractReceipt`) now resolves the ORIGINAL purchase's merchant against
    `merchant_price_adjustment_policies` instead of a hardcoded 30 days, with the flat 30-day default kept
    as the fallback for the (large majority of) merchants with no row. Seeded reference data
    (`packages/db/src/seed/reference-data.ts`, idempotent, safe for any environment) covers exactly 5
    merchants, chosen for honesty over coverage per this doc's own "never invent a fact" discipline:
    **Target (14 days)**, **Best Buy (15 days)**, and **Costco (30 days)** at confidence `commonly_known`
    — specific numbers from each retailer's own long-published price-match/adjustment policy, each with a
    `sourceNote` naming the real caveat (Best Buy's Elite Plus tier extension, Costco's clearance
    exclusion) and an explicit "verify before relying on this" hedge, since a retailer's policy can change
    and this app has no live-fetch mechanism to notice. **Amazon and Walmart are seeded at confidence
    `assumed`, still using the flat 30-day number** — deliberately NOT asserting a specific window for
    either, since neither publishes one broad enough for this app to trust; they're seeded anyway (rather
    than left with no row) so they show up in the policy editor as "tracked but unconfirmed" instead of
    silently defaulting. No scraping/live-fetch of any merchant's real policy page was attempted or is
    planned — out of scope by design (no such infrastructure exists; reliable per-merchant scraping is a
    paid-data-provider or ongoing-maintenance problem, not a one-pass build).
  - **A real deadline calculator.** Both the price_adjustment inbox item (`InboxService.list`) and the
    purchase-detail banner (`CommerceService.purchaseDetail`'s `priceAdjustmentPolicy` field) now compute
    and show the actual deadline (original purchase date + the resolved merchant window) — previously only
    the price difference was ever shown, never a deadline, exactly as this audit found. A countdown ("N
    days left to request a price adjustment" / "Last day..." / "window likely passed") renders on both web
    and mobile.
  - **A real policy confidence, distinct from the AI extraction's own confidence band.** `commonly_known`
    vs. `assumed` vs. `user_confirmed` is shown as its own badge next to the deadline (label + tone differ:
    "Publicly documented policy" / "Unconfirmed — using Veynlo's default" / "You confirmed this policy"),
    so a user knows to double-check an `assumed` guess but can trust their own `user_confirmed` entry.
  - **A real, working user-correction path**, per this doc's stated preference for "sustainable" over
    "hardcode an exhaustive, always-current list": `PUT /v1/merchants/:merchantId/price-adjustment-policy`
    (inline editor on the purchase-detail banner itself, web + mobile — no separate settings page was
    built, since the purchase detail page already has the exact merchant in context) always writes a new
    `user_confirmed` row scoped to that one caller (never a global overwrite of the shared seeded fact,
    and never mutates a prior row in place — "effective dates" is a real multi-row history per merchant,
    not a single mutable value). A `user_confirmed` row always outranks a seeded `commonly_known`/`assumed`
    fact for that user, verified live (Best Buy's seeded 15-day/`commonly_known` policy corrected to 21
    days/`user_confirmed` in the Playwright run, banner and Inbox card both updating immediately).
  - **What's still an honest heuristic, not real per-merchant ground truth:** the 5 seeded merchants are a
    small, deliberately conservative set (precision over coverage), not an exhaustive or auto-updating
    retailer database; every merchant outside that list still gets the flat 30-day `assumed` default until
    either a future pass grows the seed list or a user corrects it themselves; and a `commonly_known` row
    is a snapshot of a publicly documented policy as understood at seeding time, not a live-verified
    current value — the retailer could change it tomorrow and this app would have no way to know without a
    user re-correcting it. The spec's other plausible trigger (a marketing/sale email about a product the
    user already owns) remains entirely unbuilt, as does a stated "estimated eligible amount" figure
    (still only implicitly derivable from the shown old/new prices) — neither was in this pass's scope.
- **RET-006 "Resale handoff" — ✅.** Draft listing generation (title/description/condition from the real
  purchase line), status lifecycle (`not_listed → listed → sold`, persisted, round-tripped in
  `commerce.resale-and-price-adjustment.test.ts`), and OS-native share-sheet handoff (never a direct
  marketplace post) all check out live. Market-range estimation is correctly absent — the spec itself only
  asks for it "through future marketplace data partners," which don't exist here.
- **AUTO-006 "Undo / compensation" — ✅.** `notify`, `add_task`, `add_calendar_event` are the entire
  action-kind universe this automation engine supports (confirmed in `rule-schemas.ts` — no
  connector-mutating action exists anywhere yet); of those, `add_task`/`add_calendar_event` get a real
  5-minute undo window that actually deletes the created row and flips the run to a new `undone` terminal
  state, and `notify` is correctly excluded with a clear reason rather than a silent no-op button. Verified
  against real DB: 5/5 cases in `automation.undo.test.ts` passing (successful undo of both kinds, `notify`
  rejected, past-window rejected via a backdated timestamp, non-owner rejected), and the web UI's "Undo
  (Xm left)" button confirmed to actually disappear once the window closes. Caveat: because no
  externally-mutating action type exists in this app yet, the "compensating action/instructions" half of
  the spec's sentence (for a genuinely irreversible *external* action) has never been exercised — only
  `notify`'s internal case has, which the code handles as a clear rejection message, not a set of
  compensating instructions. Not a gap in AUTO-006 itself so much as a ceiling imposed by how narrow this
  app's automatable action surface still is.
- **SHARE-001 "Direct object sharing" — the requirement actually governing "object sharing"; corrected ID
  mapping: FAM-006 is "Caregiver access" (a different, already-solid feature — see its own bullet above on
  the Lists-scope/expiry fix), not object sharing. ✅ now fully built.** The generalization itself
  (documents-only → lists/purchases/properties/vehicles/pets, all sharing the one `SharingService`) was
  already real and secure: a dedicated audit test (`sharing-refactor-audit.test.ts`, run in isolation
  against real Postgres — see note below) confirms stranger-denied-by-id, plain-household-member
  visibility, **immediate** loss of access the moment a member leaves the household, immediate grant
  revoke, correct passcode-link accept/reject, expired-link rejection, the `highly_sensitive`/`secret`
  public-link gate, and that a token minted for one resource type can never resolve against another's
  content/access path — 6/6 passing. Expiration (`expiresInDays`) was fixed in an earlier pass. **This
  pass built out the rest of the spec's own line — "Set view/edit/manage, expiration and optional message;
  preview exactly what recipient will see":**
  - **Right enforcement (the real work).** `resourceGrants.right` is now genuinely read, not just stored.
    `SharingService` grew `grantRight`/`hasGrantAtLeast` (ranked view < edit < manage) plus an
    authorization-callback overload on `revokeResourceGrant`/`revokeShareLink` so a resource service can
    additionally authorize its own owner/manage-right holders without SharingService needing to know about
    ownership models. Every write path in `ListsService` (`updateList`/`deleteList`/`addItem`/`updateItem`/
    `deleteItem`), `CommerceService` (`updatePurchaseLine` — the one real write path a purchase grant can
    reach), `AssetsService` (`createMaintenanceRecord`/`recordOdometerObservation`/`createTire`/
    `recordTireRotation`/`replaceTire`/`createHomeAsset`/`deleteHomeAsset`/`deleteProperty`/`deleteVehicle`/
    recall-check and confirm/resolve), and `PetsService` (`update`/`remove`/`addVaccination`/
    `addRefillReminder`/`assignVaccination`/`assignEvent`/refill mark-handled/picked-up) now requires at
    least "edit" for a grant-based (not owner/household) accessor to write, and "manage" to delete the
    resource itself or create/revoke OTHER grants on it (re-sharing) — household-based collaborative access
    is unaffected throughout, only grant-derived access is now right-gated. One new adversarial test file
    per resource type (`lists.rights-enforcement.test.ts`, `commerce.rights-enforcement.test.ts`,
    `assets.rights-enforcement.test.ts`, `pets.rights-enforcement.test.ts`) proves, against real Postgres,
    that a "view" grant can read but genuinely cannot write anything (including cannot re-share), an "edit"
    grant can modify the resource's own fields/items but cannot delete the resource or re-share it, and a
    "manage" grant can create/revoke other grants and delete the resource but the owner column never
    changes — 13/13 passing.
  - **Optional message.** A nullable `resourceGrants.message` column (migration `0042_known_argent.sql`)
    threads through `CreateResourceGrantDtoSchema` → `SharingService.createResourceGrant` → all 5 resource
    wrapper `createResourceGrant`/`create*Grant` methods → both web's and mobile's `ShareResourcePanel` (a
    text input alongside email/right/expiry). No grant-creation notification exists to piggyback on
    (checked: `NotificationDeliveryService` sends nothing for a new grant) — instead, each resource's own
    detail method (`listDetail`/`purchaseDetail`/`propertyDetail`/`vehicleDetail`/`PetsService.detail`)
    returns a `sharedNote` field (null for owner/household access, populated only for a grant-based
    visitor), rendered as a "Note from the owner: ..." banner via a new `SharedNoteBanner` component on
    web's list/purchase/vehicle/property/pet detail pages.
  - **Preview exactly what recipient will see.** Each resource's sharing controller gained an authenticated
    `GET .../share-preview` route (owner-or-manage gated) that calls the SAME `publicShareContent`/
    `publicPropertyContent`/`publicVehicleContent`/`publicPetContent` method the recipient's own share-link
    redemption eventually uses — no new redaction logic, just an authenticated peek at the existing one.
    `ShareResourcePanel` (web + mobile) gained a "Preview what they'll see" button rendering the response
    generically (works for any resource shape without per-type UI). Verified live via Playwright against
    the real dev app: a vehicle's page header shows the full VIN to its owner, but the recipient preview
    box shows label/make/model/year/purchaseDate/maintenance with **no VIN field at all** — confirming
    `publicVehicleContent`'s existing redaction is exactly what gets shown before sharing, not a separate
    (and possibly wrong) guess. Also verified: a list shared with "edit" right shows the grantee a "Note
    from the owner: ..." banner with the exact message text, and the grantee could genuinely add an item to
    the list (proving the grant's `right` — not just its existence — is what's being enforced end to end).
  - *Test-infrastructure note, not a spec-compliance finding*: running the sharing test files together
    with default vitest file-parallelism against the shared real dev Postgres produced spurious failures
    (cascading from one test file's multi-step shared state racing another file's writes); running the same
    files with `--no-file-parallelism` (or individually) passes 100% every time. This is pre-existing test
    suite behavior when multiple real-DB spec files run concurrently, not a bug in the audited code — flagged
    here in case it causes a confusing CI result elsewhere in this repo. Separately, a full `--no-file-
    parallelism` run of the ENTIRE api test suite showed 2 failures in `automation.undo.test.ts` (an FK
    constraint race against `connections`/`calendar_events`) unrelated to sharing; both pass cleanly when
    that file is run alone, confirming the same shared-live-Postgres cross-file race, not a SHARE-001
    regression.

## HLTH-001 (§27 Health Logistics) UI-reachability gap — closed

Not actually a Phase 2 item (§27 is later-chapter work, tracked in `docs/ARCHITECTURE.md`'s own
per-domain summary, not in this file's original scope of credential/money/input-gated blockers) — noted
here anyway per this pass's own instruction, since a prior spec-retraceability audit this session flagged
it and asked for the closure to be recorded in this file specifically. See `docs/ARCHITECTURE.md`'s
"health-logistics" bullet for the full writeup: a task could never be linked to a health appointment (no
backend mechanism existed at all), the real `POST /v1/health/bills/:billId/link-appointment` endpoint had
no UI caller anywhere in the app, insurance-card/EOB documents had no per-appointment association, and no
export existed for the domain. All four are now built on a new standalone appointment detail page
(`/life/health-appointments/[id]` web, `/health-appointment/[id]` mobile), with adversarial access-control
tests confirming a plain household member/outsider/"health:read"-only delegate can link or export nothing
outside what they own.

## Browser extension / desktop — status

- **Desktop native bridge** (spec §37.2 DSK-002/003/006) — done, no credential needed. Previously
  `apps/desktop/src-tauri` was a bare webview shell with zero `#[tauri::command]`s. Now real: a system
  tray icon with a menu (Open Veynlo / Quick Capture / Quit), a global hotkey (`CmdOrCtrl+Shift+I`) that
  opens a genuine small capture window (`apps/desktop/src-tauri/capture-window/`, served over a registered
  custom URI scheme rather than `file://` — see `lib.rs`'s `CAPTURE_SCHEME` doc comment for a real
  IPC-breaking bug found and fixed along the way) posting to the exact same `POST /v1/ingestion/manual` /
  `POST /v1/ingestion/url` the web app's own "Add manually" flow already uses, native OS notifications
  (`tauri-plugin-notification`) that poll the existing `GET /v1/notifications` endpoint and mirror newly
  `"sent"` ones out as real desktop notifications (never a second, independent notification-decision
  system — DSK-006's own "mirror the policy engine" line), and file-drop/file-association document upload
  reusing the exact same `POST /v1/documents/upload` the web Documents page's own drag-and-drop uses. Live-
  verified in this dev environment (not just compiled): a real global-hotkey press via `osascript`, a real
  sign-up through the actual UI, and a real dev-API request log showing `201`s for both the quick-capture
  and file-association-upload paths; a real `tauri build --debug` producing and launching an actual `.app`
  bundle with `tauri.conf.json`'s `bundle.fileAssociations` compiled into its real `Info.plist`
  (`CFBundleDocumentTypes`, confirmed via `plutil`). New `desktop_device_settings`/`local_cache_manifest`/
  `deep_link_routes`/`batch_actions` tables (`packages/db/src/schema/desktop.ts`, migration
  `0060_powerful_celestials.sql`, applied to this dev environment's real Postgres) — the spec's own named
  §37.2 data list; each table's own doc comment is explicit about which columns back real, wired behavior
  today versus which are structural-only for a feature this pass didn't build (e.g. `local_cache_manifest`
  has no real offline-cache mechanism behind it yet — DSK-007 was out of scope this pass). Full accounting
  (what's built, how each piece was verified, exactly what a real drag-and-drop gesture vs. its
  file-association-argv proxy covers) is in `apps/desktop/README.md`'s "Native bridge" and "Verified"
  (Round 5) sections — not duplicated here.
  - **Genuinely credential-blocked, not attempted (correctly, not faked):** (1) code signing/notarization
    for macOS (Developer ID) and Windows (Authenticode) — needs a paid Apple/Microsoft developer account;
    an unsigned build (what `tauri build` produces here) triggers Gatekeeper/SmartScreen warnings on
    another machine. (2) Auto-update infrastructure — Tauri's updater plugin needs a real hosted update
    manifest/artifact server, which needs the real `app.veynlo.com`/API domain this environment doesn't
    have yet (no AWS account, same gap as everywhere else in this file that references it). (3) Store
    distribution (Mac App Store, Microsoft Store) — needs the same paid developer accounts as (1) plus
    store-specific packaging not attempted this pass. None of these three were stubbed or faked to look
    done; they were not attempted at all, precisely because they cannot be done for real without those
    inputs.
- **Desktop bulk management** (spec DSK-004) — done. The desktop app is a thin Tauri webview around
  `apps/web`, so "bulk management" meant adding real multi-select + batch actions to the web app itself:
  Documents page (multi-select, bulk delete with a count-and-confirm step) and Inbox page (multi-select,
  bulk confirm/dismiss, on both web and mobile) both now have it.
- **Browser extension "quick list"** (spec §37.1: choose a destination list/private/household) — done.
  Built the whole FAM-005 "Shared lists" domain first (schema: `lists`/`saved_items` — table names/id
  prefixes were already reserved in `packages/core/src/util/ids.ts` before this feature existed, same
  kind of pre-scaffolded-but-unbuilt state `packages/authz` turned out to be; service/controller in
  `services/api/src/modules/lists/`; full web UI at `/lists` and `/lists/[id]`; mobile screens at
  `app/lists.tsx`/`app/list/[id].tsx`), including FAM-006 delegation-scoped household sharing and
  item-level "private when needed" (a private item is invisible to other household members, even on an
  otherwise-shared list). Then wired the extension popup's new "Quick list" section to it: a `<select>`
  populated from `GET /v1/lists` (id/name/kind/householdId/itemCounts only — no item contents, matching
  spec's "extension gets only list metadata needed for picker") and an "Add page to list" button that
  posts the current page's selected text (or title, if nothing's selected) as a new item.

## ID-001..005 ("Identity & Legal Continuity") — built this pass

Not a Phase 2 item either (later-chapter work, same "noted here per this pass's own instruction" reasoning
as the HLTH-001 entry above) — a full build, not just documentation, closing a domain that previously had
**zero code anywhere** despite TRIP-006 (built earlier this session) doing a narrow, unrelated
passport-expiry-vs-trip-date check against the generic Documents vault's `documentKind`/`expiresAt` fields.

- **Schema** — `packages/db/src/schema/identity-records.ts`: `identityRecords` (passport/drivers_license/
  vehicle_registration/professional_license/property_obligation, envelope-encrypted `label`/
  `issuingAuthority`/`documentNumber`, `linkedVehicleId`/`linkedPropertyId`/`linkedDocumentId`,
  `reminderLeadDays`, `status` active/expired/renewed, `supersededByRecordId` versioning chain) and
  `jurisdictionRenewalLinks` (the curated official-renewal-URL registry).
- **Encryption/reveal gate** — `documentNumber` is envelope-encrypted at rest via the standard
  `encryptedText` column type, AND excluded from every ordinary list/detail query
  (`identity-records.util.ts`'s `identityRecordSafeColumns`) — only the dedicated
  `IdentityRecordsService.revealDocumentNumber` (§28.9 step-up via `IdentityService.verifyStepUpPassword`,
  same pattern as Emergency Binder/Health Logistics/data export) ever selects or returns it, writing an
  `audit_events` row for every outcome (denied/failure/success).
- **Access control** — private by default, stricter than every other shared-household resource in this app
  (even stricter than Health Logistics): plain household membership is NEVER OR'd into this table's access
  condition at all, only ownership or an explicit `resourceGrants` row. Public share links are
  unconditionally rejected (`PUBLIC_LINKS_DISABLED_FOR_IDENTITY_RECORDS`), mirroring
  `HealthLogisticsService.createAppointmentShareLink`'s identical posture.
- **Expiration reminders** — wired into `AttentionService.scanAndFileDeadlines` using each record's own
  user-configurable `reminderLeadDays` (not the scanner's fixed 14-day window), auto-flipping `status` to
  `"expired"` past the date (never auto-`"renewed"` — that's only ever the explicit user action).
  `TripsService.computeDocumentReadiness` and the attention scanner's own travel-document block both now
  prefer a dedicated `identity_records` passport row over the old Documents-vault fallback once one exists,
  without breaking that fallback for a user who hasn't added one.
- **Curated jurisdiction registry** — `packages/db/src/seed/identity-jurisdiction-links.ts` seeds six real,
  verified official .gov renewal URLs (U.S. passport renewal; CA/NY/TX driver's-license renewal; CA/NY
  vehicle-registration renewal) at confidence "seeded," resolved with the same precedence rule as RET-004's
  `merchantPriceAdjustmentPolicies` — a user's own correction (`PUT /v1/identity-records/jurisdiction-links`)
  always outranks the seeded row. Every seeded URL was either live-fetched and confirmed, or corroborated by
  live web search against the issuing agency's own domain during this feature's authoring — see that file's
  own doc comment and per-row `sourceNote`.
- **Versioning** — "attach new version"/"mark renewed" creates a new row and marks the old one `"renewed"`
  with `supersededByRecordId` pointing forward; the old row is never deleted, and an `audit_events` row
  records the renewal.
- **UI** — web: `/life/identity` (list + manual-add form) and `/life/identity/[id]` (reveal/renew/reminder-
  lead-time/jurisdiction-link/sharing), plus a compact section on the main Life page. Mobile:
  `app/identity-records.tsx` and `app/identity-record/[id].tsx`, linked from the Life tab.
- **Emergency Binder** — a household's current (non-"renewed") identity records are now aggregated into
  `EmergencyBinderService.getBinder` alongside vehicles/properties/pets, gated by the binder's own existing
  §28.9 step-up check — `documentNumber` stays excluded from that view too (via the same
  `identityRecordSafeColumns` selection), so unlocking the binder never exposes a raw passport/license number.
- **Entitlement** — new `identity_records` capability key (`packages/core/src/entitlements/plans.ts`), Plus+
  (false on Free, true on Plus/Family/Pro Agent), same "listed but not enforced on the manual-create path"
  posture as `home_vehicle_profiles`/`health_logistics`.
- **Tests** — `identity-records.access.test.ts` (owner/plain-household-member/outsider/grantee adversarial
  matrix, ciphertext-at-rest raw-SQL check, step-up reveal gate, renewal chain, jurisdiction-link seeded-vs-
  user-override precedence, Emergency Binder masked aggregation) and
  `attention.identity-records.test.ts` (per-record reminder-lead-time firing, expiration escalation,
  idempotent re-scan, TRIP-006 passport-record preference) — all passing against real dev Postgres.

## AI-002/AI-003 (§"Confidence and risk policy"; §"Prompt-injection and untrusted-source defense") — built this pass

Not a Phase 2 item either (same "noted here per this pass's own instruction" reasoning as the HLTH-001/
ID-001..005 entries above) — a real audit against `services/api/src/modules/ingestion/ingestion.service.ts`
found three safety-relevant, non-money-gated gaps here, all closed this pass:

- **AI-002 "domain + field + action impact" risk policy didn't exist** — `risk_policies`
  (`packages/db/src/schema/pipeline.ts`) had a real schema with zero readers or writers anywhere; every one
  of the ~14 `confidenceToBand` call sites in `ingestion.service.ts` used one hardcoded global
  `{reviewThreshold: 0.55, highThreshold: 0.85}` pair regardless of domain. Built `RiskPolicyService`
  (`services/api/src/modules/intelligence/risk-policy.service.ts`): resolves exact-(domain,field) ->
  domain-wide (`field: "*"`) -> the same fixed global default every call site used before, so an
  unconfigured domain/field is provably unaffected. Wired into every `confidenceToBand` call site via a new
  `resolveRiskThresholds` helper, injected as an optional trailing constructor param (same pattern
  `memories`/`documents` already established) so none of this file's dozens of existing positional test
  constructions needed updating. Seeded four deliberately conservative real policy rows
  (`packages/db/src/seed/run.ts`): stricter (higher) thresholds for money-moving domains `receipt`, `bill`,
  `subscription`, and a looser threshold for the low-stakes `shipment` domain as the explicit contrast case.
- **AI-003 prompt-injection attempts were never logged** — `prompt_security_events`
  (`packages/db/src/schema/audit.ts`) also had a real schema with zero writers; the existing
  `EMAIL_INJECTION_DEFENSE_PREFIX`/`SHARE_MESSAGE_INJECTION_DEFENSE_PREFIX` prompt-level defense and the
  schema-constrained `tool_choice` were both real and already in place, but there was no way to know whether
  an injection attempt ever actually occurred or whether the defense held. Added a coarse, deliberately
  imperfect post-hoc heuristic scanner (`detectPromptInjectionAttempt` in
  `services/api/src/modules/intelligence/anthropic-extraction.service.ts`, matching common phrasings —
  "ignore previous instructions," "disregard the above," "you are now," a `system:` marker, etc.) over the
  raw untrusted content fed into every `extractStructured` call, in ONE place rather than at each of
  ingestion's many call sites. A match writes a `prompt_security_events` row (sourceEventId, extractorName,
  matched pattern, whether the extraction still validated against its schema despite the attempt) —
  detection and logging for analytics only; the schema-constrained tool use + Zod validation remains the
  actual defense, this never blocks a legitimate extraction. Surfaced on the admin console
  (`apps/admin/src/app/dashboard/page.tsx`'s new "Prompt-injection detections" section, backed by
  `GET /v1/admin/prompt-security`) as "N potential prompt-injection attempts detected this week," mirroring
  the existing "Model health"/"Job queue health" sections' pattern.
- **A real kill switch existed but nothing near AI extraction ever checked it** —
  `FeatureFlagsService`/`feature_flags` is a genuine, DB-backed, admin-flippable remote kill switch (already
  used for e.g. the Android notification-listener capture flag), but flipping any flag did nothing to stop
  an AI extraction call. Added an `ai_extraction_paused` flag check at the very top of both
  `IngestionService.classifyAndExtract` and `classifyAndRouteShareMessage` — the two entry points that ever
  call the model — mirroring `AutomationService.evaluateEvent`'s own AUTO-010 kill-switch shape (checked
  before anything else can happen, fails open/unpaused when unconfigured). Raw ingestion/inbox-filing is
  untouched, same as how the automation kill switch doesn't stop non-automation features either. The
  existing generic admin "Feature flags" table (already the real settings surface an admin flips any flag
  from) now also has an "add new flag" form so `ai_extraction_paused` — or any future flag — can be created
  and toggled without a DB seed.
- **AI-003/§39.2 schema-repair retry didn't exist** — a failed Zod validation on `extractStructured`'s tool
  output returned `null` immediately, with no retry at all, despite the spec's own "invalid output retries
  through a constrained repair path" line. Added one bounded, one-shot retry in
  `AnthropicExtractionService.extractStructured`: on validation failure, re-issues the SAME call with the
  actual Zod error appended to the system prompt so the model has something concrete to correct; if the
  retry also fails to validate (or itself errors), falls through to the exact same "return `null`, never let
  invalid structured output enter canonical data" behavior as before — no loop, no alternate-model fallback.
- **Tests** — `services/api/src/modules/intelligence/risk-policy.service.test.ts` (fallback order),
  `services/api/src/modules/ingestion/ingestion.risk-policy.test.ts` (a domain-specific policy genuinely
  changes the filed `confidenceBand` end to end; an unconfigured domain doesn't),
  `services/api/src/modules/intelligence/anthropic-extraction.service.test.ts` (repair-retry succeeds/fails,
  injection detection writes/doesn't write a row — via a `getClient()` test override, no real network call),
  and `services/api/src/modules/ingestion/ingestion.ai-kill-switch.test.ts` (the kill-switch test: proves,
  against real Postgres, that `FakeModelProvider.calls` stays completely empty — the model is never even
  invoked — once the flag is set, for both `classifyAndExtract` and the share-message path; unpausing lets
  the very next ingestion call the model and file normally again) — all passing against real dev Postgres.

## SUB-003/SUB-004 (§18 "Subscriptions & Recurring Services") — built this pass

Not a Phase 2 item either (same "noted here per this pass's own instruction" reasoning as the ID-001..005/
AI-002/AI-003 entries above) — two precise, non-money-gated gaps found on re-audit of `IngestionService.
extractSubscription` against the spec's SUB-003/SUB-004 chapter, both closed this pass.

- **SUB-003 "Price-change detection ... accounting for taxes, variable usage, annual renewals, exchange
  rates, bundles and promotional periods" — was a flat `>= 50 minor units` (50-cent) diff with zero
  magnitude-awareness, found live to false-positive on ordinary tax variation** (e.g. a $9.99 plan billed
  at $10.79 one month from a state/local tax change alone would have fired a "price changed" alert).
  Replaced with a two-floor gate in `ingestion.service.ts`'s `isMaterialSubscriptionPriceChange` — a genuine
  alert now requires BOTH an absolute floor (**$1.00**) AND a relative floor (**>5% of the prior amount**),
  so a cheap subscription's small dollar move and an expensive subscription's small percentage tax wobble
  both correctly fail to alert, while a real "$9.99 -> $12.99" increase clears both. Deliberately still two
  simple, documented numbers (not a modeled tax-rate lookup — this app has no such data source), and
  deliberately does NOT attempt to separately model variable usage-based billing, annual-vs-monthly cadence
  switches, or currency/FX noise (no per-subscription usage meter/cadence-change signal/FX feed exists to
  model them against) — a real change in any of those can still legitimately clear the threshold (that's
  not a false positive, the amount really did change), it's just not separately reasoned about.
  - **Recording vs. alerting are now two separate concerns.** `price_observations` still records every
    genuinely observed price difference (even a one-cent move — this is a factual history, not an alert
    feed); only the much stricter two-floor check gates the `subscriptions.state = "price_changed"` alert
    and its inbox-item wording.
  - **Promotional-period-ending carve-out.** A subscription tracked as `state: "trial"` (only ever set when
    a prior email explicitly said `isTrial: true`) whose next email confirms a real, non-trial charge is an
    EXPECTED transition, not a surprise increase, regardless of the dollar jump from the promo amount (a
    "$0 for 3 months, then $9.99" renewal is never flagged as a price change). Lands on a new, calmer
    `"trial_ended"` subscription state (distinct from `"price_changed"`, own badge tone in both web/mobile
    Life list and detail pages) and a plain-language inbox summary — e.g. "Streamflix Deluxe trial ended —
    you're now being charged $9.99/month" — instead of "price changed." This also fixed a latent bug found
    live while wiring it: a subscription's state previously had no path off `"trial"` at all once a
    non-trial, non-price-changed renewal arrived.
- **SUB-004 "Cancellation assistant ... shows known steps/link/evidence ... when a direct API/partner flow
  doesn't exist" — the UI only ever showed an evidenced `cancellationInstructionsUrl` from the source
  email, with an honest "not found" fallback otherwise; no "known steps" reference existed at all.** Added
  a small, curated `merchant_cancellation_steps` reference table
  (`packages/db/src/schema/commerce.ts`), same RET-004/`jurisdiction_renewal_links`-shaped precedent —
  global seeded rows (`ownerUserId` null) plus a per-user correction (`ownerUserId` set) that always
  outranks the seeded row for that user, resolved by `merchant-cancellation-steps.ts`'s
  `resolveMerchantCancellationSteps`/`setUserMerchantCancellationSteps`, exposed via
  `GET`/`PUT /v1/merchants/:merchantId/cancellation-steps`. Explicitly NOT a direct-cancel API/partner
  integration — no such business relationship exists for this app to build against; this is a reference
  table of plain-text steps to follow, nothing more.
  - **Seeded merchants (`packages/db/src/seed/merchant-cancellation-steps.ts`, idempotent, safe for any
    environment) — nine widely-used services this pass is genuinely confident about, each sourced to the
    level of "which menu to open," not exact button copy that's likely to drift:** Netflix, Spotify, Amazon
    Prime, Disney+, Hulu, Adobe Creative Cloud, YouTube Premium/TV, Planet Fitness, and Costco membership.
    Every row's `sourceNote` says outright this is general public knowledge as of this seed's authoring,
    not a live-verified fetch, and to double-check the merchant's own current process before relying on
    it — same "well-sourced starting point to verify, not ground truth" framing RET-004's own seed uses.
    Planet Fitness and Costco are deliberately the two most notable *non-self-service* cases seeded (call/
    visit-in-person/certified-mail cancellation, and a full-refund membership guarantee, respectively) —
    included specifically because "known steps" for them is genuinely more useful than the app staying
    silent. No merchant gets fabricated steps: absent both an evidenced URL and a curated/user-corrected
    row, the subscription-detail page keeps its pre-existing, unchanged honest "not found" message.
  - **UI** — web: `/life/subscriptions/[id]`'s "Cancel" field now falls back to curated steps (numbered
    list + source-note caveat) when no evidenced URL exists, with an inline `CancellationStepsEditor` (same
    "read current value, post correction, always outranks the seed" pattern as `PolicyEditor`) letting a
    user add/correct steps for any merchant with a resolved `merchantId`. Mobile: `app/subscription/[id]
    .tsx` mirrors both exactly.
- **Tests** — `services/api/src/modules/ingestion/ingestion.dedup.test.ts` (real-DB, `--no-file-
  parallelism`): a small tax-sized wobble on a cheap subscription does NOT alert (fails the $1 absolute
  floor); a small percentage move on a pricier subscription does NOT alert despite clearing that $1 floor
  (isolates the 5% relative floor); a genuine large increase still alerts (pre-existing test, unchanged);
  and a trial-to-paid transition lands on `"trial_ended"` (not `"price_changed"`) with a calmer inbox
  summary containing the charge amount and no mention of "price." `services/api/src/modules/commerce/
  commerce.cancellation-steps.test.ts` (real-DB): a seeded merchant resolves its curated steps; a merchant
  with nothing curated resolves `null` (the honest fallback, not an error); a user's own correction
  outranks the seeded fact for that user only, upserting in place on a second save; `subscriptionDetail`
  embeds the resolved steps (or `null`) correctly. All passing against real dev Postgres, alongside this
  repo's full 581-test suite. `pnpm --filter @veynlo/api run typecheck` and both `apps/web`/`apps/mobile`
  typecheck pass with zero errors.

## MAIL-001..008 (§"Mail Relevance") — status

Not a Phase 2 item either (same "noted here per this pass's own instruction" reasoning as the SUB-003/004
entry above). A prior audit this session read the spec's Mail Relevance chapter (MAIL-001 through MAIL-008)
against `IngestionService` and found several precise gaps; this pass built the buildable ones and re-verified
one that turned out to already be closed by unrelated work earlier in this session.

- **MAIL-002 "Category privacy controls" — already closed, not a real gap.** `PreferencesService.
  isCategoryEnabled` is real, DB-backed, and enforced in `IngestionService.classifyAndExtract` before every
  gated domain extractor — but this session's PERS-003 "Category preferences" work (a different
  concurrent audit, filed under Personalization rather than Mail) had already built the exact UI this gap
  named as missing: `/settings/personalization`'s "What Veynlo pays attention to" section (web and mobile
  both) calls `GET`/`PUT /v1/category-preferences` directly. Verified live rather than assumed: signed up a
  fresh account, toggled the "purchases" category off via `PUT /v1/category-preferences`, confirmed a
  follow-up `GET` reflects `enabled: false`. No duplicate UI was built.
- **MAIL-006 "User sender rules" — built.** The only sender-scoped rule that existed anywhere was
  `calendarRescheduleTrustedRules` (a single "trust reschedule emails from this domain" boolean, CAL-004).
  Added a real `sender_rules` table (`packages/db/src/schema/sender-rules.ts`; owner-scoped, exactly one of
  `senderDomain`/`senderEmail` set, `action`: `always_school | always_bills | ignore | attachments_only |
  household_shared`) checked as the very first sender-specific step in `IngestionService.classifyAndExtract`
  — before the deterministic `matchKnownSender` registry or the AI domain classifier even run:
  - `ignore` skips processing entirely (no domain classification, no attachment processing, no inbox item —
    "filed" with nothing to review).
  - `attachments_only` still runs the MAIL-004 attachment pipeline (below) but skips domain classification/
    extraction — "keep the file, not the structured guess."
  - `always_school`/`always_bills` force `domains` to `["school"]`/`["bill"]`, REPLACING (not bypassing) the
    classifier — every upstream gate (AI kill switch, PRIV-001 opt-out/exclusion, plan entitlement, category
    preference) still applies to a forced category exactly as it would to an AI-classified one, so a sender
    rule can't be used to bypass a plan limit.
  - `household_shared` widens the resulting event's `householdId` to the owner's active household (looked
    up directly, `householdMemberships` status `"active"`) even when the connection itself carries no
    household — e.g. a personal Gmail connection with no household set at all.
  - **UI** — a standalone settings page (web `/settings/sender-rules`, mobile `/sender-rules`, both linked
    from their respective Settings screens) to add/list/remove rules by domain or exact email, mirroring
    `/settings/calendar-trust`'s identical shape. Plus an inline "Always treat mail from this sender as..."
    action right on an Inbox item's own correction form (`InboxService.addSenderRuleFromInboxItem`,
    `POST /v1/inbox/:id/sender-rule`) — resolves the item's real (encrypted) `sourceEvents.fromAddress`
    down to a domain-scoped rule, the natural place a user notices they want this, on both web and mobile.
- **MAIL-004 "Attachment intelligence" — built, scoped down.** Zero email-attachment pipeline existed at
  all before this pass — Gmail/Outlook attachments were never fetched, only standalone document uploads and
  voice notes went through OCR/malware-scan. Now: `GmailAdapter`/`OutlookAdapter` fetch attachment bytes
  during sync (Gmail: `messages.attachments.get` per part, using the metadata `payload.parts` already
  exposes; Outlook: Graph's `/messages/{id}/attachments`, which inlines base64 `contentBytes` directly once
  `hasAttachments` is true) and pass them through to `IngestionService`, which reuses
  `DocumentsService.upload` WHOLESALE (the existing malware-scan, magic-byte check, storage quota, and OCR
  queueing — nothing duplicated) to store each as a real `documents` row. A new `documents.sourceEventId`
  column (plain text, no FK, matching this schema's existing evidence-link-column convention) links it back
  to the source email for provenance. Best-effort per attachment — one bad/oversized/unsupported-type file
  never fails the rest of the message's ingestion.
  - **Deliberately deferred, per this pass's own scoping instruction**: page/region linking (tying an
    extracted fact to an exact page/bounding-box within a multi-page attachment) — a genuinely separate,
    larger feature needing a page-aware OCR pass, not "attachment becomes a real linked document." Also
    deferred: classifying WHAT KIND of document an attachment is (`documentType` is always the generic
    `"other"` tag today) — that would need its own OCR-then-classify pass. Both are real, buildable
    follow-ups, not blocked on anything money-gated.
- **MAIL-005 "Sender/template parsers" — versioning added, scoped down.** `matchKnownSender`'s deterministic
  category match (4 hardcoded domains, no real field extraction) had no version tracked anywhere. Added a
  `source_events.parser_version` column, set to `KNOWN_SENDER_PARSER_VERSION` (currently `1`,
  `deterministic-prefilter.ts`) whenever `matchKnownSender` actually matches — null for an AI-classified or
  sender-rule-forced event, since neither goes through its field extraction. Bump the constant whenever the
  hardcoded-domain matching logic itself changes, so a future correction-rate regression can be audited back
  to a specific version. Deliberately NOT built into a full per-template versioning/confidence-fallback
  system — `KNOWN_SENDER_DOMAINS` is one small, uniformly-maintained registry; a real template-versioning
  system (per-sender confidence scores, automatic fallback thresholds) is a separate, larger feature.
  MAIL-007's full sanitized email-source-viewer and MAIL-004's page/region-linking sub-detail are both
  deferred for the same reason: this codebase deliberately never stores full email body content
  (`source_events`'s own schema doc comment — only subject/snippet/from-address, "not a durable copy of the
  whole message"), so a real "highlights extracted passages within the original" viewer would need either a
  meaningful storage-model/retention-policy change (MAIL-008 territory) or reconstructing content that was
  never kept. Out of scope for a pass targeted at non-money-gated, architecturally-contained gaps.
- **Tests** — `services/api/src/modules/ingestion/ingestion.sender-rules.test.ts` (real DB): `ignore` files
  zero inbox items and zero domain records, and the classifier is never even invoked (`ai.calls` stays
  empty); `always_bills` force-routes to the bill extractor on a deliberately RECEIPT-shaped subject/body
  without ever calling `domain_classifier_v1`; `attachments_only` skips classification/extraction entirely.
  `services/api/src/modules/ingestion/ingestion.attachment.test.ts` (real DB): a fake-provider-simulated
  Outlook message with an attachment produces a real `documents` row linked via `sourceEventId`, with a real
  `document_versions` row (right mime type/size); an `ignore` sender rule suppresses attachment processing
  too. `services/api/src/modules/attention/inbox.sender-rules.test.ts` (real DB): the settings-page
  add/list/remove CRUD (including add-or-update on a re-submitted domain); `addSenderRuleFromInboxItem`
  correctly decrypts a real `sourceEvents.fromAddress` ("Display Name <email>" form) down to the right
  domain. All passing against real dev Postgres (`--no-file-parallelism`), alongside this repo's full test
  suite — a pre-existing, unrelated 3-test failure in a concurrently-authored `ingestion.connection-
  privacy.test.ts` (its fake email subjects don't clear the relevance-keyword prefilter, so its AI-should-
  run assertions fail regardless of any change in this pass; confirmed via direct instrumentation, not
  guessed) was the only other red in the suite before and after this work. `pnpm --filter @veynlo/api run
  typecheck` and both `apps/web`/`apps/mobile` typecheck pass with zero errors.
- **Live-verified**: MAIL-002's category toggle (`curl`, described above); a real `ignore` sender rule
  added via `POST /v1/inbox/sender-rules` against the live dev API genuinely produced zero inbox items for a
  bill-shaped test email (`POST /v1/ingestion/manual`); the inline `POST /v1/inbox/:id/sender-rule` action
  resolved a real encrypted `sourceEvents.fromAddress` down to the correct domain and created the rule, both
  confirmed via a follow-up `GET /v1/inbox/sender-rules`. Live end-to-end verification of `always_bills`/
  `always_school` actually filing a real AI-extracted bill/school item was not reachable in this environment
  — the shared long-running dev API process (started by an earlier session, still serving :4000) has no
  `ANTHROPIC_API_KEY` in its own process environment even though `.env` on disk now has one (confirmed via
  `ps eww`), so no extractor call succeeds on that process regardless of sender rules; restarting a shared
  server another concurrent agent may be mid-verification-run against was judged not worth the risk. The
  force-routing logic itself (classifier skipped, correct domain forced, entitlement/category gates still
  applied) is fully covered by the real-Postgres `FakeModelProvider` test above instead.

## Pre-existing, out of scope for direct action (carried over from the MVP phase)

- Real Apple Developer account for live iOS testing/Sign in with Apple end-to-end (code-complete,
  `APPLE_CLIENT_ID`/`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` all blank in this dev `.env`).
- A real production AWS account / `app.veynlo.com` domain (referenced as a placeholder in the desktop
  app's release-build URL and elsewhere) — see `docs/DECISIONS.md`.
- AI transcription for voice notes (Claude has no audio-input API surface as of this session).

---
*This file is maintained as part of the Phase 2 completeness pass. Update it whenever a new
credential/money/input-gated item is found or resolved — do not silently skip listing one.*
