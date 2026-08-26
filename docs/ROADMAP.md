# Roadmap

Phases follow the master spec §52 (MVP → Phase 2 → Phase 3 → Phase 4),
adapted to what's actually been built. Status reflects the current state of
this repository, not an aspirational plan.

## Phase 1 (MVP) — status

| Area | Status |
|---|---|
| Auth (email/password, sessions, device list) | ✅ Built. Passkeys/MFA/OAuth sign-in not yet. |
| Household + dependents | ✅ Built (create/invite/leave/dependents). Caregiver delegation types exist in `@veynlo/core`, no API yet. |
| Gmail connector | ✅ Real OAuth + Gmail API sync, gated behind config. Outlook/IMAP/ICS connectors not started. |
| Ingestion pipeline | ✅ Deterministic prefilter + AI domain classification/extraction for receipts, bills, calendar events. Travel/warranty/school/home/vehicle extractors not started. |
| Entity resolution | 🟡 Merchant-by-name only. No merge/unmerge UI, no cross-source purchase/shipment/subscription reconciliation beyond what's in `ingestion.service.ts`. |
| Inbox (review/confirm/correct/archive/dismiss/snooze) | ✅ Built. "Correct" (editing extracted fields) and "merge" are not yet implemented — only confirm/archive/dismiss/snooze. |
| Home "Needs You" + caught-up state | ✅ Built, reads real attention_items. Nothing populates attention_items automatically yet from the pipeline — currently only seed data and (implicitly) future automation-rule output would. |
| Ask / structured search | ✅ Built — grounded synthesis with evidence citations, `insufficientEvidence` flag. Semantic/vector search not wired (pgvector column exists, unused). |
| Timeline | ❌ Not built. |
| Documents/vault | ✅ Upload (web UI at `/documents` + API), S3 storage, image OCR via Claude vision. PDF OCR not built (needs Anthropic's beta document-input surface). |
| Notifications | ✅ Preferences, daily/weekly brief composition, per-item email delivery, quiet-hours + intensity suppression — all real, running in the worker process (SMTP via Mailhog in dev). Push/desktop channels not implemented (no APNs/FCM integration yet — only `channel: "email"` actually sends). |
| Background workers | ✅ Separate worker process (`services/api/src/worker-main.ts`, BullMQ + Redis) runs connector sync and notification dispatch/delivery durably — survives a process restart, retries with backoff, dedupes by job ID. |
| Billing/entitlements | ✅ Stripe checkout + webhook + entitlement resolution. App Store/Play Store receipt verification not built (mobile doesn't exist yet either). |
| Admin console | ✅ Separate app (`apps/admin`, its own port/origin) with real per-operator RBAC: sign-in, user lookup, connector health, audit log — all live, all audited. Break-glass/elevated-access workflow and role-scoped endpoints (`support` vs `superadmin` don't differ in practice yet) are not built. |
| Web app (Home/Inbox/Ask/Life/Connections/Settings) | ✅ Built, responsive, light/dark theme, real API integration. |
| Mobile (iOS/Android) | 🟡 Core loop built and verified: Expo + expo-router app (`apps/mobile`) with sign-in/up, Home, Inbox, Ask, Settings (light/dark theme), talking to the real API via bearer-token auth. Verified live via Playwright driving `expo start --web` — sign-up, session persistence across reload, tab navigation, dark-mode toggle. **Not done**: no actual iOS/Android simulator or device build has been produced (needs Xcode/Android Studio/EAS Build, unavailable here); theme preference isn't persisted across restarts; no share extension, widgets, biometrics, or push notifications; Life/Documents/Timeline/Connections screens don't exist on mobile yet (only the core Home/Inbox/Ask/Settings loop). |
| Desktop (macOS/Windows) | ❌ Not started. |
| Browser extension | ❌ Not started. |
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
   Still missing: user-facing merge/unmerge with lineage (the `entity_merge_lineage`
   table exists, nothing writes to it yet), and VIN/tracking-number matching
   for domains beyond commerce. **Known gap**: the known-sender fast path
   (`matchKnownSender`) maps one sender domain to exactly one category, so a
   shipping-confirmation email from a sender categorized as "receipt" (e.g.
   amazon.com) still routes through the receipt extractor rather than the
   shipment one — fine for senders that only ever send one type of email,
   wrong for ones (like Amazon) that send both from the same domain.
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
6. **Outlook/Microsoft connector** — second direct-API email source; the
   connector interface (`@veynlo/core`'s `ProviderAdapter`) was designed to
   make this an adapter addition, not a pipeline rewrite.
7. **PDF OCR** — wire Anthropic's beta document-input surface (`client.beta.messages`),
   or a dedicated OCR engine if volume/cost data favors it.
8. **Gmail incremental/recurring sync** — today a connection only syncs once,
   right after OAuth completes (the "initial" job). Nothing re-syncs it
   afterward. Real incremental sync needs a recurring job (or Gmail push
   notifications via `watch()`) plus `history.list` keyed off a stored
   `connections.cursor` — the schema already has the `cursor` column, and
   the queue already accepts a `kind: "incremental"` job, but nothing
   schedules one yet.

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

- No rate limiting beyond a blanket 300 req/min global throttle — no
  per-endpoint or per-user tiers yet.
- No malware scanning on document uploads (MIME/size/hash validated; no AV).
- No automated backup/restore drills (spec §49.2/49.3) — local dev only.
- Structured audit logging exists and is used by the admin console
  (`audit_events`, written on every support lookup); consumer-side actions
  (household changes, sharing changes, corrections) don't write to it yet.
- No admin *management* UI/API yet — creating/revoking operator accounts is
  a CLI script (`create-admin`), not a self-service superadmin console.
- Session refresh-token rotation is not implemented — the current session
  cookie is a single long-lived JWT re-checked against a revocable DB row
  per request (safe against revocation, but not the full rotating-refresh-
  token flow the spec describes for mobile).
