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
| Documents/vault | ✅ Upload, S3 storage, image OCR via Claude vision. PDF OCR not built (needs Anthropic's beta document-input surface). |
| Notifications | 🟡 Preferences + history schema/API exist. No actual push/email delivery, no digest composition, no quiet-hours enforcement logic yet. |
| Billing/entitlements | ✅ Stripe checkout + webhook + entitlement resolution. App Store/Play Store receipt verification not built (mobile doesn't exist yet either). |
| Admin console | 🟡 User lookup, connector health, audit log read endpoints exist behind a shared-secret header. Real RBAC/break-glass/audit-of-access is not built. |
| Web app (Home/Inbox/Ask/Life/Connections/Settings) | ✅ Built, responsive, light/dark theme, real API integration. |
| Mobile (iOS/Android) | ❌ Not started. |
| Desktop (macOS/Windows) | ❌ Not started. |
| Browser extension | ❌ Not started. |
| CI/CD | ❌ Not started — no GitHub Actions workflow yet. |
| Observability (structured logs/metrics/tracing) | ❌ Not started — only Nest's default console logger. |

## Immediate next priorities (in order)

1. **Background job workers** (`services/workers`, BullMQ + Redis are already
   dependencies) — connector sync currently runs inline on the request that
   triggers it (OAuth callback), which won't survive a large mailbox or a
   process restart mid-sync. This is the biggest correctness gap.
2. **Notification delivery** — compose and send the daily/weekly brief,
   push notifications for critical attention items, respecting quiet hours.
3. **Entity resolution v2** — real merge/unmerge with lineage, order-ID/
   tracking-number/VIN-based matching per §40.1, not just merchant-name.
4. **CI** — GitHub Actions: install, typecheck, lint, test, build on every
   PR. Nothing enforces "keep the project runnable" automatically yet.
5. **Real admin RBAC** — replace the shared-secret header with per-operator
   accounts and audited, scoped access before any real user data exists.
6. **Outlook/Microsoft connector** — second direct-API email source; the
   connector interface (`@veynlo/core`'s `ProviderAdapter`) was designed to
   make this an adapter addition, not a pipeline rewrite.
7. **PDF OCR** — wire Anthropic's beta document-input surface (`client.beta.messages`),
   or a dedicated OCR engine if volume/cost data favors it.

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

- Admin access control (shared secret, not per-operator RBAC).
- No rate limiting beyond a blanket 300 req/min global throttle — no
  per-endpoint or per-user tiers yet.
- No malware scanning on document uploads (MIME/size/hash validated; no AV).
- No automated backup/restore drills (spec §49.2/49.3) — local dev only.
- No structured audit logging wired into the actual request path yet
  (the `audit_events` table exists; nothing writes to it yet).
- Session refresh-token rotation is not implemented — the current session
  cookie is a single long-lived JWT re-checked against a revocable DB row
  per request (safe against revocation, but not the full rotating-refresh-
  token flow the spec describes for mobile).
