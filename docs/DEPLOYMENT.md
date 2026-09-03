# Deployment

This describes what actually runs today (local development) and the
intended path to a real AWS deployment (not yet executed — see
`docs/DECISIONS.md` for the full reconciliation against the architecture
blueprint). **No production deployment of Veynlo exists anywhere.**

## Local development (the only environment that exists today)

```
docker compose -f infrastructure/docker/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm db:seed        # optional — demo data
pnpm dev            # apps/web, apps/admin, services/api (turbo --parallel)
pnpm dev:worker     # services/api's worker process (separate terminal)
```

Docker Compose provisions Postgres 17 + pgvector, Redis, MinIO (S3-compatible),
Mailhog (SMTP capture), and ClamAV (malware scanning). Every one of these has
a real client in `services/api` (the AWS SDK's S3 client against MinIO,
`ioredis`/BullMQ against Redis, `pg`/Drizzle against Postgres, `nodemailer`
against Mailhog's SMTP port, ClamAV's own `INSTREAM` wire protocol) — nothing
here is mocked, only the endpoints are local.

`services/api/.env.example` documents every environment variable; copy it to
`.env` and fill in real values for anything beyond local dev. Optional
external dependencies (Google/Microsoft OAuth, Anthropic, Stripe,
RevenueCat, ClamAV, inbound email) are designed to degrade to a clear "not
configured on this deployment" state when unset, not to silently pretend to
work — see each controller's `*_NOT_CONFIGURED` error codes.

## Container images

`services/api/Dockerfile` builds two targets from one shared build stage —
`api` (the HTTP server, `dist/main.js`) and `worker` (the BullMQ worker
process, `dist/worker-main.js`) — because they're the same codebase with two
entrypoints (see `worker-main.ts`'s own doc comment on why). Build context
must be the repo root, not `services/api/`:

```
docker build -f services/api/Dockerfile --target api    -t veynlo-api    .
docker build -f services/api/Dockerfile --target worker -t veynlo-worker .
```

CI (`.github/workflows/ci.yml`'s `docker-build` job) builds both on every
push/PR and generates a CycloneDX SBOM for the API image, but does not push
to any registry — there is no ECR (or other registry) configured yet. The
image targets Linux/ARM64 per the blueprint (§10); the Dockerfile itself is
architecture-agnostic, so `docker buildx build --platform linux/arm64,linux/amd64`
produces both from the same source once a registry exists to push to.

## The intended AWS path (not yet executed)

`infrastructure/terraform/` already defines the target shape closely — Aurora
PostgreSQL 17.7 Serverless v2, ElastiCache Valkey Serverless, ECS Fargate on
ARM64, an ALB, and S3 storage, composed per-environment in `dev`/`staging`/
`prod`. See `infrastructure/terraform/README.md` for exactly what's validated
vs. applied (short version: written and structurally sound, never `apply`-ed
against a real AWS account, because no AWS account exists).

Bringing this from "written" to "deployed" needs, roughly in order:

1. An AWS account / Control Tower landing zone (blueprint §5) — a
   console-driven bootstrap, not something Terraform does from zero.
2. A Terraform remote state backend (S3 + DynamoDB lock, or Terraform Cloud)
   — no `backend` block is configured yet, deliberately, so `validate`/`fmt`
   work with zero AWS setup.
3. Real provider credentials for the connectors/AI/billing integrations
   this app already has code for (Google/Microsoft OAuth apps, an Anthropic
   key, Stripe + RevenueCat) — see `services/api/.env.example`.
4. `terraform plan`/`apply` against that account, using real AWS credentials.
5. Apply migrations against the freshly created Aurora cluster
   (`pnpm db:migrate` — the migration files themselves are already
   Aurora-PostgreSQL-compatible, no separate "production migration" exists).
6. Push the two container images to ECR; point the ECS services at the new
   digests.
7. Point `api.veynlo.com`/etc. (Route 53 + ACM, once the domain is owned and
   locked down) at the ALB.

None of this has been done. `docs/DECISIONS.md` covers *why* the application
code itself (Redis/BullMQ instead of SQS/EventBridge, custom auth instead of
Cognito, etc.) diverges from the blueprint's target stack in the meantime,
and what would actually need to change vs. what's just a config swap.

## Database migrations in a real deployment

Migrations are plain Drizzle-generated SQL files (`packages/db/src/migrations/`),
applied via `pnpm db:migrate` (`drizzle-orm/node-postgres/migrator`) — the
same command in every environment, pointed at a different `DATABASE_URL`.
The blueprint's expand/contract pattern for zero-downtime rolling deploys
(§25) is a discipline to follow when writing future migrations, not
something enforced by tooling here — review any migration that drops or
renames a column/table for backward-compatibility with the previous release
before it ships.

## Backup and restore

See `docs/DR.md`.
