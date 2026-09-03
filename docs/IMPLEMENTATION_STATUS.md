# Implementation status

A snapshot of what's actually built, tested, and verified locally versus
what's blueprint-described but genuinely blocked on a real AWS account,
provider credentials, or money. This is the doc blueprint §37 asks for
("Create ... docs/IMPLEMENTATION_STATUS.md"); it's a pointer/index, not a
restatement — feature-by-feature detail lives in `docs/ROADMAP.md`,
credential-gated items in `docs/PHASE2_PENDING_CREDENTIALS.md` and
`docs/PHASE3_PENDING_CREDENTIALS.md`, and the blueprint-vs-current-stack
reconciliation in `docs/DECISIONS.md`. This document instead answers one
narrower question: **is the repo shaped so that the eventual AWS production
transition is a deployment/configuration step, not a rearchitecture** — the
exact question blueprint §37 poses — checked item by item against §37's own
checklist, with evidence, as of 2026-09-01.

## §37 checklist — verified against the repo

| # | §37 requirement | Status | Evidence |
|---|---|---|---|
| 1 | Monorepo: pnpm + Turborepo, apps/web, apps/mobile, apps/api, apps/worker, apps/desktop + shared packages | Done, with one naming difference | `pnpm-workspace.yaml` covers `apps/*`, `services/*`, `packages/*`. `turbo.json` exists and is wired into every root script (`build`/`dev`/`lint`/`typecheck`/`test`). Present: `apps/web`, `apps/mobile`, `apps/admin`, `apps/desktop`, `apps/browser-extension`, `packages/core`, `packages/db`, `packages/design-tokens`. **Naming difference from the blueprint**: this repo uses `services/api` (not `apps/api`), and the API/worker are two entrypoints of one package (`src/main.ts`, `src/worker-main.ts`) rather than separate `apps/api`/`apps/worker` packages. Not renamed — it's a cosmetic difference with a real workspace-glob/CI/Docker-context blast radius and zero effect on deployability; `services/api/Dockerfile` builds each entrypoint as an independent container target (`--target api` / `--target worker`), which is the property that actually matters for ECS. |
| 2 | Containerize API and worker now; CI builds ARM64/multi-arch images | Done, verified live | `services/api/Dockerfile` is a multi-stage build (deps → build → runtime-base → `api`/`worker` targets), non-root user (`veynlo`, uid 1001), architecture-agnostic base image. Verified this session: `docker build --platform linux/arm64` succeeded for both the `api` and `worker` targets; the built `api` image was run against the real `docker-compose` stack (Postgres 17, Redis, MinIO) and answered a real `GET /health/ready` → `200` over the network — not just a build-time check. `.github/workflows/ci.yml`'s `docker-build` job builds both targets on every PR via `docker/build-push-action` (no registry push configured yet — correct, since no ECR exists). |
| 3 | PostgreSQL 17 locally, portable migrations | Done, verified live | `infrastructure/docker/docker-compose.yml` upgraded from `pgvector/pgvector:pg16` to `pgvector/pgvector:pg17` this session (image confirmed to publish both `linux/amd64` and `linux/arm64` manifests via `docker manifest inspect`). Verified: wiped the local dev volume, started a fresh pg17 container, ran `pnpm --filter @veynlo/db run migrate` clean against it, then ran the full API test suite (68 files / 279 tests) against it — all passed. `.github/workflows/ci.yml`'s postgres service and `pg_dump`/`pg_restore` client tools updated to pg17 alongside. |
| 4 | No durable local-disk writes; everything goes through ObjectStorage | Done | `grep -rn "fs.writeFile\|fs.createWriteStream\|writeFileSync\|createWriteStream" services/api/src` (excluding tests) returns nothing. All durable file I/O goes through `services/api/src/modules/documents/object-storage.interface.ts` (`storage.service.ts`'s S3-compatible implementation, MinIO locally). |
| 5 | Queue, ObjectStorage, Cache, ModelProvider, NotificationProvider, BillingProvider, Connector interfaces | Done | All seven exist: `queue/queue-producer.interface.ts` (`QueueProducer`, DI token `QUEUE_PRODUCER` — every domain service that enqueues work injects the interface, not the concrete BullMQ class; only `worker-main.ts`, the composition root, touches the concrete class), `modules/documents/object-storage.interface.ts`, `cache/cache.interface.ts`, `modules/intelligence/model-provider.interface.ts` (real `AnthropicExtractionService` + a `fake-model-provider.ts` for tests), `modules/notifications/notification-provider.interface.ts` (`MailerService`/`EmailProvider` real via SMTP→Mailhog locally, `push.service.ts`/`PushProvider`), `modules/billing/billing-provider.interface.ts` (`StripeBillingProviderService`), `modules/connectors/connector.interface.ts` (`ConnectorAdapter`/`OAuthConnectorAdapter`, implemented by all 13 connector adapters — Gmail, Outlook, Google/Microsoft Calendar, Google/Microsoft Contacts, Google Drive/Tasks, OneDrive, Dropbox, Plaid, ICS). Each interface's doc comment cites §37 directly. |
| 6 | URLs, bucket names, regions, plan IDs, OAuth IDs environment-driven | Done | `services/api/src/config/env.ts` (194 lines, Zod-validated) externalizes every provider credential, Stripe price ID, S3 bucket/region/endpoint, app URL, and feature flag; production boot refuses to start with an insecure default secret (`PRODUCTION_REQUIRED_SECRETS` check in `loadEnv()`). Audited for anything that slipped through: the only hardcoded URLs found in `services/api/src` are fixed third-party API endpoints (Google/Microsoft/Dropbox/Apple/Plaid/NHTSA/CPSC base URLs) — correct to hardcode, since they don't vary per Veynlo environment; nothing environment-specific was found hardcoded. |
| 7 | Outbox/event abstraction instead of scattered EventBridge-style calls | Mostly done, one documented nuance | `notifications/notification-delivery.service.ts` is the single funnel for in-app/push/queued-email notifications (11 call sites across the app inject it, not lower-level providers directly). Two contained exceptions: `identity.service.ts` and `household.service.ts` call `MailerService` directly for auth-critical transactional email (password reset, email verification, household invite) — a deliberate choice for immediate-delivery auth flows, not scattering. No literal outbox table exists (domain writes and notification enqueue aren't in one transaction) — acceptable at current scale, tracked as a gap rather than silently accepted; see `docs/DECISIONS.md`'s SQS/EventBridge row. |
| 8 | infrastructure/terraform with reusable modules, dev/staging/prod composition | Done, never applied | `infrastructure/terraform/modules/` has seven modules (`alb`, `cache`, `database`, `ecs-cluster`, `ecs-service`, `networking`, `storage`), each wired into all three `environments/{dev,staging,prod}`. `modules/database` provisions Aurora PostgreSQL 17.7 Serverless v2 by name; `modules/cache` provisions ElastiCache Valkey Serverless; `modules/ecs-service` sets `cpu_architecture = "ARM64"`. No `terraform` binary exists in this environment to run `validate`/`plan` (not installed — see `infrastructure/terraform/README.md` for why not done unilaterally); never applied, no state, no AWS credentials used. **Not yet covered by a module**: SQS/EventBridge (consistent with the app still running BullMQ/Redis — see item 7), Cognito, KMS, ECR, API Gateway/Lambda, Route 53/ACM/CloudFront/WAF, RDS Proxy, GuardDuty/Security Hub/Inspector/Config/CloudTrail, AWS Backup, SES — all genuinely provisioning-time additions with no local code to shape yet. |
| 9 | docs/ARCHITECTURE.md, DEPLOYMENT.md, SECURITY.md, DR.md, IMPLEMENTATION_STATUS.md, DECISIONS.md | Done, one naming note | `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/DR.md`, `docs/DECISIONS.md` all exist. This file closes the one that didn't. **Naming note, not fixed**: the blueprint names `docs/SECURITY.md`; this repo has `SECURITY.md` at the **repo root** (extensively cross-referenced by `README.md`, CI, and every other doc — dozens of references) plus a separate `docs/SECURITY_CONTROLS.md` (an ASVS-scoped control matrix, a different document with a different purpose). Not blindly renamed/moved — the root `SECURITY.md` is load-bearing for too many existing references for a rename to be a safe use of an audit pass, and the two documents aren't duplicates of each other. Recorded here rather than left silently inconsistent. |
| 10 | Never commit production secrets or personal test data | Verified clean | `.gitignore` covers `.env`/`.env.local`/`.env.*.local` (excluding `.env.example`). `git log --all --oneline -- '*.env' '**/.env'` returns nothing — no `.env` file has ever been committed. CI's `gitleaks` job is blocking. **Correction (2026-09-03):** the "0 findings" previously claimed here was out of date — CI run `33785406080` on `b471046` failed `security-scan` with 7 findings. All 7 were reviewed individually and none is a live credential: four are AI model identifiers and local test-fixture passwords flagged on entropy, and three are a Playwright scratch state (`apps/web/.guide-scratch/`, a localhost session cookie plus a seeded demo account) committed once, since gitignored, but still present in commit `94ed6fe` because gitleaks scans full history. They are now allowlisted with per-entry justification in `.gitleaksignore`. The `.env` statement above still holds — no `.env` file has ever been committed. |

## A real bug found and fixed during this pass

`packages/authz` — an early, unused authorization-chokepoint package — had
already been deleted from the working tree by prior work (confirmed
intentional: `docs/PHASE2_PENDING_CREDENTIALS.md`'s "Resolved product
decisions" section records it as dead code, zero imports, superseded by
per-domain `ownerOrDelegatedHousehold`-style checks). The cleanup was
incomplete: `services/api/Dockerfile` still `COPY`'d
`packages/authz/package.json` (broke `docker build` outright) and
`.github/workflows/ci.yml`'s "Build shared packages" step still
`--filter`'d `@veynlo/authz` (would have broken the next CI run the same
way). Both fixed; the leftover `packages/authz/` directory (build artifacts
only, no source) removed; stale references in `README.md` and
`docs/ARCHITECTURE.md` that still described it as the live authorization
chokepoint corrected to describe the actual current pattern. Full detail in
`docs/DECISIONS.md`'s 2026-09-01 entry.

## What "production is a deployment step" actually means here, concretely

If a real AWS account existed today: `terraform apply` the existing modules,
push the already-CI-built ARM64 container images to ECR, point
`DATABASE_URL`/`S3_*`/`REDIS_URL`/every OAuth and billing credential in
`env.ts` at the real endpoints via Secrets Manager, run
`pnpm --filter @veynlo/db run migrate` against the real Aurora cluster, and
deploy. No domain-logic file would need to change to make that transition —
every provider boundary the app depends on (queue, object storage, cache,
model calls, notifications, billing, connectors) is already behind an
interface with a working local implementation, per the table above.

## What's genuinely blocked on real infrastructure, credentials, or money

Not attempted in this pass, and not attemptable without external access —
listed here so it isn't confused with something skipped:

- **Any AWS provisioning** — no AWS account/credentials exist in this
  environment. `terraform apply`, ECR pushes, and Control Tower/Organizations
  setup are all out of scope by design (see blueprint §36, which is entirely
  post-account work).
- **`terraform validate`** — no working `terraform` binary in this
  environment (installing one needs a system Command Line Tools upgrade
  judged too invasive to do unilaterally for this pass).
- **Cognito, RevenueCat mobile SDK, real Apple/Google store products, real
  Plaid/Dropbox production credentials** — each needs a real portal-created
  artifact (store account, paid partner agreement, or provisioned identity
  pool) a human has to create; every one of these has a finished interface,
  mock, and "not configured" UI state waiting to receive real values. See
  `docs/PHASE2_PENDING_CREDENTIALS.md` / `docs/PHASE3_PENDING_CREDENTIALS.md`
  for the complete, itemized list.
- **Independent pentest, IaC scanning (Checkov/tfsec), SBOM/provenance
  signing pipeline** — vendor/tooling decisions out of scope for local
  code changes; see `docs/DECISIONS.md`'s "Explicitly declined" section.

## Test/verification status as of this pass

- `pnpm --filter @veynlo/db run migrate` — clean against a fresh
  PostgreSQL 17 container.
- `pnpm --filter @veynlo/api run test` — 68 test files, 279 tests, all
  passing, run against PostgreSQL 17.
- `docker build --platform linux/arm64` — succeeded for both the `api` and
  `worker` Dockerfile targets; the `api` image live-verified against the
  full local `docker-compose` stack.
- `pnpm --filter @veynlo/api run typecheck` / `pnpm --filter @veynlo/db run
  typecheck` — both clean at multiple points during this pass. Note: this
  repository had other, unrelated work actively in progress concurrently
  during this session (observed directly — file modification timestamps and
  changing `tsc` output between consecutive, unmodified runs both confirmed
  it) touching `ingestion.service.ts`, `attention.service.ts`, and
  `worker-main.ts`; a `typecheck` snapshot taken at the very end of this
  session reflected that unrelated in-flight work, not anything changed as
  part of this §37 audit. None of the files this audit touched
  (`services/api/Dockerfile`, `infrastructure/docker/docker-compose.yml`,
  `.github/workflows/ci.yml`, and documentation) are implicated in those
  errors — re-run `pnpm --filter @veynlo/api run typecheck` once that other
  work settles to confirm.
