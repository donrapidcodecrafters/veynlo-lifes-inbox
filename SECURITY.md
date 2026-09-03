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
  and facts. 53 columns across every schema file (`packages/db/src/schema/`)
  as of 2026-08-31 — re-run `grep -c "encryptedText(\|encryptedJsonb<"
  packages/db/src/schema/*.ts` rather than trust this number, since it grows
  as new tables add encrypted columns (this line itself was a stale "~40"
  for a while after the real count had already moved) — each one
  deliberately chosen, not blanket-applied.
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
  (`.github/workflows/ci.yml`) — as of 2026-08-31, after bumping `nodemailer`
  6.9 → 9.1 (which fixed 8 real advisories, including a high-severity
  arbitrary-file-read/full-response-SSRF issue via its `raw` message option
  and a recursive-parser DoS — this app's own usage doesn't take user input
  into either vulnerable path, but there's no reason to leave a patchable
  runtime dependency on an old major version once noticed), `pnpm audit
  --prod` reports 9 remaining findings (0 critical, 5 high, 4 moderate):
  `drizzle-orm@0.38` (SQL injection via improperly escaped identifiers,
  patched in 0.45.2+ — this codebase has zero call sites using
  `sql.identifier`/`sql.raw` with dynamic values, the only way this is
  reachable, but the fix itself is a real cross-cutting version bump across
  every schema/migration and deserves its own dedicated regression pass, not
  a drive-by one), `postcss` (multiple sourcemap-disclosure issues, all
  transitive through `apps/admin`'s Next.js version — dev/build-tooling
  surface, not the deployed API), and `uuid` (a buffer-bounds issue in a
  code path — v3/v5/v6 with an explicit buffer argument — nothing here
  calls). Triage and clear the `drizzle-orm` one for real before a store
  submission or pentest; run `pnpm audit` locally for the current list. No
  SAST or secret-scanning in commits is wired in yet.
- ~~Session refresh-token rotation is not implemented~~ — done 2026-08-31 for
  native clients (rotating refresh token with reuse detection —
  `POST /v1/auth/refresh`, see docs/ROADMAP.md for what was verified live).
  Web's cookie session is unchanged.
- **A self-directed adversarial pass (2026-08-31), not a substitute for the
  independent pentest above.** Checked and found correctly enforced, live
  against the running API and two real seeded users: cross-tenant IDOR
  (purchases/bills/warranties/documents/connections by ID), mass-assignment
  on household creation (client-supplied `id`/`billingOwnerUserId` were both
  ignored server-side), and admin/consumer session isolation (a regular
  user's session cookie is flatly rejected by admin-guarded routes). Also
  hardened: every `jwtVerify` call site now pins an explicit algorithm
  allowlist (defense-in-depth — not a live exploit, since these are all raw
  HMAC secrets rather than a public/private keypair that could be confused);
  added per-route rate limits to document upload, data export, and Ask
  (Ask's real cost control is the new per-plan daily quota in
  `EntitlementsService` — this is the secondary per-minute layer). Also
  found and fixed, while wiring the mobile OAuth deep-link redirect: the
  four connector OAuth callback routes required an authenticated session
  that a native OAuth round-trip through the system browser can never
  carry, meaning native connector-connect was silently broken end-to-end
  regardless of the deep-link question — see docs/ROADMAP.md's Mobile row.
- **A second, broader audit pass (2026-08-31), driven by a systematic
  section-by-section read of the architecture blueprint plus a live
  spot-check against this doc/ROADMAP.md's own claims** — found and fixed
  several more real issues, all verified live against the running API:
  - **Critical, previously-undiscovered: `.env` was never actually loaded.**
    Nothing in `services/api` ever called `dotenv` or Node's own
    `process.loadEnvFile` — every value in `EnvSchema` with a `.default(...)`
    happened to already match `.env.example`, which is exactly why this went
    unnoticed. Any real credential a developer put in `.env` (a real Google/
    Microsoft OAuth client, an Anthropic key, Stripe keys, ClamAV, inbound
    email) was silently ignored, with the app still reporting "not
    configured" no matter what was actually in the file. Fixed via
    `services/api/src/config/load-env-file.ts`, imported first (a side-effect
    import, before every other import) in `main.ts`/`worker-main.ts`/
    `create-admin.ts` — a first attempt that called a loader function as the
    first line of `bootstrap()` was still too late, because `env.ts`'s
    `loadEnv()` cache gets populated even earlier, during `AppModule`'s
    import graph resolution (`logging.module.ts`'s `@Module()` decorator
    calls `loadEnv()` as a static argument). Verified live end-to-end with a
    real Microsoft OAuth app registration: before the fix, `/v1/auth/
    microsoft/authorize` 302'd to `oauth_not_configured` despite real
    credentials in `.env`; after, it correctly redirects to
    `login.microsoftonline.com` with the real `client_id`.
  - **The webhook ingress ran AI synchronously** — `POST /v1/ingestion/
    inbound-email` used to call the full classify/extract pipeline inline in
    the request handler, contrary to "never call large AI models
    synchronously from webhook handlers." Now enqueues a job and returns
    immediately (~16ms, confirmed live via `curl`'s own timing); the worker
    process does the real work (`worker-main.ts`'s `inboundEmailIngestWorker`).
  - **Microsoft sign-in's `id_token` had no signature verification** — Google's
    already did (via `googleapis`' `verifyIdToken`); Microsoft's was a bare
    base64 decode. Fixed using `jose`'s `createRemoteJWKSet` against
    Microsoft's multi-tenant JWKS endpoint, with `audience` checked against
    the configured client id.
  - **No CSRF protection on cookie-authenticated state-changing routes** —
    `SameSite=Lax` still allows a cross-site `<form>` POST to carry the
    session cookie. Fixed with a custom-header requirement
    (`services/api/src/common/csrf.ts`) a plain HTML form cannot forge;
    verified live that a request without the header gets a real `403` and
    bearer-token (native mobile) requests are correctly unaffected.
  - **No password reset flow existed at all** — a local-password user who
    forgot their password had no way back into their account. Built and
    verified live end-to-end (real email via Mailhog, real password change,
    single-use token, and — deliberately — every existing session revoked on
    a successful reset).
  - **Sensitive financial/calendar detail went into notification emails by
    default with no opt-out** — added `notificationPreferences
    .sensitivePreviewsEnabled` (default `true`, preserving existing
    behavior) and a real Settings toggle; verified live that disabling it
    replaces real order/bill/event detail with a generic "open Veynlo to see
    the details" body.
  - **The desktop app hardcoded `http://localhost:3000` even in real release
    builds** — a distributed `.app`/`.dmg` would show a blank window for any
    real user. Fixed via `apps/desktop/src-tauri/src/lib.rs` building the
    window imperatively (`cfg!(debug_assertions)` picks dev vs. release URL)
    with an `on_navigation` origin allowlist added at the same time; verified
    with a real `cargo build` + launched binary.
  - **The worker process could not boot at all in this exact working tree** —
    surfaced while adding the `Connector`/`ObjectStorage`/`ModelProvider`/
    `Queue` interfaces §37 asks for: `GmailAdapter` and its four siblings
    failed dependency resolution specifically under `createApplicationContext`
    (never under the plain HTTP bootstrap), meaning no account deletion,
    connector sync, or notification delivery ever actually ran in this
    environment. Fixed with explicit `@Inject()` on every constructor
    parameter in the five connector adapters; verified live that a queued
    account-deletion job now actually completes.

- **2026-08-31 (second pass): live end-to-end testing found real bugs, all fixed and re-verified live.**
  Ran 6 parallel agents exercising every backend feature domain against the real running API/worker/DB —
  identity/auth, admin console, search/notifications/billing/flags, household/commerce/schedule/documents,
  connectors/ingestion, data-export/attention/timeline — not by reading code, but by actually calling
  endpoints and inspecting DB rows. Found and fixed:
  - **Household invites were a complete dead end for real users.** `POST /households/:id/invite` created a
    `status:"invited"` row, but no endpoint anywhere could ever turn it into an active membership, no email
    was ever sent (despite a comment claiming otherwise), and the web/mobile apps had zero household UI at
    all — an invited person had no way to discover the invite existed short of direct DB access. Fixed:
    added `inviteTokenHash`/`inviteTokenExpiresAt` to `household_memberships` (same
    hash-at-rest/single-use shape as `passwordResetTokens`, extracted into a shared
    `generateOpaqueToken`/`hashOpaqueToken` helper in `packages/core`), `invite()` now actually emails a
    real accept link, and two new endpoints exist: unauthenticated `GET /v1/households/invite?token=` (peek,
    for rendering the prompt before sign-in) and authenticated `POST /v1/households/accept-invite` (requires
    the signed-in user's email to match the invite, re-uses the seat already reserved at invite time rather
    than double-counting it). Built a matching web page (`/accept-invite`) plus `redirectTo` support on
    sign-in/sign-up so a logged-out invitee can create an account and land back on the accept flow. Verified
    fully live: real invite → real Mailhog email → peek → sign-up → accept → membership active in DB; also
    verified the negative paths (garbage token, reused token, wrong-account token) all correctly reject.
    Also confirmed there was no household *management* UI anywhere (create/invite-form/member-list/
    delegations) — asked the user, was told to build it, added a full web Settings → Household page
    (create, member list, invite form, dependents, delegation grant/revoke) and verified every action live
    against the real API. Mobile still has no household UI — deliberately deferred. See docs/DECISIONS.md.
  - **Shipment dedup matched by tracking number globally, not per-owner** — two different users' shipments
    sharing a carrier tracking number (not implausible: many carriers reuse formats/ranges) could silently
    overwrite each other's row, a real cross-tenant data-corruption bug. Found live by the connectors-testing
    agent hitting an actual collision against seed data. Fixed by adding a real `ownerUserId` column to
    `shipments` (it previously had no way to be scoped at all when unlinked to a purchase/return case),
    scoping the dedup lookup by it, and fixing data-export to query shipments directly by owner instead of
    only through a purchase join (which was also silently excluding unlinked shipments from a user's export).
  - **Demo seed data's `evidence` view was always null** — `purchases`/returns set `sourceEventId` pointing
    at `source_events` rows the seed script never actually inserted. Seed-data bug only (the join code was
    already correct), fixed by inserting the missing rows.
  - Everything else tested (session/CSRF/OAuth flows, quota enforcement, cross-tenant IDOR spot-checks on
    purchases/bills/documents/connections, SSRF guarding on URL capture, admin/consumer session isolation,
    data-export contents/rate-limit, inbox confirm/correct/snooze/dismiss including a live unsnooze-worker
    tick, timeline ordering/decryption) passed with no fixes needed.
  - **A single row with malformed ciphertext threw a hard 500 for an entire encrypted-column list query**
    (e.g. `GET /v1/warranties`) — fixed same day, on request. Root cause: `encryptedText`/`encryptedJsonb`'s
    `fromDriver` (packages/db/src/schema/encrypted-type.ts) called `decryptField` directly, and Drizzle
    calls `fromDriver` while mapping every row of a result set, so one bad row failed the whole query.
    Fixed by catching the decrypt failure per-cell: `encryptedText` now returns a fixed placeholder string
    (`DECRYPTION_FAILED_PLACEHOLDER`) instead of throwing, and `encryptedJsonb` now takes a required
    explicit `fallback: T` at the column definition (`[]` for the `string[]` columns, `null` for the
    `unknown` ones) rather than guessing a universal default — both paths log loudly via `console.error` so
    the corruption is still visible operationally, not silently swallowed. Added a real unit test suite
    (`packages/db/src/schema/encrypted-type.test.ts`) and reproduced the exact original bug live: inserted
    a warranty row with deliberately malformed ciphertext next to a normal one for a real test user,
    confirmed `GET /v1/warranties` now returns `200` with both rows (the corrupted one showing the
    placeholder) instead of `500`, and confirmed the failure is logged.

- **2026-08-31 (fourth pass): full blueprint §37/§28 re-audit, more parallel agents, more real fixes.**
  Re-checked the whole repo against both uploaded blueprint documents (base + security-hardened) section by
  section, using parallel research agents for the parts not already covered by the earlier passes. Found
  and fixed, all typechecked/tested/live-verified:
  - **§37's `Cache`, `NotificationProvider`, and `BillingProvider` interfaces didn't exist** — only
    `Queue`/`ObjectStorage`/`ModelProvider`/`Connector` did. Added all three, matching the existing
    `useExisting`-token DI pattern: `Cache` (`services/api/src/cache/`, wraps `EntitlementsService`'s
    Ask-quota Redis counter — the one real call site), `EmailProvider`/`PushProvider`
    (`notifications/notification-provider.interface.ts`, `MailerService`/`PushService` now implement them,
    `NotificationDeliveryService` depends on the tokens), and `BillingProvider`
    (`billing/billing-provider.interface.ts`, a new thin `StripeBillingProvider` wraps the actual Stripe
    SDK calls, `BillingService` keeps the DB/domain logic and depends on the interface for
    checkout/portal/webhook-parsing). Verified live: Ask quota still increments a real Redis counter,
    checkout/portal/webhook routes still degrade to the same clean "not configured" responses as before.
  - **A real mass-assignment gap**: `PUT /v1/notification-preferences` took `@Body() patch: Record<string,
    unknown>` with zero runtime validation — no `ZodValidationPipe`, unlike every other mutating endpoint
    in the app — so an extra key in the request body (e.g. `categoryOverrides`, a real jsonb column with no
    UI) would flow straight into the DB update via an object spread. Added a real
    `UpdateNotificationPreferencesDtoSchema` allowlisting exactly the six user-settable fields. Verified
    live: a request with an injected `categoryOverrides`/`userId` payload now has those fields silently
    stripped before reaching the service (Zod's default unknown-key-stripping behavior), confirmed via the
    unchanged response; an invalid `intensity` enum value now correctly 400s.
  - **No magic-byte validation on document uploads** (§28.13) — the declared `mimeType` was a trusted
    client header with nothing checking the actual bytes. Added `file-signature.ts` (real signature checks
    for PDF/JPEG/PNG/HEIC; `text/plain` has no reliable signature so it's allowed through, same as most of
    the industry) plus a 10-case unit test suite. Verified live: a plain-text file relabeled as
    `application/pdf` now correctly 400s with `FILE_CONTENT_MISMATCH`; a genuine file of each type still
    uploads normally.
  - **No PDF page-count cap or model-call timeout** (§28.13 "excessive OCR work") — a PDF under the 25MB
    size cap could have arbitrarily many pages, sent whole to Anthropic's document API with no timeout on
    the call. Added `approxPdfPageCount` (a byte-level `/Type /Page` scan — deliberately can undercount,
    never over-count, so it only ever rejects a clearly-excessive PDF, never a legitimate small one), a
    100-page cap matching Anthropic's own documented limit, and an explicit 2-minute timeout on both
    Anthropic call sites (`AnthropicExtractionService`'s stable and beta/PDF paths). Verified live: a
    150-(fake-)page PDF now correctly 400s with `PDF_TOO_MANY_PAGES`; a normal small PDF still uploads.
  - **No prompt-injection defense in Ask Veynlo's RAG prompt** (§28.15's "Critical AI rule") — retrieved
    email/document/calendar content (all attacker-reachable via connectors/uploads) was flat-concatenated
    into the model's user message with no framing distinguishing it from the actual question, and the
    system prompt said nothing about the possibility of embedded instructions. The forced-tool-schema
    output (`extractStructured`'s `tool_choice`) already bounded the blast radius — the model can't emit
    anything but the three typed answer fields — but that's incidental to the extraction pipeline's design,
    not a deliberate countermeasure. Fixed: the system prompt now explicitly names indirect prompt
    injection and instructs the model to never follow/repeat instructions found in context items, and each
    context item is now wrapped in an explicit `<untrusted_evidence type="..." id="...">` delimiter instead
    of being indistinguishable from the question. Not independently live-verified against a real model
    response this pass — `ANTHROPIC_API_KEY` is currently empty in this environment's `.env` (a "needs the
    user's own API key" gap, not a bug), so this was verified by typecheck/code review only.
  - **`services/api/.env.example` was incomplete and truncated** — missing `INBOUND_EMAIL_DOMAIN`/
    `INBOUND_EMAIL_WEBHOOK_SECRET` and the two annual Stripe price vars entirely, and the file cut off
    mid-sentence after the Admin section header with no content following. Rewritten to match
    `config/env.ts`'s full schema exactly.
  - **No revoke-one-session control, and no UI for the session list at all** (§28.9 "provide revoke-one and
    revoke-all controls") — `revokeAllSessions`/sign-out-everywhere existed, but there was no way to kill a
    single session by id, and — separately — nothing on any client ever called `GET /v1/auth/sessions` in
    the first place, so even revoke-all had no discoverable surface beyond a raw API call. Added
    `IdentityService.revokeSessionById` (scoped by `userId` in the same query, so one account can never
    revoke another's session by guessing an id) + `POST /v1/auth/sessions/:sessionId/revoke`; joined
    `listSessions` against `devices` for a real platform label instead of a bare session id; built
    `apps/web/settings/security` (device list, per-device "Sign out", "Sign out everywhere") with a link
    from the main Settings page. Verified live: two real sessions for one user, revoked one via the other's
    cookie (confirmed the revoked one's own cookie now 401s with `"Session revoked"`, the other stays
    active), then confirmed a *different* user's revoke attempt against the first session returns the same
    generic success response (no existence/ownership leak) while the DB shows it was never actually
    touched — cross-user revocation is not possible.

- **2026-08-31 (fifth pass, same day): the two deliberately-deferred items, finished.** The user asked to
  keep going on everything flagged as remaining. Both now done, typechecked, and live-verified:
  - **Step-up (password) re-verification** on data-export and the destructive connector-disconnect path
    (§28.9). Added `IdentityService.verifyStepUpPassword(userId, password)` — a no-op for OAuth-only
    accounts (no `passwordHash` to check, so nothing to lock them out of), otherwise requires and verifies
    a password exactly like `delete-account` already does. `DataExportService.requestExport` and
    `ConnectorsService.disconnect` (only when `deleteDerivedData: true` — a plain disconnect stays
    frictionless) both call it. Web and mobile both updated: the request goes out with no password first,
    and only shows a password prompt if the server actually asks for one (`PASSWORD_REQUIRED`), rather than
    asking every user up front. Verified live end-to-end on a real password account: no-password → 401
    `PASSWORD_REQUIRED`, wrong password → 401 `INVALID_CREDENTIALS`, correct password → success; then
    flipped the same account to OAuth-only (`passwordHash = null`) and confirmed the no-password request
    now succeeds directly, no prompt; then verified the connector-disconnect path's plain-disconnect (no
    password needed) vs `deleteDerivedData: true` (password required) split the same way, all against real
    connection rows.
  - **No user-visible session list existed at all, and no revoke-one control** — see the entry above this
    one for the backend half (already done); this pass added the actual UI:
    `apps/web/settings/security` page (device list, per-device "Sign out", "Sign out everywhere") linked
    from the main Settings page. Verified live: page compiles and serves 200 from the real dev server.
  - **PDF/image OCR moved off the synchronous upload request into the background worker** (§28.13 "Run
    high-risk document parsing in a dedicated ... worker role ... with strict CPU/memory/time limits").
    Previously `DocumentsController.upload()` called Anthropic's document-vision API inline, tying up an
    API request thread for however long that external call took, with no isolation from the rest of the
    process. Added a new `document-ocr` BullMQ queue/worker (`DocumentOcrJobData`, `DocumentsService
    .processOcr`), a real `ObjectStorage.getObject()` method so the worker can re-fetch the already-stored
    file instead of carrying its bytes through the job payload, and updated `upload()` to insert the
    document row, store the file, and enqueue OCR (leaving `processingState` at its default `"uploaded"`)
    instead of blocking on it — text/plain uploads are unaffected (no AI call to begin with, still handled
    inline). Verified live end-to-end twice: once confirming the AI-unconfigured fallback still behaves
    identically to before (`processingState: "classified"` synchronously, no job enqueued); once — using
    the same "mocked-AI-boundary" technique this codebase already relies on elsewhere for tests that need a
    real external call without a real paid credential — with a temporary dummy `ANTHROPIC_API_KEY` (set,
    tested, then reverted; `.env` is gitignored, never at risk of being committed) to force the real code
    path: uploaded a real PDF, confirmed `processingState` was `"uploaded"` (pending) immediately after the
    HTTP response returned, watched the worker log a genuine `401` from Anthropic's real API a few seconds
    later (proving it's a real network call, not a stub), confirmed it caught the failure correctly and
    left the document in the same terminal `"classified"` state the old synchronous code would have, and
    confirmed the BullMQ job itself completed (not retried/failed) — matching the original code's
    "OCR failure is expected/soft, not a job-processing error" semantics exactly.
    **Not fully achieved**: true role/process isolation (a dedicated least-privilege worker with no access
    to OAuth token decryption) needs a genuinely separate worker deployment with its own IAM role — this
    codebase's single worker process still runs every queue, PDF OCR included, so this is a real
    architectural improvement (bounded, retryable, off the request thread) but not the full infra-level
    isolation the blueprint describes; that piece stays gated on a real multi-service deployment decision.
  - **The browser extension was completely non-functional in real Chrome usage** — found by a background
    agent that, for the first time, actually loaded the real unpacked extension into a real Chromium via
    Playwright's `launchPersistentContext` (previously "verified" only via static code tracing + a raw curl
    replay, which can't reproduce this class of bug at all: a curl request has no persistent cookie jar).
    Root cause: `identity.controller.ts`'s `setSessionCookie` set the session cookie unconditionally
    regardless of client platform. The extension's `background.js` authenticates with a bearer token only
    (by design — it never sends the CSRF header, matching `csrf.ts`'s documented "bearer requests aren't a
    CSRF-relevant transport" exemption) — but Chrome's extension `host_permissions` grant makes a
    background-script `fetch` automatically store and resend cookies for permitted origins even with no
    `credentials: "include"` anywhere in the code, so the cookie got set and stuck on sign-in regardless.
    Every subsequent state-changing request (`csrf.ts`'s `assertCsrfSafe`, which checks only "is a cookie
    present," not "was a cookie actually relied on") then saw that stray cookie, classified the request as
    cookie-authenticated, and 403'd it for missing the CSRF header the extension correctly never sends —
    meaning **"Save this page" and "Save selected text" — the extension's only two real features — were
    both completely broken for every real user, permanently, after their very first sign-in.** Fixed two
    ways: `setSessionCookie` now takes the platform and no-ops for anything but `"web"` (closing the root
    cause — extension/native clients never receive a cookie at all going forward), and `AuthGuard` now
    prefers a bearer token over a cookie when both are present and skips CSRF entirely when bearer
    authenticated (defense in depth against a stray already-issued cookie from before this fix, or any
    future client that ends up in the same situation). Verified live end-to-end: an extension-platform
    sign-up now returns zero `Set-Cookie` header and an empty cookie jar, and the resulting bearer token
    successfully completes a real state-changing request (`POST /v1/ingestion/manual`, `201`) with no CSRF
    header at all; confirmed no regression on the web flow (cookie still set, CSRF still enforced exactly
    as before — a cookie-authenticated request without the header still correctly 403s).

- **2026-08-31 (sixth pass, same day): systematic real browser/simulator testing across every client, and
  a whole class of "helpful error handling ships broken by design" bugs found and fixed.** The user asked
  to check every screen/feature/toggle for real. Discovered mid-pass that Playwright (with real Chromium)
  and a booted iOS Simulator are both actually usable in this environment — prior sessions had incorrectly
  assumed neither was available and fell back to static tracing, which is exactly why several of the bugs
  below survived multiple earlier "verified" claims. Ran 6 parallel agents (web auth/settings, web main
  screens, admin console, the real browser extension via `launchPersistentContext`, mobile web-preview, and
  a real native iOS Simulator build) plus a `knip`-driven dead-code sweep (see the same-day ROADMAP.md
  entry for that half). Real bugs found and fixed, every one typechecked/tested and re-verified live
  against the actual running apps after the fix:

  - **The browser extension was completely non-functional for every real user** — covered in its own entry
    above (found by this same testing round).
  - **`services/api/src/main.ts`'s CORS config silently blocked every `PUT` request app-wide.**
    `@fastify/cors`'s own default `methods` list is `GET,HEAD,POST` only (an older Express-style `cors`
    package's broader default was assumed instead) — the only `PUT` endpoint in the entire app
    (`PUT /v1/notification-preferences`, the Settings intensity control + 3 switches) silently failed a
    CORS preflight on every single use, meaning **no user's notification preference changes had ever
    actually saved through the web UI**, reverting to the old value on every reload. A raw curl/API-level
    test can never catch this (no browser, no CORS preflight) — only real browser testing could. Fixed by
    listing `methods` explicitly; verified live end-to-end (real signup → toggle "Quiet" → reload → still
    "Quiet").
  - **A whole class of bug: a blanket "any 401 ⇒ redirect to sign-in" in both `apps/web` and
    `apps/mobile`'s `api-client.ts` broke every feature that legitimately uses a 401 for something other
    than "your session died."** Two distinct endpoints trigger this: (1) `GET /v1/auth/me` — `useSession()`
    /`useAuth()`'s own "am I logged in?" probe, which 401s completely normally for an anonymous visitor on
    a public page; and (2) `PASSWORD_REQUIRED`/`INVALID_CREDENTIALS` — the step-up-auth signal built
    earlier this session, meaning "you're signed in, this specific password attempt needs re-confirming,"
    never a dead session. The blanket handler fired before any caller's own handling of either case could
    ever run, producing four distinct real, previously-unnoticed regressions: (a) `/accept-invite`'s
    unauthenticated peek state — the entire point of that page for someone without an account yet — was
    completely unreachable, discarding the invite context and bouncing to a bare sign-in page; (b) the
    data-export step-up password prompt (built and "verified" via curl earlier this session) was
    completely unreachable through the real browser UI on both web and mobile; (c) delete-account's
    wrong-password case silently bounced the user away instead of showing "Incorrect password."; (d) on
    mobile specifically, `/sign-up` was unreachable by any cold/direct navigation (typed URL, bookmark,
    external link) — only an in-app link click (no remount) ever worked, since the mount-time `/v1/auth/me`
    401 clobbered the in-flight navigation. Fixed on both clients: exempt `/v1/auth/me` and the two
    credential-signal codes from the redirect. Verified live, every branch: unauthenticated accept-invite
    peek now renders correctly (real screenshot); data-export's password prompt now appears and completes
    correctly on web; a wrong step-up password on connector-disconnect now shows "Incorrect password."
    inline instead of redirecting (confirmed the fix closed this exact case live).
  - **`/reset-password` and `/accept-invite` (web) permanently blank-paged on a tokenless URL** — both
    pages initialized `useState(null)` then called `setToken(searchParams.get("token"))`, and when there's
    genuinely no token param, `.get()` also returns `null` — the same value already in state, so React
    bails out of the update entirely (`Object.is` equality) and the component is stranded forever on its
    "still checking" branch instead of ever reaching the "invalid link" one. Fixed by distinguishing
    "haven't checked yet" (`undefined`) from "checked, genuinely absent" (`null`) as separate states on
    both pages.
  - **`apps/web/.../connections/page.tsx` discarded real, useful backend error messages.** Any connector
    `authorize` failure other than `CONNECTOR_NOT_CONFIGURED` (e.g. `CONNECTOR_LIMIT_REACHED`, which
    already carries a specific, correct message — "Your plan allows up to 1 email connection...") was
    replaced with a generic "Couldn't start the connection" — found live when a real plan-limit hit showed
    the useless generic text instead. Fixed to fall back to the real `ApiError.message` for any other code.
  - **`apps/mobile/app/connections.tsx`'s data-loading `useFocusEffect` had no error handling at all** — an
    unauthenticated cold deep-link launch straight into this screen 401s, and with no `.catch`, that became
    an unhandled promise rejection (a red dev-mode error screen on a real iOS Simulator, confirmed via
    screenshot) even though `api-client.ts`'s own redirect-to-sign-in already fires correctly as a side
    effect. Fixed with a `try/catch` — the redirect already handles the UX, this just stops the leftover
    rejection from surfacing.
  - **`apps/mobile/app/connections.tsx`'s deep-link-param-clearing effect crashed the whole screen, and this
    took two rounds to actually fix.** `router.setParams(...)` inside a plain `useEffect` threw "Attempted to
    navigate before mounting the Root Layout component" when `/connections?connected=outlook` (exactly what a
    real OAuth callback deep link produces) was the very first screen the app opened to — confirmed on a real
    iOS Simulator via Playwright-driven `expo start --web` first, then independently on the real native build.
    Round 1 gated the effect on `useRootNavigationState()?.key` (expo-router's documented "is it actually safe
    to navigate yet" signal). **This alone was insufficient** — re-running the exact same repro live (a cold
    launch, then a second `connected=`/`error=` deep link arriving at an already-running app) reproduced the
    identical crash with that guard already active in the running code, proving `rootNavigationState?.key`
    being truthy does not guarantee this specific freshly-(re)mounted screen's own navigation context has
    finished attaching on the native side. Round 2 kept that guard and additionally deferred the actual
    `router.setParams` call by one tick (`setTimeout(fn, 0)`, with `clearTimeout` cleanup). Re-running the
    identical failing sequence (cold launch, then a second deep link at an already-running app, then a third
    `capture` deep link) after this fix produced zero error overlay across all three taps, cross-checked
    against both a fresh screenshot and the Metro dev log's line-count boundary. The `veynlo://capture`
    deep-link's own effect already has correct `.catch` handling and was independently re-confirmed clean;
    the uncaught-rejection toast previously observed on that third tap did not recur after the Round 2 fix,
    so it's treated as the same `connections.tsx` bug surfacing via React Native's batched/delayed error-toast
    display rather than a separate bug in `capture.tsx` — no other plausible source was found after checking
    every shared/global fetch path (`auth-context.tsx`, `push-registration.tsx`,
    `notification-capture-drain.tsx`, `_layout.tsx`, `(tabs)/_layout.tsx`), all of which have correct error
    handling or no fetches at all. The authenticated-user success-banner path (confirmed working pre-fix by
    the original testing agent) was not independently re-verified after Round 2 via live UI interaction —
    attempts to do so with `cliclick`+AppleScript coordinate-based simulator automation proved too fragile to
    complete reliably — an invisible macOS-level permission dialog (not visible in device-only screenshots,
    only in full host screenshots) silently absorbed several clicks, and coordinate imprecision twice
    triggered unintended iOS gestures (the RN dev menu, a text-cursor magnifier) — none of which affected the
    app's actual code or data, but the sign-in flow itself was never completed this way. The `setTimeout`
    change only defers the existing param-clearing call by one JS tick and does not touch the
    `setConnectedMessage`/`setConnectError` logic that renders the banners, so regression risk there is low
    by inspection, not by fresh live observation.
  - **A real duplicate-attention-items seed-data bug**, same class as the earlier `source_events` one:
    `packages/db/src/seed/run.ts`'s hand-authored `att_demo_bill`/`att_demo_return` rows either had no
    `linkedResourceType`/`linkedResourceId` at all, or pointed at the wrong resource type
    (`purchase`/`pur_demo_laptop` instead of `return_case`/`ret_demo_laptop`) — meaning
    `AttentionService.scanAndFileDeadlines`'s own dedup check (which matches exactly on
    `linkedResourceType`+`linkedResourceId`) could never recognize these as already-filed, and created a
    second, genuinely duplicate attention item for the same real bill/return on every recurring scan tick.
    Found live via a real `/home` page render showing the same bill/return twice with slightly different
    phrasing. Fixed the seed values to match the scanner's own convention exactly, corrected the two
    already-affected rows and removed their duplicates directly (`onConflictDoNothing` means re-running the
    fixed seed script alone doesn't retroactively fix existing rows), and verified via direct code/query
    reasoning that the scanner's dedup check now correctly matches and will never re-duplicate these two.
  - **`apps/admin/.../dashboard/admins/page.tsx` had no client-side role guard** — the nav link to this
    page is correctly hidden for a support-role admin, but nothing stopped one from navigating there
    directly: they'd see a fully interactive "Create admin" form (any actual submission still correctly
    403s server-side — this was never a real privilege-escalation hole) and a table stuck on "Loading…"
    forever, since the underlying `403` from `GET /v1/admin/admins` was never surfaced. Fixed with an
    explicit role check rendering a clear "Access restricted" message, plus surfacing the fetch error
    instead of an infinite loading state as defense in depth. Verified live via a real signed-in support
    admin navigating directly to the URL (screenshot confirmed the fix).
  - Everything else all 6 agents tested — the full session-management UI, household management UI, admin
    merchant-merge/admin-management flows, document upload + magic-byte rejection, Ask Veynlo's degradation
    when unconfigured, the SSRF-guarded URL capture, real Microsoft OAuth redirects, connector quota
    enforcement, and dozens more — passed with no further issues found. Full per-item evidence lives in
    this session's task outputs; summarized here rather than duplicated in full.
  - **Three compliance documents §28 explicitly asks for, none of which existed**: `docs/SECURITY_CONTROLS.md`
    (an ASVS-scoped control matrix — control ID, applicability, implementation, test evidence, owner, and
    verification date per row, cross-referencing the real work described throughout this file rather than
    duplicating it), `docs/THREAT_MODEL.md` (data-flow diagrams + STRIDE analysis + abuse cases for every
    flow the blueprint names that actually exists in this codebase: auth, connector ingestion, file
    uploads, Ask/RAG, household sharing, billing, export, deletion — plus what financial-connector and
    agentic-action flows will need to inherit once built), and `docs/VENDOR_REGISTER.md` (every real
    third-party integration point, with an honest "verify before launch" marker on the legal-terms columns
    that need a human reading a vendor's actual current DPA, not an inference from code). App Attest, Play
    Integrity, and IaC scanning were deliberately **not** attempted as code this pass — they'd be
    unverifiable in this environment (no real device, no real Apple/Google developer console access, no
    Terraform-scanning tool installed) and shipping security-critical, untested code is worse than clearly
    documenting the gap; both are tracked in the new control matrix instead.
  - **2026-09-01: a full independent MVP-completeness audit (6 parallel agents, one per §52.1 requirement
    area, each told to distrust this file's own prior claims and re-verify live) found 10 further real
    gaps, all fixed and live-verified this same pass — the "everything else passed" line above was
    accurate for what those 6 agents tested at the time, not a claim that nothing was ever missing.**
    - **A systemic, previously-invisible DI bug affecting the entire local dev worker process.** Any
      NestJS constructor parameter relying on implicit type-based injection (no explicit `@Inject()`)
      silently resolved to `undefined` at runtime specifically when loaded via `tsx watch` (the
      `worker:dev` script) — confirmed by an isolated repro: `tsx`/esbuild never emits TypeScript's
      `design:paramtypes` decorator metadata at all, even with `emitDecoratorMetadata: true` correctly set,
      so Nest's reflection-based DI falls back to constructing the class with fewer arguments than its
      constructor declares (JS silently allows this — no thrown error). Production is unaffected (`pnpm
      build` → `node dist/worker-main.js` uses real `tsc`, which emits this metadata correctly), but this
      was live-crashing the local dev worker on `NotificationDispatchService.dispatchDailyBrief` (`Cannot
      read properties of undefined (reading 'createAndEnqueue')`) — reproduced live via a direct BullMQ job
      enqueue, twice, even after a full clean worker restart, ruling out a stale-process explanation. Fixed
      by adding explicit `@Inject(ClassName)` to every affected constructor parameter across 21 files (12
      services/adapters actually reachable by the worker, plus 16 controllers/guards fixed for
      consistency/future-proofing even though they're HTTP-only and unaffected today) — the robust,
      build-tool-independent fix rather than changing the dev script. Verified live: re-enqueued the exact
      failing job after the fix, confirmed it completed and a real notification row landed in `notifications`.
    - **Upload malware scanning was silently disabled in this dev environment** despite ClamAV running
      healthy in docker — `CLAMD_HOST` was blank in `.env` (a real, reachable scanner one env var away),
      so `documents.service.ts`'s own "skip when unconfigured" branch was firing even though scanning was
      fully available. A live EICAR-string upload was accepted with a real `201`. Fixed by setting
      `CLAMD_HOST=127.0.0.1`; re-verified the identical EICAR upload now returns `400 MALWARE_DETECTED`.
    - **Duplicate bill/subscription ingestion was a real, unfixed gap** (a previously-documented duplicate-
      *attention-item* fix only deduped the downstream symptom, never the root cause) — `extractBill`/
      `extractSubscription` unconditionally inserted a fresh row on every AI extraction with zero check
      against an existing bill/recurring-stream for the same biller/service, so a second reminder email
      about the same real-world bill created a genuine duplicate. Fixed with the same precision-first
      pattern `findExistingPurchaseByAmountAndDate` already established elsewhere (`billerLabel`/
      `serviceLabel` are encrypted, so matching happens on plain columns first — owner/amount/date-window
      for bills, owner/merchantId for subscriptions — then a decrypted-in-application-code exact compare;
      more than one candidate is still treated as no match). Verified with a new real integration test suite
      (`ingestion.dedup.test.ts`, 3 tests) against the actual dev Postgres, driving the real `ingestManualText`
      → domain-classify → extract pipeline via a new `FakeModelProvider` test double — the first automated
      test coverage this pipeline has ever had; previously every verification of it was a one-off manual
      curl/psql check. The fake provider is a real, reusable `ModelProvider` implementation, not a mock of
      this one code path.
    - **Sign in with Apple was completely absent** — not even a "not configured" stub, unlike Google/
      Microsoft, which correctly self-report. Built the full parallel code path: `APPLE_CLIENT_ID`/
      `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` env vars, `appleAuthorizationUrl`/
      `handleAppleCallback` in `identity.service.ts` (real ES256 client-secret JWT minting per Apple's spec,
      real JWKS-verified id_token via `https://appleid.apple.com/auth/keys`, the one-time `user` form field
      Apple sends only on first authorization used for a real display name), a POST-based callback route
      (Apple's `response_mode=form_post` requirement, unlike Google/Microsoft's GET), and a "Continue with
      Apple" button on both web sign-in/sign-up pages. Verified live end-to-end via Playwright: the button
      renders, clicking it round-trips through the real backend, and correctly lands on "That sign-in method
      isn't configured on this deployment yet." — the same honest ceiling as every other unconfigured
      external dependency in this codebase; a real Apple Developer account is needed only to test the live
      OAuth exchange, not to have the code exist.
    - **Voice note capture (§52.1 Capture) was entirely unbuilt** — zero code beyond a dead enum value.
      Built the full pipeline: `POST /v1/ingestion/voice-note` (malware-scanned, storage-quota-checked,
      stored via the same `ObjectStorage` interface documents use, `sourceEvents.rawContentRef` holding the
      blob key), a signed playback URL endpoint, a real recording UI on mobile (`expo-audio`'s
      `useAudioRecorder`, added as a new dependency) wired into the existing Inbox capture form as a third
      mode alongside paste-text/URL. Deliberately does **not** attempt AI transcription: Anthropic's
      Messages API has no audio-input content block at all (only `image`/`document` — confirmed by reading
      `anthropic-extraction.service.ts`'s own `ExtractionContentBlock` union), so there is no real model
      call this codebase's one AI provider could make here; pretending to transcribe would mean fabricating
      a capability that doesn't exist, so this ships as a genuinely complete record/scan/store/playback
      capture path with transcription honestly tracked as a follow-up (on-device speech-to-text, or a
      provider whose API actually accepts audio) rather than faked. Verified live end-to-end twice: once via
      curl (upload → real `source_events`/`inbox_items` rows → signed URL → downloaded bytes byte-identical
      to the upload; EICAR and wrong-mime-type correctly rejected), once through the actual mobile UI via
      Playwright with a fake media device (record → stop → submit → real `201` → the real Inbox card
      renders with Confirm/Snooze/Archive/Dismiss, Confirm works cleanly). Also found and fixed a real
      omission along the way: account deletion's S3 cleanup only ever looked at `documentVersions`, so a
      voice note's raw audio would have been orphaned in storage forever after its owner deleted their
      account — fixed by also collecting `sourceEvents.rawContentRef` for `kind: "voice_note"` rows before
      the cascading delete removes them; verified live (uploaded a voice note, confirmed the S3 object
      existed via `s3api head-object`, requested real account deletion, confirmed the object was gone
      after the worker processed the job).
    - **No admin visibility into BullMQ job health** despite 15 real queues running in Redis — an admin
      would have had to `redis-cli --scan` directly to even confirm they existed. Added
      `QueueProducerService.getQueueHealth()` (real `getJobCounts()` per queue) and a `GET
      /v1/admin/queues/health` endpoint, surfaced as a new "Job queue health" table on the admin dashboard.
      Verified live: real waiting/active/delayed/completed/failed counts for all 11 queues, including
      several genuine historical failures this session's own worker restarts and stale test data produced
      (inspected via `getFailed()` and confirmed each was explainable, not a live ongoing bug).
    - **No admin-wide worklist for pending privacy requests** — export/deletion requests were only ever
      reachable one user at a time via email lookup, with no queue-style view across all users. Added
      `AdminService.privacyRequestsWorklist()` (pending `export_jobs` joined to the owning user's email,
      plus every `users` row currently `deletion_pending`) and a matching admin-dashboard section. Verified
      live with a real queued export job and a real deletion-pending user.
    - **Quiet hours were evaluated against the server's own timezone, not the user's** — `isWithinQuietHours`
      called `now.getHours()` directly with no timezone awareness at all. Fixed to take the user's
      `users.timezone` (already an existing column, just never read here) and compute local wall-clock time
      via `Intl.DateTimeFormat`, falling back to UTC for an invalid/unrecognized zone string rather than
      throwing. Added a real cross-timezone test case (08:00 UTC is inside a 22:00-07:00 quiet window in
      `America/Los_Angeles` but not in UTC) to the existing test suite, which needed rewriting anyway since
      its old cases silently depended on the test-runner machine's own local timezone.
    - **`historical_backfill_days` was a dead entitlement key** — every connector adapter hardcoded
      `historyDepthDays: 90` regardless of plan, silently ignoring `PLAN_CATALOG`'s declared 30/365/
      unlimited split. Added `EntitlementsService.resolveHistoricalBackfillDays` (unlimited resolves to a
      finite ~10-year practical cap, since the column is a bounded integer) and wired it into all four
      OAuth-based connector adapters (ICS has no backfill-depth concept and was correctly left alone).
      Verified the resolution logic directly against the real entitlements table: a user with no entitlement
      rows (free tier) now resolves to 30, not 90.
    - **Genuinely reserved, not gaps**: 6 of the 10 originally-flagged "unenforced entitlement capability
      keys" (`financial_aggregator_connections_max`, `home_vehicle_profiles`, `family_school_sharing`,
      `automation_rules_max`, `emergency_binder`, `desktop_power_tools`) map one-to-one to Phase 2 features
      that don't exist yet — correctly reserved-but-unbuilt per §53.1's own architecture rule, not a bug.
      `data_export` is `true` on every plan by design, so "enforcing" it is a no-op. `purchases_returns_tracking`/
      `subscriptions_bills_tracking` are currently unenforced and both domains work fully for free-tier
      users today — left as-is rather than silently paywalling currently-working functionality, since
      whether free users should lose access to these domains is a real product/business decision this pass
      deliberately did not make unilaterally.
    - **One admin-audit finding from the parallel audit was a false positive**, corrected here for the
      record: `createAdmin`/`revokeAdmin`/`grantEntitlement`/`revokeEntitlement`/merchant merge/unmerge DO
      already call `AdminService.recordAccess` (the audit agent grepped only `admin.controller.ts` and
      missed that these calls live inside `admin.service.ts`'s own methods) — confirmed via real historical
      `audit_events` rows for every one of these actions. The one part of that finding that WAS real: sign-in
      (and sign-up) were never audited anywhere. Fixed with a new `IdentityService.recordAuditEvent` helper
      covering successful sign-in, failed sign-in (both "wrong password" and "no such account" — the
      attempted email is recorded as `resourceId` for this admin-facing trail even though the *error
      message* to the caller stays generic, per §28.8's anti-enumeration requirement, since those are
      different audiences), account-deletion-in-progress sign-in attempts, and sign-up. Verified live: four
      real audit rows for the four distinct cases, correct `actorType`/`result` on each.
    - **A real dev-data seed gap**: `inb_demo_warranty` never had `linkedResourceType`/`linkedResourceId`
      set, and no `warranties` row existed for it at all, so Life → Warranties → evidence view had no way to
      be manually verified in this dev environment. Added a real seeded warranty row (linked to the existing
      demo Dyson V15 purchase) and wired the inbox item to it. Verified live via the real web UI: warranty
      list, detail page (expiration countdown, length, registration status), and the full evidence block
      (subject/from/snippet/source/received) all render correctly end-to-end.
    - **Deliberately not attempted this pass, with reasoning**: a dedicated structured-search UI (the
      working `GET /v1/search` backend endpoint has no web caller — Ask already serves natural-language
      search and the spec bundles "Ask/Search" as one MVP item, so this is an architectural completeness
      note, not a missing capability); real ranked retrieval for Ask (currently an unranked bulk
      `LIMIT 50`-per-table fetch that ignores the question when selecting context — the pgvector-backed
      `search_documents` table exists in the schema but has zero rows and zero code references; wiring real
      embedding-based retrieval is a substantial, real quality gap, but doing it properly needs a
      configured AI provider to even generate embeddings, and a rushed partial version risked doing more
      harm than documenting the gap honestly).

## Pre-submission checklist

Code-level items above are done or explicitly called out as not done. Before
an actual store submission or pentest engagement, someone needs to:

- [ ] Write and publish a real privacy policy + terms of service, reviewed
      by counsel given the data classes this app handles. **Still the actual
      blocker** — as of 2026-09-01, honest placeholder routes now exist for
      every §51.3 "documents/policies required before public launch" item
      (`/terms`, `/privacy-policy`, `/subscription-terms`,
      `/acceptable-use-policy`, `/security-overview`, `/subprocessors`,
      `/data-retention-policy`, `/cookie-policy`, `/accessibility`,
      `/responsible-disclosure`, `/law-enforcement-requests`,
      `/family-child-data`, `/partner-data-processing`, `/dmca` — see
      `apps/web/src/lib/legal-documents.ts`), linked from the sign-up page's
      fine print and the auth-pages footer, so the app no longer 404s or
      silently omits these links. Every one of those pages says, in its own
      words, "not yet published, not legally binding, here's a contact
      email" — none of them contain real terms, liability language,
      data-retention promises, or a governing-law statement, and none of
      that text should be written by an AI without counsel review. Building
      the routes did not touch this checklist item's substance; the real
      documents still need to be written and reviewed before launch. §51.3
      also names "app-store privacy/data-safety disclosures," which isn't a
      web route at all — it's a form filled out directly in App Store
      Connect / Google Play Console at submission time.
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
