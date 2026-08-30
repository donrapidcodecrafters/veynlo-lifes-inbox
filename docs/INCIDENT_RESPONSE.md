# Incident response

Same voice as `SECURITY.md`: what's actually here, not an aspirational
policy. This is a real runbook for the levers that actually exist in this
codebase today, plus honest notes on where a lever doesn't exist yet and
what the manual workaround is. Read `SECURITY.md` first for the security
posture this runbook assumes.

There is no on-call rotation, paging system, or status page wired up
anywhere in this repository — those are operational/business setup, not
code. This document only covers what to *do* once you're aware of an
incident, using the tools that exist.

## First: what "aware of an incident" looks like

- `GET /health/live` / `GET /health/ready` (`services/api/src/modules/health/health.controller.ts`) — process/DB liveness, unauthenticated, `@SkipThrottle()`.
- `GET /metrics` — Prometheus exposition (`services/api/src/metrics/`), `http_requests_total`/`http_request_duration_seconds` labeled by route template + status code, plus Node process defaults. Unauthenticated, `@SkipThrottle()`. Nothing scrapes or dashboards this yet in this repo — point a Prometheus/Grafana instance at it, or `curl` it directly during an incident.
- `GET /v1/admin/connectors/health` and `GET /v1/admin/model-health` (admin-only, `AdminGuard`) — real connector sync failure rates and AI extraction failure rates off `extraction_runs`/`extractor_versions`, not stubbed.
- `GET /v1/admin/audit-events` (admin-only) — the `audit_events` table (admin support lookups, account deletion, household changes, sharing changes, Inbox corrections; see `SECURITY.md`'s audit-coverage note for what's *not* logged yet).
- Logs: structured JSON via `nestjs-pino`, whatever your process supervisor/log aggregator captures stdout as — no log shipping is configured in this repo.

## Incident: a secret or API key leaked

Applies to any of: `SESSION_JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`FIELD_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`REVENUECAT_WEBHOOK_AUTH_HEADER`, `ANTHROPIC_API_KEY`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_SECRET` (see
`services/api/.env.example` for the full list).

1. **Rotate at the source first** — regenerate the credential in the
   provider's own dashboard (Stripe, Anthropic, Google/Microsoft OAuth app,
   RevenueCat) or generate a fresh random value (session/encryption
   secrets). Do this before anything else — an old value staying valid
   anywhere is the actual exposure.
2. **`SESSION_JWT_SECRET`**: rotating it invalidates every existing session
   immediately (signature check fails) — every signed-in user gets signed
   out. There's no partial/gradual rotation for this one; it's a hard cut.
3. **`CREDENTIAL_ENCRYPTION_KEY`** (OAuth tokens via `CredentialVault`) /
   **`FIELD_ENCRYPTION_KEY`** (everything else — see `SECURITY.md`'s field
   list): rotating these **without a backfill breaks decryption of every
   row still under the old key**. `FIELD_ENCRYPTION_KEY_VERSION` +
   `FIELD_ENCRYPTION_KEY_PREVIOUS`/`_PREVIOUS_VERSION` exist specifically so
   the old key stays available *decrypt-only* while a backfill re-writes
   rows under the new key — **no backfill script exists in this repo yet**,
   since there's never been a real rotation to run. Write one before you
   need it, not during the incident: read every row of every encrypted
   column, decrypt under the previous key, write back (which re-encrypts
   under the current key by virtue of the `encryptedText`/`encryptedJsonb`
   custom type's normal write path), track progress so it's resumable.
4. **Stripe/RevenueCat/OAuth client secrets**: rotate in the provider
   dashboard, update the env var, redeploy. Stripe webhook secret rotation
   needs the new value in `STRIPE_WEBHOOK_SECRET` *before* the old one is
   deactivated in the Stripe dashboard, or you'll drop webhook deliveries in
   between.
5. Redeploy with the new values. `loadEnv()` (`services/api/src/config/env.ts`)
   refuses to boot in `NODE_ENV=production` if `SESSION_JWT_SECRET`,
   `CREDENTIAL_ENCRYPTION_KEY`, or `FIELD_ENCRYPTION_KEY` is still a
   dev-default or under 32 characters — a genuine safety net if the
   redeploy accidentally ships without the rotation.

## Incident: a specific user's account is compromised

1. **Force sign-out**: the user's own `POST /v1/auth/sessions/:sessionId/revoke`
   or `POST /v1/auth/sign-out-everywhere` exist, but **there is currently no
   admin-side "force revoke this user's sessions" endpoint** — `AdminService`
   has `findUserByEmail`/`grantEntitlement`/`revokeEntitlement` but nothing
   that touches `sessions`. Until that's built, the manual workaround is a
   direct DB statement against the `sessions` table (mark every active
   session for that `user_id` as revoked — check `AuthGuard`
   (`services/api/src/common/auth.guard.ts`) for the exact revocation
   condition it checks before mutating anything, since the guard's read
   path is the source of truth for what "revoked" means).
2. **Change the password**: same gap — no admin-initiated password reset
   exists yet. The user's own real `POST /v1/auth/forgot-password` /
   `POST /v1/auth/reset-password` flow (`identity.controller.ts`) is the
   only path today, and requires the user to still control their email.
3. **Check what the account touched**: `GET /v1/admin/audit-events`
   filtered to the user, plus `GET /v1/admin/users/lookup` for the
   redacted support view (`AdminService.findUserByEmail` — explicitly
   excludes message/document bodies by design, so this alone won't show you
   *content* the attacker saw, only account-level metadata).
4. **Connections**: if the compromise could have touched a connected
   Gmail/Outlook/calendar account, the user (not an admin — see above) needs
   to `POST /v1/connectors/:connectionId/disconnect` with
   `deleteDerivedData: true` for each affected connection.

## Incident: data may have leaked (broader than one account)

1. Check `GET /v1/admin/audit-events` for the access pattern — this is the
   only cross-cutting log of *who did what* in this system today. Its
   coverage is real but partial: household changes, sharing changes, Inbox
   corrections, admin support lookups, and account deletion are logged.
   Document/calendar-event edits outside those flows and most Settings
   changes are **not** logged yet (see `SECURITY.md`'s audit-coverage
   note) — if the leak vector is one of those, the audit trail won't show
   it, and you're reconstructing from database timestamps/backups instead.
2. `packages/authz/src/policy.ts`'s `resolveAccess`/`requireAccess` is the
   single deny-by-default access-control chokepoint — if the leak looks
   like a broken authorization check rather than a stolen credential, that
   file (and its one real test, `packages/authz/src/policy.test.ts`) is
   where to start. Coverage note: this policy is unit-tested for the core
   owner/household/grant/deny cases, but there's currently no automated
   test asserting that `search`, `notifications`, `data-export`, or the
   `admin` module actually *call* it on every code path — that's a real,
   open gap (see `docs/ROADMAP.md`'s twenty-fifth pass), so a leak via one
   of those surfaces wouldn't necessarily be caught by existing tests.
3. Malware/malicious-upload angle: `MalwareScannerService`
   (`services/api/src/modules/documents/malware-scanner.service.ts`) fails
   *closed* — an unscannable file is rejected, not silently accepted — but
   only when `CLAMD_HOST` is actually configured. Confirm it's set in the
   environment where the incident happened before ruling out an infected
   upload as the vector.
4. Feature flags exist (`GET`/`POST /v1/admin/feature-flags`,
   default-*disabled* for any key with no row — a real kill-switch
   convention) and now have real call sites, both server- and client-side:
   `android_notification_capture` (checked client-side by the mobile app
   via `GET /v1/feature-flags` before any native SMS/RCS capture code
   runs — `apps/mobile/src/lib/notification-capture.ts`),
   `ai_extraction_disabled` (checked server-side in `IngestionService`
   before any AI classification/extraction call — a real cost/incident
   kill switch for the single most expensive code path in the pipeline),
   and `connector_sync_${provider}_disabled` (checked in the worker's
   connector-sync job processor, per provider — e.g.
   `connector_sync_gmail_disabled`). Flipping one of these now genuinely
   changes runtime behavior on the next request/job, not just after a
   redeploy. Flags with no call site still exist as inert config rows —
   check the specific key before assuming it does something.

## Incident: a background job or connector sync is misbehaving

- The worker process (`services/api/src/worker-main.ts`) handles
  `connector-sync`, `connector-scan`, `notification-dispatch`,
  `notification-delivery`, `account-deletion`, `connection-data-deletion`,
  `inbox-unsnooze`, `attention-scan`, `data-export`, and
  `data-retention-scan` — all BullMQ queues against the same Redis instance
  the API uses (`REDIS_URL`).
- **Stopping the worker process stops all of the above at once** — there's
  no per-queue pause exposed anywhere in this repo (BullMQ itself supports
  `queue.pause()`, but nothing here calls it). If only one queue is
  misbehaving (e.g. a connector sync loop hammering Gmail's API), killing
  the whole worker is the blunt-but-real lever until a more targeted one is
  built.
- Jobs retry with exponential backoff (`attempts: 3, backoff: { type:
  "exponential", delay: 2000 }` — see `queue-producer.service.ts` for the
  per-queue specifics) and a job that keeps failing shows up as a real
  `ERROR`-level log line naming the job ID and queue, not a silent drop.

## Incident: billing is wrong (double-charged, wrongly entitled, refund not reflected)

- `GET /v1/admin/users/lookup?email=...` then
  `POST /v1/admin/users/:userId/entitlements` /
  `POST /v1/admin/entitlements/:id/revoke` — real, audited (`recordAccess`)
  admin tooling for manually correcting a user's plan (support-level
  `AdminGuard`, a routine reversible action).
- `GET /v1/admin/users/:userId/charges` /
  `POST /v1/admin/charges/:chargeId/refund` — a real, live Stripe
  refund-issuance endpoint (not just entitlement bookkeeping): lists a
  user's actual Stripe charges and can issue a real `stripe.refunds.create`
  against one. Gated behind `SuperAdminGuard`, not the ordinary support-level
  `AdminGuard` the entitlement/kill-switch/risk-policy actions use — real
  money leaves the business here and it isn't reversible by Veynlo itself
  (a refunded refund isn't a thing), the same tier as revoking another
  admin's account. Refuses to act on a charge that doesn't resolve back to
  a known Veynlo user (via the same reverse `stripeCustomerId` lookup the
  `charge.refunded` webhook reconciliation below uses) and refuses an
  already-fully-refunded charge. Every refund is audited
  (`admin.charge_refund`, with the refund ID/amount/note in `afterJson`) —
  after issuing one, expect the `charge.refunded` webhook to arrive shortly
  after and reconcile the entitlement automatically (see below); it isn't a
  separate manual step.
- `billing_events` (both `source: "web_stripe"` and the RevenueCat rows)
  is the append-only raw record of every webhook Veynlo has received,
  deduped by `(source, external_event_id)` — the first place to look to
  confirm whether a webhook actually arrived and was processed, versus
  never sent by the provider at all.
- Refund reconciliation (`charge.refunded` / RevenueCat `REFUND`) is real
  as of the twenty-fifth `docs/ROADMAP.md` pass — a genuinely refunded
  charge now revokes the entitlement it paid for automatically. If a
  refund isn't reflected, check `billing_events` first for whether the
  webhook arrived at all before assuming the reconciliation code is at
  fault.

## What this runbook doesn't cover, on purpose

Matching `SECURITY.md`'s honesty: there is no on-call schedule, no paging
integration, no status page, no customer-communication template, and no
legal/breach-notification process documented anywhere in this repository.
Those are real organizational decisions this document can't make for you —
write them when there's a real team and a real user base to write them for,
not speculatively here.
