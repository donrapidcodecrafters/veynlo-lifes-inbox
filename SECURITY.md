# Security

This document describes what's actually implemented — not an aspirational
policy — plus an honest checklist of what's still needed before this app
should go in front of the App Store, the Play Store, or a real pentest.
Status reflects the current state of this repository.

## Data protection at rest — field-level encryption

Every genuinely sensitive piece of user content is encrypted at the
application layer with AES-256-GCM before it reaches Postgres — not "every
cell," which would be both wrong (primary keys, foreign keys, enums used in
`WHERE` clauses, and timestamps used for sorting/range queries have to stay
plaintext or the database stops working) and misleading (a lookup key isn't
"content" in the sense that matters for this app's threat model: someone
with `psql` access to a stolen backup).

- **What's covered**: free-text and structured content columns across every
  domain — display names, document titles/OCR text/tags, calendar event
  titles/locations, task titles, purchase/subscription/bill details, automation
  rule descriptions and run payloads, audit event before/after snapshots,
  notification bodies, source-event raw content refs, canonical-entity labels
  and facts. ~40 columns across every schema file (`packages/db/src/schema/`),
  each one deliberately chosen, not blanket-applied.
- **What's deliberately not covered, and why**: `users.email` and
  `identityLinks.providerSubject` (equality-lookup keys — AES-GCM's random IV
  makes every encryption non-deterministic, so an encrypted column can't
  support `WHERE email = ?` without a separate deterministic/blind-index
  scheme, which isn't built here), dedup/idempotency keys, foreign keys, enums,
  and `search_documents` (the full-text/pgvector search table — encrypting the
  very columns Postgres needs to search would defeat the table's entire
  purpose; confidentiality there relies on strict authorization checks + audit
  logging + disk-level encryption instead, same as any encrypted-at-rest
  database).
- **Implementation**: `packages/db/src/crypto/field-encryption.ts`
  (`encryptField`/`decryptField`) plus a Drizzle `customType` wrapper
  (`packages/db/src/schema/encrypted-type.ts`, `encryptedText`/`encryptedJsonb`)
  that encrypts on write and decrypts on read transparently — application code
  at nearly every call site needed zero changes. The one exception is
  `TimelineService`, which uses a raw SQL `UNION ALL` query (Drizzle's
  transparent decode only applies through the query-builder API) and manually
  calls `decryptField` on the columns it selects that are encrypted.
- **Key management**: `FIELD_ENCRYPTION_KEY` (required in production — see
  below), with explicit operator-set integer versioning
  (`FIELD_ENCRYPTION_KEY_VERSION`) rather than an implicit "current vs.
  previous" role, because the implicit version was tried first and this
  module's own test suite caught it silently breaking on a second rotation
  before it shipped. To rotate: generate a new key, bump the version, move the
  old key/version to `FIELD_ENCRYPTION_KEY_PREVIOUS`/
  `FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION` (kept decrypt-only), deploy, then run
  a backfill that re-reads and re-writes every row still under the old
  version before removing it — no backfill script exists yet since this
  repository has never had a real rotation to run.
- **Separate key for OAuth tokens**: `CredentialVault`
  (`services/api/src/common/credential-vault.ts`) uses the same AES-256-GCM
  scheme but a separate `CREDENTIAL_ENCRYPTION_KEY`, so the two data classes
  rotate independently.
- **Startup enforcement**: `services/api/src/config/env.ts`'s `loadEnv()`
  refuses to start in `NODE_ENV=production` if `SESSION_JWT_SECRET`,
  `CREDENTIAL_ENCRYPTION_KEY`, or `FIELD_ENCRYPTION_KEY` is still a dev-default
  value or under 32 characters — an unrotated secret in production is a
  silent, severe vulnerability, not a config nicety.
- **Verified live, not just typechecked**: raw `psql` inspection confirmed
  stored bytes are genuinely ciphertext (not base64-of-plaintext), a fresh
  Postgres database was used for the encryption migration rather than casting
  existing plaintext rows (a bare `jsonb::text` cast would have preserved old
  plaintext bytes as a text string, not encrypted them — fine pre-launch with
  no real user data, not fine as a real migration strategy later).

## Account deletion

`POST /v1/auth/delete-account` (App Store Guideline §5.1.1(v) / Play Store
User Data policy both require in-app self-service deletion, not "contact
support").

1. Verifies the caller's password.
2. Blocks with a clear `HOUSEHOLD_OWNER_MUST_TRANSFER` error if the user owns
   a household with other active members — billing/ownership responsibility
   is never silently reassigned without consent.
3. Otherwise, synchronously: sets `users.status = 'deletion_pending'`, revokes
   every session, and enqueues a durable `account-deletion` BullMQ job. The
   account is unusable the instant the request returns — sign-in and
   `AuthGuard` both independently reject `deletion_pending`/`deleted`
   accounts as defense-in-depth against the narrow window before revocation
   takes effect.
4. The background job hard-deletes solo-owned households (cascading their
   memberships/dependents), deletes the `users` row (cascading through
   almost everything else via existing foreign keys), deletes the user's S3
   document blobs, and writes an `audit_events` row that survives the user
   row's deletion (`actor_id` there is a plain string column, not a foreign
   key, by design).
5. Five `users.id` foreign keys were fixed to make the hard delete actually
   work: `caregiver_delegations`/`resource_grants.granted_by_user_id` and
   `share_links.created_by_user_id` now cascade (an authorization granted by
   a deleted account is no longer valid); `automation_runs.approved_by_user_id`
   and `entity_merge_lineage.actor_user_id` now set null (the record is an
   audit trail that should survive; only the identifying link clears).

Verified live end-to-end: wrong password rejected, correct password revokes
the session and blocks re-sign-in, a household owner with other active
members is blocked, a solo owner's deletion cascades the household away, and
the worker log confirms the job completes with the user row and household
both gone from Postgres while the `audit_events` row persists.

**Not yet built**: a "cancel my deletion" window — the account becomes
unusable immediately on request (all sessions revoked synchronously), so
there's no grace period during which cancelling would mean anything today.
If a grace period is ever wanted, it needs to be a deliberate product
decision (how long, what "cancel" means when sessions are already gone), not
a default.

## Network-layer hardening

- **Security headers**: `@fastify/helmet` (HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`, etc.) on every response. Content-Security-Policy is
  disabled — this is a pure JSON API with no HTML views of its own to
  protect; a default CSP would only add response noise.
- **Rate limiting**: a global 300 req/60s throttle
  (`services/api/src/app.module.ts`), with tighter per-route overrides on
  the endpoints that are actually attractive targets: sign-in and
  delete-account at 10/60s, sign-up at 20/60s, admin sign-in at 10/60s (the
  highest-value credential target in the system). Verified live — the 11th
  rapid sign-in attempt in a 60-second window returns 429.
- **CORS**: origin allowlist (web app + admin app origins; localhost only in
  development), credentials enabled for the cookie-based session flow.
- **Cookies**: `httpOnly`, `sameSite: lax` (consumer) / `sameSite: strict`
  (admin — never embedded/cross-site), `secure` in production.
- **Sessions**: a JWT re-checked against a revocable database row on every
  request, not trusted on signature alone — revocation (sign-out-everywhere,
  account deletion, household removal) takes effect immediately rather than
  waiting for token expiry.

## Passwords and secrets

- Passwords hashed with argon2 (`argon2.hash`/`argon2.verify`), never stored
  or logged in plaintext.
- No secret is hardcoded — all configuration is read from environment
  variables via a Zod schema (`services/api/src/config/env.ts`), validated
  once at boot, with a hard production-only check (above) against
  insecure/default values for the three encryption/signing secrets.

## What this does NOT cover yet — read before submitting to a store or a pentest

These are real gaps, not hedging:

- **No privacy policy or terms of service text exists anywhere in this
  repository.** Both stores require a live, linked privacy policy URL before
  they'll even let you submit a build for review. This is legal/business
  content, not something that should be auto-generated by an AI without a
  human (ideally counsel, given the data classes involved — financial,
  health-adjacent, family/dependent information) reviewing it.
- **No App Store Connect / Google Play Console account setup, app listing,
  screenshots, or review-form answers exist.** All of that is a human/business
  action taken in each platform's own console, not a code change.
- **No third-party penetration test has been run.** Nothing in this document
  should be read as "pentested" — it's a description of what defenses exist,
  written by the same process that built them. An actual pentest needs to be
  a paid, independent engagement before this app handles real user data on
  real infrastructure.
- **iOS privacy manifest (`PrivacyInfo.xcprivacy`)**: not manually added at
  the app level. Expo's own native modules (SDK 51+) ship their own privacy
  manifests bundled via CocoaPods, and the mobile app currently uses none of
  the "required reason API" categories directly (no `UserDefaults`,
  file-timestamp, or disk-space APIs called from app code) — but this is the
  kind of thing Xcode's own Archive → Validate step checks definitively
  against the actual compiled binary, and should be verified there before
  submission rather than assumed correct from static analysis.
- **Mobile runtime permissions**: `apps/mobile/app.json` declares no
  `infoPlist` usage-description strings or Android `permissions` array. This
  is currently correct, not an oversight — the mobile app has no camera,
  photo library, document picker, push notification, biometric, contacts, or
  location code today (document upload is web-only; see
  `docs/ROADMAP.md`). Adding an unused permission string is itself an App
  Store review flag. If any of those features are added to the mobile client,
  add the matching Expo module and usage-description string at that time, not
  ahead of it.
- **Malware scanning on document uploads**: real, via a ClamAV sidecar
  (`docker compose up -d clamav`) speaking clamd's INSTREAM protocol
  directly — MIME type, size, and content hash are also validated. Optional
  in local dev (unset `CLAMD_HOST` skips scanning); fails *closed* once
  configured, so a scanner outage rejects uploads rather than silently
  accepting unscanned files. Verified live with a real EICAR test file
  (correctly detected and rejected, never stored) — production deployment
  still needs the ClamAV service actually provisioned and `CLAMD_HOST` set,
  which isn't automatic outside this repo's Docker Compose.
- **No automated backup/restore drills** — local dev only; production backup
  strategy is undecided.
- **Consumer-side actions aren't all audited yet** — `audit_events` is
  written for admin support lookups and account deletion, but household
  changes, sharing changes, and corrections don't write to it yet.
- **`pnpm audit` runs in CI but is informational, not blocking**
  (`.github/workflows/ci.yml`) — as of this writing it reports 23 findings (0
  critical after bumping `vitest` off a critical arbitrary-file-read CVE that
  only mattered if `vitest --ui` were ever run, which nothing here does; the
  rest are moderate/high findings in dev-only build tooling — Next.js/postcss,
  Expo/metro's image parsing — not runtime attack surface for the deployed
  API). Triage and clear these for real before a store submission or pentest;
  run `pnpm audit` locally for the current list. No SAST or secret-scanning
  in commits is wired in yet.
- **Session refresh-token rotation is not implemented** — sessions are a
  single long-lived JWT re-checked against a revocable DB row per request
  (safe against revocation, not the full rotating-refresh-token flow a
  stricter mobile-security posture would use).

## Pre-submission checklist

Code-level items above are done or explicitly called out as not done. Before
an actual store submission or pentest engagement, someone needs to:

- [ ] Write and publish a real privacy policy + terms of service, reviewed
      by counsel given the data classes this app handles.
- [ ] Set real production values for `SESSION_JWT_SECRET`,
      `CREDENTIAL_ENCRYPTION_KEY`, and `FIELD_ENCRYPTION_KEY` (32+ random
      bytes each, via a real secrets manager — `loadEnv()` will refuse to
      boot otherwise).
- [ ] Run `expo run:ios --configuration Release` (or an actual Xcode Archive)
      and check the Validate App step for privacy-manifest / required-reason
      API findings before assuming none exist.
- [ ] Engage a real third-party penetration test once the above are in place
      and before any real user data touches production infrastructure.
- [ ] Fill in the store listings themselves (screenshots, descriptions,
      review-account credentials, data-safety/App Privacy questionnaires) —
      the account-deletion and data-handling answers on those forms should
      match this document.
