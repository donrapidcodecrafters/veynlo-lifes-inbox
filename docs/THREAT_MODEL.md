# Threat model

Blueprint §28.2: "Create and maintain data-flow diagrams for authentication, Gmail/Outlook/calendar
ingestion, financial connectors, file uploads, Ask Veynlo/RAG, household sharing, billing, exports,
deletions, and future agentic actions... Perform structured threat modeling at architecture creation and
whenever a trust boundary, sensitive data flow, external connector, or high-risk action changes."

This is a first real pass, not a standing process yet (tracked as a gap in `docs/SECURITY_CONTROLS.md`
V1.1) — it covers every flow the blueprint names that currently exists in this codebase, using STRIDE for
technical threats plus explicit abuse/fraud cases. Flows that don't exist yet (financial connectors/Plaid,
agentic actions) are noted with the trust boundaries they'll need to respect once built, not analyzed in
depth.

## Asset inventory — what actually matters if compromised

| Asset | Where it lives | Why it's crown-jewel |
|---|---|---|
| OAuth refresh/access tokens (Gmail, Outlook, Google/Microsoft Calendar) | `connections`/`connection_credentials`, envelope-encrypted (`credential-vault.ts`) | Direct read access to a user's real email/calendar if decrypted |
| Session refresh tokens | `sessions.refreshTokenHash` (hashed, not raw) | Account takeover if a raw token leaks and is replayable |
| Password hashes | `users.passwordHash` (argon2id) | Offline cracking risk if the DB leaks |
| Field-encryption / credential-vault KMS-equivalent keys | `FIELD_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY` env vars | Decrypts every encrypted column app-wide if leaked |
| Encrypted personal content (purchases, bills, documents, calendar, warranties) | 50+ encrypted columns across `packages/db/src/schema/*.ts` | The actual private-life data Veynlo exists to protect |
| Uploaded document originals | S3/MinIO, private bucket | Receipts/IDs/financial documents, potentially highly sensitive |
| Household ACL/delegation state | `household_memberships`, `caregiver_delegations` | Determines who can see whose data — a bug here is a direct cross-person privacy breach |
| Admin session/credentials | `admin_users`/`admin_sessions`, separate from consumer auth | Compromise here reaches every user's metadata at once |
| Stripe/RevenueCat webhook secrets | `STRIPE_WEBHOOK_SECRET`/`REVENUECAT_WEBHOOK_AUTH_HEADER` | Forged billing events could grant free entitlements or corrupt billing state |

## Trust boundaries

```
 Mobile / Web / Desktop / Browser-extension clients   (untrusted — attacker-controlled input origin)
              |
              | HTTPS, bearer token (native) or httpOnly cookie + CSRF header (web)
              v
 ─────────────────────────  TRUST BOUNDARY: AuthGuard  ─────────────────────────
              |
        NestJS API (services/api) — trusted once past AuthGuard, but every
        object fetch is STILL scoped by ownerUserId/household before use
              |
   ┌──────────┼──────────────────┬──────────────────┬─────────────────┐
   v          v                  v                   v                 v
Postgres   Redis/BullMQ      S3/MinIO          Anthropic API     Gmail/Outlook/
(Drizzle,  (job queue,       (private,          (external,       Google/MS Calendar
encrypted  ephemeral         signed-URL          model provider   (external, OAuth-
columns)   cache/quota)      only)               — sees NO auth   scoped, token-
                                                  tokens, only     vault-mediated)
                                                  extracted text)
   ^
   |  ─────────────────────  TRUST BOUNDARY: AdminGuard/SuperAdminGuard  ─────────────────────
   |
 Admin console (apps/admin) — separate workforce identity, metadata-only access by design
```

External providers (Gmail, Outlook, Google/Microsoft Calendar, Stripe, RevenueCat, Anthropic) are each
their own trust boundary: the app treats every inbound webhook/response as untrusted until
signature/token-verified, and every outbound call carries only the minimum scope needed.

## Flow-by-flow analysis

### 1. Authentication (password + Google/Microsoft OAuth sign-in)

**Data flow**: Client → `POST /v1/auth/sign-in|sign-up` or `/google|microsoft/authorize→callback` →
`IdentityService` → `sessions`/`identity_links` tables → signed JWT in httpOnly cookie (web) or bearer
token (native).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Spoofing | Forged OAuth callback / CSRF on the OAuth round-trip | Signed, 10-minute, single-purpose JWT `state` parameter validated on callback | Done |
| Spoofing | Forged `id_token` from Google/Microsoft | Real signature verification (`verifyIdToken` / JWKS) | Done, fixed this engagement |
| Tampering | Algorithm-confusion attack on session JWT | Explicit `algorithms: [...]` allowlist on every `jwtVerify` call | Done |
| Repudiation | No record of sign-in/recovery events | `audit_events` covers login/recovery/OAuth changes | Done |
| Information disclosure | Account enumeration via forgot-password response | Response is identical whether or not the email matches a real account | Done |
| Elevation of privilege | OAuth sign-in silently linking to an existing password account by email match | Deliberately rejected — only links via an explicit prior `identity_links` row | Done |
| Elevation of privilege | Brute-force / credential-stuffing against sign-in | `@Throttle` per-route rate limiting | Done |

**Abuse case**: attacker with a large credential-stuffing list hits `/sign-in` — mitigated by rate limiting
alone today; no CAPTCHA/risk-scoring layer exists (blueprint §28.16 describes a fuller risk engine as a
later-stage control, not MVP-blocking).

### 2. Email/calendar connector ingestion (Gmail, Outlook, Google Calendar, Microsoft Calendar)

**Data flow**: OAuth grant → encrypted token stored in `connections`/`connection_credentials` →
`connector-sync`/`connector-scan` BullMQ jobs → provider API pull → `IngestionService` classifies/extracts
→ domain tables (purchases, bills, calendar_events, etc.) with provenance (`source_events`).

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Spoofing | A malicious/compromised third-party mail relay injecting fake "receipts" | Extraction is evidence-linked (`source_events`) and confidence-banded; low-confidence items route to Inbox for human confirm, not auto-filed as fact | Done |
| Tampering | OAuth token swapped/tampered in transit or at rest | Envelope encryption (`credential-vault.ts`), decrypt permission scoped to the connector/token service role only | Done |
| Information disclosure | Token leaking into logs/traces/error reports | Pino redaction (`Authorization`/`Cookie`); token values never interpolated into log strings anywhere in the ingestion path (code-reviewed) | Done |
| Denial of service | A single user's huge mailbox starving the shared worker pool | Per-connection job queue with backoff; concurrency limits per worker | Partial — no per-user fairness/priority scheme, a large backfill could still slow other users' syncs on the same worker process |
| Elevation of privilege | Extracted content cross-linking to the wrong user/household | Every write is scoped by the connection's `ownerUserId`, verified at insert time | Done |

**Abuse case**: a user connects, immediately triggers a massive historical backfill to run up AI/API cost —
mitigated by `historical_backfill_days` entitlement cap and connector-count quotas; not independently
re-verified this pass (verified in an earlier session per `docs/ROADMAP.md`).

### 3. Financial connectors (Plaid) — not yet built

No code exists for this flow (Phase 2 per `docs/ROADMAP.md`). When built, it inherits every control above
plus: Plaid's own webhook signature verification, and a stricter data-minimization posture (bank-linked
data is a materially higher-stakes asset than email-derived receipts) — should default to `commerce:read`-
equivalent scoping from day one rather than retrofitting it.

### 4. File uploads (documents, receipts, images)

**Data flow**: Client multipart upload → `DocumentsController` → magic-byte + size + page-count validation
→ ClamAV scan (when configured) → S3/MinIO write → `document-ocr` queue → Anthropic vision API (text
extraction only, never renders/executes the file) → `document_versions.ocrText`.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Tampering | Mislabeled file content (e.g. an executable disguised as a PDF) | Magic-byte signature validation, not just the client's declared MIME type | Done, fixed this engagement |
| Tampering | Malware in an uploaded file | ClamAV scan, fails closed once configured | Done |
| Denial of service | Oversized PDF / decompression-bomb-style resource exhaustion | 25MB size cap, 100-page PDF cap, 2-minute model-call timeout; no archive/zip handling exists at all (so no decompression-bomb surface) | Done, fixed this engagement |
| Denial of service | OCR tying up the API request thread | Moved to an async background worker | Done, fixed this engagement |
| Information disclosure | Object key derived from user-controlled filename (path traversal / enumeration) | Keys are `documents/{ownerUserId}/{documentId}/v{n}` — fully server-generated | Done |
| Information disclosure | Permanent public URL to a private document | Every read is a fresh, short-lived (300s) signed URL, ownership-checked first | Done |
| Elevation of privilege | Active content execution (PDF JavaScript, macros) | Pipeline only ever extracts text via an external vision API — nothing in this codebase renders or executes uploaded content | Done (structurally, not by an explicit disable-flag) |

**Not fully closed**: full process/role isolation for the OCR worker (a dedicated least-privilege identity
with no access to OAuth token decryption) — the async move happened this engagement, but it still shares a
process with every other queue; see `docs/SECURITY_CONTROLS.md` V-row and `docs/DECISIONS.md`.

### 5. Ask Veynlo / RAG

**Data flow**: `POST /v1/ask` → `SearchService.ask` queries purchases/bills/events/documents scoped to
`ownerUserId` → context assembled and sent to Anthropic with a fixed answer schema → response filtered
back against the same owner-scoped context set.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Tampering | Indirect prompt injection via ingested email/document content | System prompt explicitly warns of the technique; context items delimited as `<untrusted_evidence>` | Done, fixed this engagement — **not verified against a real model response** (no API key in this environment) |
| Information disclosure | Cross-tenant retrieval (model shown another user's data) | Every context query is scoped in SQL before the model ever sees a row — authorization happens before retrieval, not after | Done |
| Elevation of privilege | Model-generated tool/action invocation bypassing authorization | N/A today — no tool-calling surface exists; output is a fixed 3-field schema only | N/A, confirmed by dedicated audit this engagement |
| Denial of service | Unbounded Ask usage running up model cost | Redis-backed daily quota per plan | Done |

**Abuse case to watch when agentic actions (Phase 4) are eventually built**: a malicious email instructing
"cancel my subscription and confirm" — must require the same step-up/explicit-confirmation pattern already
used for delete-account/data-export, re-authorized server-side against real user intent, never inferred
from model output alone.

### 6. Household sharing (invites, delegations, dependents)

**Data flow**: `POST /v1/households/:id/invite` → hashed single-use token, emailed → `GET
/v1/households/invite?token=` (unauthenticated peek) → `POST /v1/households/accept-invite` (authenticated,
email-matched) → `household_memberships` row activated. Delegations: `caregiver_delegations` grants a
scoped, revocable capability to an already-active member.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Spoofing | Invite link forwarded to/opened by the wrong account | `acceptInvite` requires the authenticated user's email to match `invitedEmail` | Done, fixed this engagement |
| Tampering | Guessable/brute-forceable invite token | 256-bit random token, hashed at rest, 7-day expiry, single-use (cleared on accept) | Done, fixed this engagement |
| Information disclosure | Unauthenticated peek endpoint leaking too much | Returns only household name + invited email, not full household detail | Done, fixed this engagement |
| Elevation of privilege | Delegation granting more than the intended scope | Scopes validated against a fixed enum; `visibility: "private"` rows excluded from delegated access even with a household-wide grant | Done |
| Elevation of privilege | Quota bypass via repeated invite/accept | Seat quota checked at invite time (invited + active rows both count); accept doesn't double-count | Done, fixed this engagement |

### 7. Billing (Stripe web, RevenueCat mobile)

**Data flow**: `POST /v1/billing/checkout-session` → Stripe-hosted checkout → `checkout.session.completed`
webhook → `entitlements` row inserted; RevenueCat webhook independently normalizes mobile purchases into
the same table.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Spoofing | Forged webhook granting free entitlements | Stripe HMAC signature verification; RevenueCat shared-header verification — both reject unconfigured/invalid signatures before any state change | Done |
| Repudiation | No record of billing state changes | Every webhook event persisted to `billing_events` regardless of outcome | Done |
| Tampering | Client-reported `premium=true` trusted directly | Never done — entitlement state is always server-derived from a verified webhook or admin grant | Done |
| Elevation of privilege | Reusing a Stripe checkout session across users | `client_reference_id`/subscription `metadata.veynloUserId` tie every event back to one specific user | Done |

### 8. Data export

Covered in detail in `docs/SECURITY_CONTROLS.md` V8.2 and the flow-specific step-up entry in V2.11 above —
short version: step-up-protected, S3-backed, signed-URL-only, excludes other household members' private
rows and connector credentials from the manifest.

### 9. Account/data deletion

**Data flow**: `POST /v1/auth/delete-account` (password step-up required) → synchronous session revocation
+ immediate account lockout → `account-deletion` background job cascades through the full data graph → S3
object cleanup → tombstone prevents resurrection via a later backup restore.

| STRIDE | Threat | Mitigation | Status |
|---|---|---|---|
| Repudiation | Deletion request with no re-authentication | Password step-up required (delete-account was the original precedent for this pattern) | Done |
| Denial of service | Deletion blocked/incomplete leaving orphaned data | Background job, retried with backoff; a billing-owner-of-a-shared-household case is explicitly blocked with a clear error rather than silently reassigning ownership | Done |
| Information disclosure | Deleted data resurrected by a routine backup restore | Documented restore-drill process checks for this; tombstone state tracked | Partial — restore-drill verifies row-count parity, not explicitly "deleted users stay deleted after a restore" as its own assertion |

### 10. Agentic actions (Phase 4) — not yet built

No code exists. When built, must inherit: schema-constrained output (already the pattern for every model
call today), mandatory human confirmation with a real preview before any financial/destructive/
communication action executes, per-action step-up re-authentication, monetary/step budgets, and re-
authorization of every tool invocation against live user/household permissions at execution time — a
model-generated object ID must never bypass the same ACL checks a human-initiated request would hit.

## Summary of open items from this pass

- No per-user fairness/priority scheme on the shared worker pool (a large sync could slow other users).
- Prompt-injection defense is code-reviewed but not verified against a live model response.
- OCR worker isolation is process-level (async, bounded) but not yet role/identity-level.
- Restore-drill doesn't yet explicitly assert "deleted stays deleted" as its own check.
- This document itself needs to become a repeatable process (re-run whenever a trust boundary changes),
  not a one-time artifact — tracked in `docs/SECURITY_CONTROLS.md` V1.1.
