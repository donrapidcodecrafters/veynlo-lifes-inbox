# Security controls matrix

Blueprint §28.1: "Maintain a security requirements matrix in the repository ... with columns for control
ID, applicability, implementation, automated test, manual verification, evidence, owner, and last
verification date. Security controls are release requirements. A control is not considered implemented
merely because it is described in documentation."

This matrix tracks controls against **OWASP ASVS 5.0.0** categories, scoped to what's actually applicable
to this app (a NestJS/Fastify API + Next.js/Expo/Tauri clients, self-hosted-shaped, pre-AWS-deployment —
see `docs/DECISIONS.md`). It is not a transcription of all ~280 ASVS requirements; many don't apply to this
architecture (e.g. server-rendered-page-specific controls for an API-only backend) or apply only once a
real AWS deployment exists (tracked as "Infra-gated" — not a current gap, just not yet provisionable). Every
row below is either independently verified live against the running app, or explicitly marked as a known
gap — no row claims "done" on the strength of a comment or a design intent alone.

**Owner**: single-developer repository today (see CODEOWNERS) — every row's owner is the same person
until the team grows. **Last verification date**: 2026-08-31 for every row below unless noted, reflecting
this session's live re-verification pass (see `SECURITY.md`'s dated entries for the actual test evidence).

## V1 — Architecture, design, and threat modeling

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V1.1 | Secure SDLC (threat modeling on trust-boundary changes) | Applicable | Not formalized as a repeatable process | No | No | Gap — see "Not yet done" below |
| V1.2 | Authentication architecture documented | Applicable | Custom JWT + argon2, session table, OAuth federation | No | Yes | `SECURITY.md`, `docs/DECISIONS.md` (Cognito-vs-custom reconciliation) |
| V1.4 | Access control architecture (deny by default, centralized policy) | Applicable | Per-resource ownership checks in every service (`ownerOrDelegatedHousehold` pattern); `AuthGuard`/`AdminGuard`/`SuperAdminGuard` | Partial (auth guard unit coverage is thin) | Yes — live cross-tenant IDOR checks this session | `SECURITY.md`'s IDOR spot-check entries |
| V1.7 | Errors/exceptions don't leak sensitive detail | Applicable | Every controller throws typed exceptions with `{code, message}`; no stack traces returned to clients | No | Yes | Spot-checked across every live test this session — no stack traces observed in any response |
| V1.14 | Configuration is externalized (12-factor) | Applicable | `config/env.ts`, Zod-validated, fails fast on invalid/missing production secrets | Partial | Yes | `services/api/src/config/env.ts` |

## V2 — Authentication

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V2.1 | Password strength requirements | Applicable | Min 10 chars enforced at signup/reset (Zod schema) | No | Yes | `identity/dto.ts` |
| V2.2 | Anti-automation on auth endpoints (rate limiting) | Applicable | `@Throttle` on sign-in/sign-up/forgot-password/reset-password | No | Yes (live 429 confirmed this session) | `identity.controller.ts` |
| V2.3 | Secure credential storage (no plaintext/reversible passwords) | Applicable | argon2id hashing, never logged | No | Yes | `identity.service.ts` |
| V2.5 | No security questions as sole recovery factor | Applicable | Token-based email reset only, no security questions anywhere | N/A | Yes | `identity.service.ts`'s `forgotPassword`/`resetPassword` |
| V2.7 | Federated auth (OAuth) does not silently account-link on email match | Applicable | `oauthSignIn` only signs in via an existing `identity_links` row; colliding email with no link is rejected, not merged | No | Yes | `identity.service.ts`, live-tested this session |
| V2.8 | OAuth `id_token` signature verification | Applicable | Google (`googleapis` `verifyIdToken`) and Microsoft (`jose`/`createRemoteJWKSet` against the real JWKS endpoint) both verified | No | Yes | `identity.service.ts`, fixed and live-verified this session |
| V2.10 | MFA / passkeys | Applicable | **Implemented.** WebAuthn via `@simplewebauthn/server` v13 — real cryptographic `verifyRegistrationResponse`/`verifyAuthenticationResponse`, not a stub. Six endpoints under `v1/auth/passkeys` (list, delete, registration-options/verify, authentication-options/verify), backed by the `passkeys` table. Sign-in uses a discoverable-credential ("usernameless") flow, feature-detected via `browserSupportsWebAuthn()`. Password remains a valid alternative factor, so this is passwordless-capable rather than enforced second-factor | Yes (7 unit tests, `passkey.service.test.ts`) | Yes | `identity/passkey.{controller,service}.ts`; UI at web `/settings/security` + `/sign-in`, mobile `app/security/index.tsx` |
| V2.11 | Step-up/recent auth for high-impact actions | Applicable | `IdentityService.verifyStepUpPassword` — used by delete-account, data-export, destructive connector-disconnect; no-ops correctly for OAuth-only accounts | Yes (unit-test-shaped live verification this session) | Yes — live tested all three call sites, both password-present and OAuth-only paths | `SECURITY.md`'s 2026-08-31 fifth-pass entry |

## V3 — Session management

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V3.2 | Session tokens are unpredictable, high entropy | Applicable | JWT signed with `SESSION_JWT_SECRET`; refresh tokens are `randomBytes(32)` base64url | No | Yes | `identity.service.ts`, `packages/core/src/util/token.ts` |
| V3.3 | Session invalidation on logout | Applicable | `sign-out` revokes the current session server-side, not just client-side cookie clear | No | Yes | `identity.controller.ts` |
| V3.5 | Refresh token rotation with reuse detection | Applicable | `POST /v1/auth/refresh` rotates; a replayed already-rotated token revokes the whole session | No | Yes (live, 2 rotations + replay-detection confirmed) | `docs/DECISIONS.md` |
| V3.7 | User-visible session/device list with revoke-one and revoke-all | Applicable | `GET /v1/auth/sessions`, `POST /v1/auth/sessions/:id/revoke`, `sign-out-everywhere`; web UI at `/settings/security` | No | Yes — live cross-user-protection test confirmed one user cannot revoke another's session | `SECURITY.md`'s 2026-08-31 fourth-pass entry |
| V3.10 | Cookie security attributes (Secure, HttpOnly, SameSite) | Applicable (web) | Session cookie set with all three | No | Yes | `identity.controller.ts` |

## V4 — Access control

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V4.1 | Object-level authorization on every resource fetch (BOLA/IDOR) | Applicable | Every read/write scoped by `ownerUserId`/household membership before query execution, not filtered after | No | Yes — extensive live cross-tenant testing across purchases/bills/documents/connections/household/commerce/schedule this session | `SECURITY.md`, multiple dated entries |
| V4.2 | Property-level authorization (mass assignment) | Applicable | Explicit Zod DTOs + allowlisted update fields on every mutating endpoint | No | Yes — found and fixed a real gap (`notification-preferences`) this session | `SECURITY.md`'s fourth-pass entry |
| V4.3 | Function-level authorization (admin/role checks) | Applicable | `AdminGuard`/`SuperAdminGuard` separate from consumer `AuthGuard`; admin session isolation | No | Yes — live tested admin/consumer session isolation | `SECURITY.md` |
| V4.4 | Household/multi-tenant delegation is scope-checked | Applicable | `delegatedHouseholdIds` + per-domain `ownerOrDelegatedHousehold` helpers (commerce/schedule/documents); `visibility: "private"` excluded from delegated access | No | Yes — live tested grant/revoke across all three domains | `docs/ROADMAP.md`'s Household row |

## V5 — Input validation and untrusted-file handling

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V5.1 | Server-side validation on every input (not just client-side) | Applicable | Zod schemas + `ZodValidationPipe` on every mutating endpoint | No | Yes | Repo-wide `dto.ts` pattern |
| V5.2 | File upload: size limit | Applicable | 25MB hard cap | No | Yes | `documents.service.ts` |
| V5.2 | File upload: type/magic-byte validation | Applicable | `file-signature.ts` — real signature checks, not trusted client MIME headers | Yes (10 unit tests) | Yes — live 400 on mismatched content | `SECURITY.md`'s fourth-pass entry |
| V5.2 | File upload: malware scanning | Applicable | ClamAV via `MalwareScannerService`, fails closed once configured | No | Yes — live EICAR test confirmed detection | `docs/ROADMAP.md`'s Known-limitations section |
| V5.2 | PDF page-count / resource-consumption bound | Applicable | `approxPdfPageCount`, 100-page cap; 2-minute model-call timeout | Yes (4 unit tests) | Yes — live 400 on oversized PDF | `SECURITY.md`'s fourth-pass entry |
| V5.2 | Archive/decompression-bomb protection | N/A | No archive/zip handling exists anywhere in the codebase | N/A | N/A | Confirmed via repo-wide dependency/import search |
| V5.3 | SSRF protection on user-supplied URLs | Applicable | `SafeUrlFetcher` — DNS-resolves and blocks private/reserved/metadata ranges, redirect revalidation | Yes (11 unit tests) | Yes — live tested against `169.254.169.254` and `localhost` | `safe-url-fetcher.ts`/`.test.ts` |
| V5.5 | Deserialization / injected-field safety | Applicable | Drizzle parameterized queries throughout; no raw string SQL concatenation found in a repo-wide audit | No | Yes | Repo-wide grep for `sql\`` usage |

## V6 — Cryptography

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V6.1 | No custom/homegrown cryptographic primitives | Applicable | AES-256-GCM via Node's built-in `crypto`, argon2 via `argon2` package | No | Yes | `packages/db/src/crypto/field-encryption.ts` |
| V6.2 | Encryption at rest for sensitive fields | Applicable | 50+ encrypted columns across every domain, explicit key-version tagging for rotation | Yes (8 + 6 unit tests) | Yes | `field-encryption.test.ts`, `encrypted-type.test.ts` |
| V6.2 | A single corrupted row cannot take down a whole query | Applicable | Per-cell decrypt-failure isolation with a placeholder/fallback, not a thrown exception | Yes (6 unit tests) | Yes — live reproduction of the original 500 bug, confirmed fixed | `SECURITY.md`'s encrypted-type entry |
| V6.4 | Key rotation support | Applicable | Explicit `_VERSION`/`_PREVIOUS` env vars, documented rotation procedure | Yes (rotation unit test) | No (never exercised against a real production rotation) | `field-encryption.ts`'s doc comment |
| V6.6 | Production requires real (non-default) secrets | Applicable | `PRODUCTION_REQUIRED_SECRETS` check refuses to boot with a dev-default secret in `NODE_ENV=production` | No | Yes (code-reviewed) | `config/env.ts` |

## V7 — Error handling and logging

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V7.1 | Structured logs, secrets redacted | Applicable | `nestjs-pino`, `Authorization`/`Cookie`/password fields redacted | No | Yes | `logging.module.ts` |
| V7.4 | Audit trail for sensitive actions | Applicable | `audit_events` table; login/recovery, OAuth changes, household ACL changes, bulk export/delete, admin access, inbox corrections all write real rows | No | Yes — live verified encrypted before/after payloads round-trip | `docs/ROADMAP.md`'s audit-logging entry |
| V7.4 | Metrics/tracing (OpenTelemetry/Sentry) | Applicable | **Not implemented.** Structured logs only | No | No | Known gap — no SDK installed at all, not just unconfigured |

## V8 — Data protection

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V8.1 | Sensitive data minimized in admin/support tooling | Applicable | Admin lookups return metadata only (connection health, entitlement status) — never document/email bodies or financial detail | No | Yes | `admin.service.ts`'s explicit doc comment + code review |
| V8.2 | User-initiated data export | Applicable | `POST /v1/data-export`, real S3-backed manifest, 5-minute signed download URL, step-up-protected | No | Yes — live end-to-end this session | `docs/ROADMAP.md`'s Data-export row |
| V8.3 | Real account/data deletion (not deactivation) | Applicable | Background job cascades through the full data graph; tombstone prevents resurrection on restore | No | Partial — deletion job logic reviewed, not independently re-verified against every table this pass | `identity.service.ts`'s `requestDeletion` |
| V8.6 | Sensitive detail excluded from notification previews by default-configurable opt-out | Applicable | `notificationPreferences.sensitivePreviewsEnabled`, real Settings toggle | No | Yes — live verified detailed vs generic notification bodies | `docs/DECISIONS.md` |

## V9 — Communications security

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V9.1 | TLS everywhere in transit | Infra-gated | Local dev is plaintext HTTP by design (Docker Compose); production TLS termination is an AWS/edge decision not yet provisioned | N/A | N/A | `docs/DECISIONS.md` |
| V9.2 | Security headers (HSTS, CSP, etc.) | Applicable | `helmet`-equivalent headers confirmed present on live responses this session (`x-content-type-options`, `x-frame-options`, `strict-transport-security`, etc.) | No | Yes — observed on every live curl response this session | Response headers captured during live testing |

## V10 — Malicious/untrusted input (AI-specific)

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V10.x (AI) | Authorization before retrieval in RAG (Ask Veynlo) | Applicable | Every context query scoped by `ownerUserId` in SQL before the model ever sees a row | No | Yes — code-reviewed by a dedicated audit pass this session | `search.service.ts` |
| V10.x (AI) | Prompt injection defense — untrusted content labeled as data, not instructions | Applicable | System prompt explicitly warns of indirect prompt injection; context items wrapped in `<untrusted_evidence>` delimiters | No | No — not verified against a real model response (`ANTHROPIC_API_KEY` unset in this environment); code-reviewed and typechecked only | `SECURITY.md`'s fourth-pass entry |
| V10.x (AI) | Model output is schema-constrained, not free-form action | Applicable | `extractStructured` forces `tool_choice` against a fixed Zod-derived schema on every call | No | Yes — code-reviewed | `anthropic-extraction.service.ts` |
| V10.x (AI) | No agentic tool-calling / action-execution surface exists yet | N/A | Confirmed no such capability exists (Ask is single-turn Q&A) | N/A | Yes | Dedicated audit pass this session |

## V11 — Business logic / abuse resistance

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V11.1 | Per-user/plan quotas on cost-bearing operations | Applicable | Connector count, Ask daily throttle (Redis-backed), document storage cap, household-size cap all enforced server-side | No | Yes — live tested each quota this session and in prior passes | `entitlements.service.ts` |
| V11.2 | Invitation/referral flows resist enumeration and self-abuse | Applicable | Household invites use a hashed, single-use, short-lived token (same shape as password reset); email-match check on accept | No | Yes — live tested including the email-mismatch rejection path | `SECURITY.md`'s household-invite entry |
| V11.3 | Webhook idempotency and signature verification | Applicable | Stripe (HMAC), RevenueCat (shared header), inbound-email (shared header) all verified before any state change | No | Yes — live tested rejection paths for all three | `SECURITY.md` |

## V12 — Files and resources

See V5 above (file upload controls) — ASVS folds these together for this app's shape.

## V13 — API security

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V13.1 | CSRF protection on cookie-authenticated state-changing routes | Applicable | Custom-header requirement (`x-veynlo-csrf`) — a plain HTML form can't set it | No | Yes | `common/csrf.ts` |
| V13.2 | JWT algorithm allowlist (reject `alg: none`, algorithm confusion) | Applicable | Explicit `algorithms: [...]` on every `jwtVerify` call site | No | Yes — code-reviewed across all call sites | `docs/DECISIONS.md` |
| V13.4 | Rate limiting on cost-bearing/sensitive routes | Applicable | Per-route `@Throttle` on document upload, data export, Ask, auth endpoints | No | Yes — live 429 confirmed for data-export | `SECURITY.md` |

## V14 — Configuration and supply chain

| ID | Control | Applicability | Implementation | Automated test | Manual verification | Evidence |
|---|---|---|---|---|---|---|
| V14.1 | CI runs lint/typecheck/test/security-scan on every PR | Applicable | `.github/workflows/ci.yml` — gitleaks (secret scan), semgrep (SAST), SBOM generation, backup/restore drill | No | Yes — pipeline itself reviewed and re-verified this session | `.github/workflows/ci.yml` |
| V14.2 | Dependency scanning with automated update PRs | Applicable | `.github/dependabot.yml` — npm/github-actions/docker/terraform ecosystems | No | Config validated (YAML syntax), not yet observed opening a real PR | `.github/dependabot.yml` |
| V14.3 | CI actions pinned to immutable commit SHAs | Applicable | All 7 third-party actions pinned to verified commit SHAs, not mutable tags | No | Yes — each SHA independently verified against `gh api` | `.github/workflows/ci.yml` |
| V14.4 | Container image signing / provenance | Infra-gated | Needs AWS Signer/ECR, which needs a real AWS account | N/A | N/A | `docs/DECISIONS.md` |
| V14.5 | IaC scanning (Terraform) | Not done | No Checkov/tfsec/similar wired into CI | No | No | Known gap — see "Not yet done" |
| V14.6 | Secrets never committed | Applicable | `.env` gitignored, verified this session; no secret-scanning findings to date | No | Yes | `SECURITY.md`'s pre-submission checklist |

## Incident response

Blueprint §28's "documented incident-response path before launch, including token revocation, key rotation,
forced logout, provider compromise, and user notification decisions" is covered in a dedicated document —
`docs/INCIDENT_RESPONSE.md` — rather than as a matrix row, since it's a runbook (concrete steps + named code
paths) rather than a single pass/fail control. It also surfaces several real gaps found while writing it
(no admin-facing force-logout for a consumer user, `users.status`'s `"suspended"` value going completely
unused/unenforced, `CredentialVault` having no key-rotation mechanism unlike `field-encryption.ts`) — those
are tracked in that document's own "Known gaps" section, not duplicated here.

## Not yet done (tracked here, not hidden)

- **Enforced second factor** — passkeys are fully built and usable (see V2.10), but a user may still sign in with a password alone. What is missing is *enforcement*: no per-account "require a second factor" setting, and no admin policy to require one org-wide. Passwordless is available; step-up-on-every-login is not.
- **Formal, repeatable threat-modeling process** — see `docs/THREAT_MODEL.md` for a first pass covering the highest-risk flows; not yet a standing practice triggered on every trust-boundary change.
- **OpenTelemetry/Sentry** — no SDK installed; structured logs are the only current observability signal.
- **IaC scanning** — no Checkov/tfsec/Terrascan wired into CI for the Terraform modules.
- **Container image signing/provenance, App Attest, Play Integrity** — all genuinely need a real AWS account and/or real Apple/Google developer console configuration + a real device to test against; not safely buildable as verified code in this environment (see `docs/DECISIONS.md`).
- **Independent penetration test, ASVS Level 2/3 formal assessment** — this matrix is a working internal tool, not a substitute for third-party verification.
