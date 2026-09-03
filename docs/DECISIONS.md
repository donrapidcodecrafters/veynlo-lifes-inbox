# Architecture decisions: blueprint vs. current build

This reconciles two "Veynlo Production Architecture & Deployment Blueprint"
documents (a base version and a security-hardened version reviewed
2026-08-28) against what this repository actually runs today. Those
documents describe the **target production deployment on AWS** — Aurora
PostgreSQL Serverless v2, Cognito, SQS/EventBridge, ECS Fargate, S3, RevenueCat,
Control Tower multi-account isolation, and an extensive security/compliance
program (OWASP ASVS/MASVS, SLSA, pentest gates, etc.). This repository is
still pre-launch, self-hosted-shaped, and has never been deployed to AWS.

The blueprint's own §37 ("Requirements Claude should follow now") addresses
exactly this gap directly: shape the repo for the target now, treat AWS
provisioning as a later deployment/configuration step, and where a real
integration is blocked by credentials/accounts, finish the interface and
document the gap rather than stopping. This document is that reconciliation.

## Why the current stack differs, table by table

| Blueprint target | Current build | Why this is fine for now |
|---|---|---|
| Aurora PostgreSQL 17.7 Serverless v2 + RDS Proxy | PostgreSQL **17** + pgvector (`pgvector/pgvector:pg17`, upgraded from pg16 2026-09-01 — image verified to publish both amd64/arm64 manifests via `docker manifest inspect`), plain `pg` driver, Drizzle ORM | Same major version as the Aurora target now, not just the same engine family. Migrated by wiping the local dev volume and re-running migrations from a clean pg17 container (`pnpm --filter @veynlo/db run migrate` applied cleanly; full API test suite — 68 files / 279 tests — passed against it). Swapping `DATABASE_URL` to an Aurora endpoint (plus RDS Proxy in front) is a config change, not a rewrite, *provided* no Aurora-incompatible extension/feature gets introduced later (pgvector is supported on Aurora). CI's postgres service and `pg_dump`/`pg_restore` client tools updated to pg17 alongside (`.github/workflows/ci.yml`). |
| Amazon S3 for private files | S3-compatible MinIO locally, real `@aws-sdk/client-s3` client in `storage.service.ts` | The application code already speaks the S3 API. Production points the same client at a real bucket/region/KMS key — this is the one blueprint item genuinely already "deployment is a config change" today. |
| SQS + EventBridge for queues/events | Redis + BullMQ, behind a `QueueProducer` interface (`services/api/src/queue/queue-producer.interface.ts`, injected everywhere via the `QUEUE_PRODUCER` DI token — confirmed 2026-09-01: every domain service (`identity`, `connectors`, `documents`, `data-export`, `school`, `assets`, `memories`, `notifications`, `admin`, all connector adapters) injects the interface, not the concrete `QueueProducerService`; only `worker-main.ts`, the composition root, references the concrete class) | BullMQ's job model (queue, retry/backoff, DLQ via failed-job listing, delayed jobs) covers what this app currently needs. §37's explicit ask for a `Queue` interface is done — a future `SqsQueueProducerService` implementing the same interface would need no call-site changes. Domain-event fan-out (as opposed to job queuing) is less centralized: `notifications/notification-delivery.service.ts` is the single funnel for in-app/push/queued-email notifications, but `identity.service.ts` and `household.service.ts` call `MailerService` directly for auth-critical transactional email (password reset, email verification, household invite) — two justified, contained exceptions rather than 20 scattered call sites, not a real EventBridge-shaped gap.
| Cognito (passkeys, Apple/Google federation, threat protection) | Custom JWT + argon2 + a revocable `sessions` table, Google/Microsoft OAuth as sign-in methods (not the session system itself) | The custom system already does the things Cognito would primarily buy: passkeys are fully implemented (WebAuthn via `@simplewebauthn/server`, real signature verification, discoverable-credential sign-in — see `docs/SECURITY_CONTROLS.md` V2.10), Google/Microsoft federation works, sessions are server-revocable, and rotating refresh tokens now exist (see below). Migrating to Cognito later means a real identity-provider migration (mapping `identity_links`/`users` to Cognito subjects) — this is the largest realistic rewrite risk in the whole reconciliation, not a config change. Deferred deliberately: with passkeys already shipped in-house, Cognito's remaining incremental value is adaptive/compromised-credential threat protection alone, which isn't worth an identity migration before there are real users to migrate. |
| RevenueCat (Apple/Google/web entitlement normalization) | Stripe (web) + a real RevenueCat webhook handler already normalizing into the same `entitlements` table | Already exactly the target shape for web + the RevenueCat *webhook* side. Missing: the mobile RevenueCat SDK itself (client-side purchase flow) — blocked on real App Store Connect/Play Console subscription products existing, which needs a human with store-account access to create (see docs/ROADMAP.md's billing row). |
| Terraform, three environments | Real Terraform modules already exist and closely track the blueprint: `modules/database` provisions Aurora PostgreSQL **17.7 Serverless v2** by name, `modules/cache` provisions ElastiCache **Valkey Serverless**, `modules/ecs-service` sets `cpu_architecture = "ARM64"` with an inline `# blueprint §10` comment. All seven modules (`alb`, `cache`, `database`, `ecs-cluster`, `ecs-service`, `networking`, `storage`) are wired up in all three environments (`dev`/`staging`/`prod`) — confirmed 2026-08-31 by reading each environment's `main.tf`; the module's own README previously claimed only `networking`+`prod` existed and was stale. | Not applied to a real AWS account (no state exists beyond local `.terraform` init, and this environment has no working `terraform` binary to re-run `validate` against — installing one needs a system Command Line Tools upgrade too invasive to do unilaterally). No `queue`/SQS-EventBridge module exists at all, consistent with the app still running on BullMQ/Redis — that gap needs to close in the application code (see the SQS/EventBridge row above) before a Terraform queue module would have anything real to point at. |
| AWS Control Tower multi-account isolation, GuardDuty/Security Hub/Inspector/Config, CloudTrail org trails | None of this exists — there is no AWS account yet | Entirely a provisioning-time concern. Nothing in application code depends on single- vs. multi-account structure. |
| ECS Fargate ARM64 containers | Dockerfiles exist for the API/worker (`services/api/Dockerfile`); CI builds both targets on every PR (`docker-build` job, `docker/build-push-action`) | ARM64 buildability confirmed live 2026-09-01: `docker build --platform linux/arm64` succeeded for both the `api` and `worker` targets, and the resulting `api` image was run against the real docker-compose stack (Postgres 17, Redis, MinIO) with a genuine `GET /health/ready` → 200 over the network — not just a build-time check. |
| OWASP ASVS/MASVS/API-Top-10 program, SLSA provenance, independent pentest, bug bounty | No formal program; ad hoc but genuinely rigorous manual verification throughout ROADMAP.md, plus a security pass in this session (see below) | A real independent pentest and a tracked ASVS control matrix (`docs/SECURITY_CONTROLS.md`, per blueprint §28.1) are launch-gate items requiring a paid vendor, not something to fake here. Everything *code-level* the blueprint's §28 asks for was spot-checked this session (BOLA/IDOR, mass assignment, admin/consumer session isolation, JWT algorithm allowlisting, rate limiting on cost-bearing routes) — see the 2026-08-31 entry in docs/ROADMAP.md for exactly what was tested and what was found/fixed. |

## §37 checklist audit (2026-09-01)

A full item-by-item pass against blueprint §37 ("Requirements Claude should
follow now"), verifying the claims in this document against the actual repo
rather than trusting them, and creating `docs/IMPLEMENTATION_STATUS.md` (the
one §37-named doc that didn't exist yet). Findings and fixes:

- **PostgreSQL 17** (§37 explicit ask, previously an open gap in this table)
  — upgraded, see the row above. Real fix, not just a version bump: fresh
  container, fresh migration run, full test suite passed against it.
- **A real, live bug found and fixed**: `packages/authz` had been deleted
  from the working tree (dead scaffolding — confirmed nothing in the app
  imports `@veynlo/authz` any more; several schema/service comments already
  described it in the past tense as unused) but the cleanup was incomplete —
  `services/api/Dockerfile` still `COPY`'d `packages/authz/package.json`,
  which failed the Docker build outright, and `.github/workflows/ci.yml`'s
  "Build shared packages" step still `--filter`'d `@veynlo/authz`, which
  would have failed the same way on the next CI run. Fixed both, and removed
  the leftover `packages/authz/` directory (build artifacts only — `dist/`,
  `node_modules/`, `.turbo/` — no source left). Neither breakage was caught
  by `tsc --noEmit`, which doesn't see Dockerfile `COPY` lines or CI YAML —
  a reminder that "typecheck passes" and "the container build works" are
  genuinely different checks, which is exactly why §37 asks for a real local
  `docker build`, not just a typecheck.
- **`QueueProducer` interface**: this table's SQS/EventBridge row previously
  said no `Queue` interface existed. It exists now (`queue-producer.interface.ts`,
  DI token `QUEUE_PRODUCER`) and every domain service already depends on it,
  not the concrete BullMQ class — confirmed by grep, not assumed. The table
  row above is corrected. (Not clear from this pass whether that interface
  was added in the time between 2026-08-31 and now by unrelated work, or
  whether the prior table entry was simply wrong when written — either way,
  the current state is now accurately recorded.)
- **`SECURITY.md` vs. blueprint's `docs/SECURITY.md`**: the blueprint (§37)
  names `docs/SECURITY.md`. This repo has `SECURITY.md` at the repo root
  (extensively cross-referenced from `README.md`, CI, and every other doc)
  plus a *different* document, `docs/SECURITY_CONTROLS.md` (an ASVS-scoped
  control matrix). Neither is literally `docs/SECURITY.md`. Not renamed —
  root `SECURITY.md` is linked from too many places for a blind rename to be
  a safe, valuable use of this pass, and the two documents serve genuinely
  different purposes (narrative security posture vs. a control checklist).
  Recorded here rather than silently left inconsistent; a future session
  could add a one-line `docs/SECURITY.md` pointer file if the literal path
  ever matters to tooling.
- **Terraform, interfaces, env config, no-local-disk-writes, monorepo/Turborepo
  shape**: all independently verified already in place and correct — no
  changes needed. See `docs/IMPLEMENTATION_STATUS.md` for the full per-item
  verification evidence (what was actually run/checked, not just read).

## What this session changed toward the target (2026-08-31)

Concrete, code-level closures of gaps this repo's own ROADMAP.md had flagged,
done without waiting for AWS to exist — in the spirit of §37:

- **Quota enforcement** (`services/api/src/modules/entitlements/`) — the
  `CapabilityKey`/`resolveCapability` system existed but nothing outside
  billing called it. Connector count, Ask daily throttle (Redis-backed —
  exactly the "distributed rate-limit counter" role §16 reserves Valkey/Redis
  for), document storage cap, and household-size cap are now real,
  server-enforced limits, verified live against the running API.
- **Entity-resolution knowledge graph** — `relationships`/`facts` now have a
  real second writer (asset purchase-detail facts, warranty-covers-asset
  relationships), closing part of the "entirely unwritten" gap ROADMAP.md
  tracked. Found and fixed a real bug along the way: `purchase_lines.owner_asset_entity_id`
  had no `ON DELETE` behavior, which would have blocked full account deletion
  (a PRIV-002 regression) the moment a real user had both a purchase and a
  deletable graph entity — migration `0013` fixes this with `ON DELETE SET NULL`.
- **Session refresh-token rotation** (`sessions.previous_refresh_token_hash`/`refresh_expires_at`,
  `POST /v1/auth/refresh`) — mobile now holds a rotating refresh token with
  reuse detection (a replayed, already-rotated token revokes the session),
  closing the "not the full rotating-refresh-token flow ... for mobile" gap.
- **Mobile OAuth connector connect** — the callback now redirects to
  `veynlo://connections` for native platforms instead of unconditionally to
  `WEB_APP_URL`. Found and fixed a more serious bug while wiring this: the
  callback routes required an authenticated session (class-level
  `@UseGuards(AuthGuard)`), which a native OAuth round-trip through the
  system browser can never carry — the flow was silently broken for real
  devices regardless of the deep-link target. Guards are now per-route; the
  four callback routes rely solely on the signed, short-lived OAuth `state`
  (the same trust model `identity.controller.ts`'s own sign-in callbacks
  already use).
- **Inbox correction audit logging** — `InboxService.correct()` now writes an
  `audit_events` row, closing the one documented audit gap short of household
  ACL/ownership changes.
- **Security spot-check fixes**: bumped `nodemailer` (6.9 → 9.1, patches
  several real CVEs including an arbitrary-file-read/SSRF-via-raw-message
  issue) and its types; fixed a live bug where `z.coerce.boolean()` turned
  the literal string `"false"` into `true` for `SMTP_SECURE`/`S3_FORCE_PATH_STYLE`
  (confirmed live: this was silently breaking Mailhog delivery in dev via a
  bogus TLS handshake); added an explicit JWT algorithm allowlist to every
  `jwtVerify` call site (defense-in-depth, not a live exploit); added
  per-route rate limits to document upload, data export, and Ask (Ask's real
  cost control is the new daily quota above — this is the secondary
  per-minute layer). Cross-tenant IDOR spot checks (purchases/bills/warranties/documents/connections),
  mass-assignment attempts, and admin/consumer session isolation were tested
  live against two real seeded users and found correctly enforced — no
  fixes needed there.
- **`drizzle-orm` SQL-injection advisory** (packages/authz's copy, <0.45.2) —
  identified, not fixed. The vulnerable surface is dynamic SQL identifier
  construction (`sql.identifier`/`sql.raw`); this codebase has zero call
  sites using either, so it's not currently reachable. A 0.38 → 0.45+ bump
  touches the query builder used by every schema/migration in the app and
  deserves its own dedicated regression pass, not a same-session drive-by fix.

## A second pass (2026-08-31): interface refactor + full-blueprint audit

Ran a systematic, section-by-section audit of both blueprint documents (four
parallel passes covering every numbered section, plus a live spot-check
against this repo's own claims) alongside the `Connector`/`ObjectStorage`/
`ModelProvider`/`QueueProducer` interface extraction §37 asks for. See
`SECURITY.md`'s matching dated entry for the full list — the short version:

- **Interfaces done** — `QueueProducer`, `ObjectStorage`, `ModelProvider`,
  and `Connector`/`OAuthConnectorAdapter` all now exist as real TypeScript
  interfaces with DI tokens (`useExisting` so the concrete class stays the
  single source of truth), verified live end-to-end (sign-up → document
  upload → account deletion, exercising all three token-based interfaces
  through the real running API and worker).
- **Found while wiring the interfaces: the worker process could not boot at
  all** in this exact working tree — a dependency-resolution failure
  specific to `createApplicationContext` (never the plain HTTP bootstrap)
  that made every background job (account deletion, connector sync,
  notification delivery) silently never run. Fixed and verified live.
- **Found via the audit and fixed, all verified live**: `.env` was never
  actually loaded (the most consequential finding — every optional
  integration a developer configured via `.env` was silently ignored);
  the inbound-email webhook ran AI synchronously; Microsoft sign-in's
  `id_token` had no signature verification; no CSRF protection existed on
  cookie-authenticated routes; no password reset flow existed at all;
  sensitive financial/calendar detail went into notification emails by
  default with no opt-out; the desktop app hardcoded `localhost:3000` even
  in release builds. Full detail, evidence, and verification steps for each
  are in `SECURITY.md`'s 2026-08-31 entry, not duplicated here.

## A third pass (2026-08-31): live end-to-end testing across every feature domain

Ran 6 parallel testing agents against the real running API/worker/DB (not code reading) covering every
backend feature domain, per an explicit instruction to test — not just read — every feature. Full detail
and evidence in SECURITY.md's matching entry. Found and fixed three real bugs: household invites were a
complete dead end (no accept endpoint, no email ever sent, despite a comment claiming otherwise — now a
real emailed accept-link flow with a matching web page); shipment dedup matched by tracking number
globally instead of per-owner (a real cross-tenant data-corruption risk, now fixed with an owner-scoped
column); demo seed data's evidence view was always null (a seed-data bug, not app-code). Everything else
tested — session/CSRF/OAuth, quota enforcement, cross-tenant IDOR spot-checks, SSRF guarding, admin/
consumer isolation, data export, inbox lifecycle including a live snooze-worker tick, timeline — passed.

**Newly confirmed, then closed this same pass: there was no household-management UI on web or mobile at
all** — no page to create a household, view/manage members, send invites, or configure delegations/
dependents. Asked the user directly rather than assuming scope; told to build it now. Added
`apps/web/src/app/(app)/settings/household/page.tsx` (create household, member list, invite form,
dependents, caregiver-delegation grant/revoke with per-scope switches) plus a "Household" entry on the
main Settings page. Verified live end-to-end via the exact same API calls the UI makes: create → invite →
real emailed accept link → sign-up → accept → grant delegation → revoke → leave, all producing the correct
DB state at each step; both new pages also confirmed to compile and serve cleanly from the running Next.js
dev server. Web only — mobile still has no household UI, deliberately deferred (mobile has historically
lagged web for new feature surfaces in this codebase; revisit if mobile household management turns out to
be needed for MVP).

## A fourth pass (2026-08-31): full §37/§28 re-audit against both blueprint documents

Re-read both uploaded blueprint documents in full and re-checked the whole repo section by section,
using parallel research agents for breadth. Found and fixed, all typechecked/tested/live-verified (full
detail in SECURITY.md's matching dated entry):
- The three missing §37 interfaces (`Cache`, `EmailProvider`/`PushProvider`, `BillingProvider`) — only
  `Queue`/`ObjectStorage`/`ModelProvider`/`Connector` existed before.
- A real mass-assignment gap on `PUT /v1/notification-preferences` (no request validation at all).
- Missing magic-byte upload validation (§28.13) and a missing PDF page-count cap + model-call timeout.
- No prompt-injection defense framing in Ask Veynlo's RAG prompt (§28.15) — retrieved content is now
  explicitly delimited and labeled untrusted, not verified against a live model call since
  `ANTHROPIC_API_KEY` is empty in this environment.
- `services/api/.env.example` was incomplete/truncated — rewritten to match `config/env.ts` exactly.
- No revoke-one-session control and no session-list UI on any client at all — added both, plus a
  `.github/dependabot.yml` (§28.3 SCA/dependency scanning), which didn't exist before.

Also re-verified live: browser extension (real request replay), desktop app (a real unsigned release
`.dmg` build), admin console (real sign-in + every dashboard endpoint), and a spot-check of 3
ROADMAP Phase-1 claims — all held up, no inflated claims found.

**Was deliberately not implemented in the fourth pass, then finished in the fifth (same day) after the
user asked to keep going**: step-up (password) re-verification on data-export and connector-disconnect,
per §28.9, plus the session-management UI. See the fifth-pass section below.

## A fifth pass (2026-08-31, same day): everything flagged as remaining, finished or explicitly declined

The user asked to "do everything you can" on the items listed as still open at the end of the fourth pass.
Done, all typechecked/tested/live-verified (full evidence in SECURITY.md's matching dated entry):

- **Step-up auth**, built correctly this time: `IdentityService.verifyStepUpPassword` is a no-op for
  OAuth-only accounts, otherwise requires+verifies a password exactly like `delete-account`. Wired into
  `DataExportService.requestExport` and `ConnectorsService.disconnect` (only for the destructive
  `deleteDerivedData: true` path — a plain disconnect stays frictionless). Web and mobile both updated to
  try with no password first and only prompt if the server actually asks for one. Live-verified all
  branches: no-password → 401, wrong password → 401, correct password → success, OAuth-only account →
  succeeds with no prompt at all.
- **OCR moved off the synchronous upload request into a real background worker** — a new `document-ocr`
  BullMQ queue, a real `ObjectStorage.getObject()` so the worker can re-fetch the stored file, and
  `DocumentsService.processOcr`. Verified live with a genuinely novel technique for this environment: set a
  temporary dummy `ANTHROPIC_API_KEY` (reverted immediately after; `.env` is gitignored, so it was never at
  risk of being committed) to force the real code path without a real paid credential, confirmed the
  document sat in a real pending state immediately after upload, watched the worker log a real `401` from
  Anthropic's actual API a few seconds later (proof it's a genuine network call), and confirmed the
  terminal DB state and job-completion semantics matched the old synchronous code exactly.
- **Three compliance documents the blueprint explicitly names** and none of which existed:
  `docs/SECURITY_CONTROLS.md` (ASVS-scoped control matrix), `docs/THREAT_MODEL.md` (data-flow diagrams +
  STRIDE + abuse cases for every real flow), `docs/VENDOR_REGISTER.md` (every actual third-party
  integration point, with legal-terms columns honestly marked "verify before launch" rather than guessed).

**Explicitly declined, not attempted, and why**: App Attest, Play Integrity, and Terraform/IaC scanning.
All three would produce code with zero way to verify it actually works in this environment — App Attest
and Play Integrity need a real device plus real Apple/Google developer-console configuration to generate a
real attestation token to test against; IaC scanning needs a scanner tool (Checkov/tfsec) this environment
doesn't have installed, and its findings can't be meaningfully sanity-checked without running it for real.
Writing unverified security-critical code and calling it done would be a worse outcome than clearly
documenting the gap, which is what `docs/SECURITY_CONTROLS.md`'s "Not yet done" section does instead.

## Not attempted this session, and why

- **Apple Sign-In, mobile RevenueCat SDK/native paywall, App Attest, Play Integrity** — all need real
  portal-created artifacts (Apple Services ID + private key; App Store
  Connect/Play Console subscription products + a RevenueCat project; real device attestation) that
  only a human with store-account/device access can create. Code-side work is
  ready to receive those values via `.env` once created.
- **Terraform apply / real AWS account / IaC scanning** — no AWS credentials exist in this
  environment, and provisioning real cloud infrastructure is exactly the
  kind of action this process should not take without explicit, scoped
  authorization; IaC scanning needs a real scanner tool this environment lacks.
- **Independent pentest, SBOM/provenance pipeline signing** —
  legitimately require external vendors/tooling decisions, not something to
  simulate.
