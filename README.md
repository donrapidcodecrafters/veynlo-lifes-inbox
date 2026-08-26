# Veynlo

Veynlo is the connective intelligence layer across your permitted digital
life — it connects to the places life already happens (email, calendars,
documents, receipts), turns unstructured signals into verified structured
knowledge, and proactively surfaces what matters, with full evidence and
provenance behind every claim.

This repository implements the product described in
[`spec/Life_Inbox_Master_Spec.txt`](spec/Life_Inbox_Master_Spec.txt) (the
original master specification; the product is branded **Veynlo** — see
[docs/BRANDING.md](docs/BRANDING.md) for how the rename was applied and how
to change it again later).

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's built, what's stubbed, and
what's next. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the
system is put together.

## Quick start

Prerequisites: Node 20+, pnpm 10+, Docker.

```bash
pnpm install

# Start local infra (Postgres+pgvector, Redis, MinIO, Mailhog — Mailhog catches all
# outbound email in dev at http://localhost:8025, no real SMTP provider needed)
cd infrastructure/docker && docker compose up -d && cd ../..

# Create the MinIO bucket the API expects (first time only)
docker run --rm --network host --entrypoint sh minio/mc:latest -c \
  "mc alias set local http://localhost:9000 veynlo veynlo_dev_password && mc mb -p local/veynlo-documents"

# Apply migrations and load realistic demo data
pnpm db:migrate
pnpm db:seed

# Configure the API (copy and edit — every value has a safe local default
# except secrets, which you should set explicitly even locally)
cp services/api/.env.example services/api/.env
cp apps/web/.env.example apps/web/.env.local

# Run everything
pnpm dev
```

- API: http://localhost:4000
- Web: http://localhost:3000
- MinIO console: http://localhost:9001 (veynlo / veynlo_dev_password)
- Mailhog (captured outbound email in dev): http://localhost:8025

Postgres is published on **5433**, not 5432 — many dev machines already run
a local Postgres on 5432, and this avoids fighting it for the port.

## What's real vs. what's a stub

Per the project's guiding rule, nothing pretends to be functional when it
isn't:

- **Real and working end-to-end**: email/password auth with revocable
  sessions, household + dependent management, the Gmail connector (real
  OAuth + Gmail API, cleanly gated behind config), the ingestion pipeline
  (deterministic prefilter → Claude-based structured extraction → canonical
  facts/purchases/bills/events → Inbox review), document upload to
  S3-compatible storage with real Claude-vision OCR for images, structured
  search + grounded Ask, Stripe billing/entitlements, a background worker
  process (BullMQ + Redis) that runs connector sync and notification
  delivery durably instead of inline on an HTTP request — including real
  SMTP email delivery (Mailhog in dev) for the daily/weekly brief and
  per-discovery notifications, with quiet-hours/intensity suppression — and
  the whole web app (Home, Inbox, Ask, Life, Connections, Settings) talking
  to the real API.
- **Present but requires configuration to activate**: Gmail connector
  (needs `GOOGLE_OAUTH_CLIENT_ID/SECRET`), AI extraction (needs
  `ANTHROPIC_API_KEY` — without it, ingestion degrades gracefully to
  deterministic-only and marks messages "filed" rather than fabricating
  results), Stripe billing (needs `STRIPE_SECRET_KEY`/webhook secret).
- **Explicitly not built yet** (see docs/ROADMAP.md for the full list):
  PDF OCR (needs Anthropic's beta PDF/document input surface), mobile app
  (iOS/Android), desktop app, browser extension, admin RBAC (currently a
  single shared-secret header — fine for local dev, not for production),
  most of Phase 2+ domains (home/vehicle/travel/family/school/etc.).

## Workspace layout

```
apps/
  web/                Next.js consumer web app
services/
  api/                NestJS/Fastify API — the whole backend for now
packages/
  core/               Shared domain types, zod schemas, entitlement/plan catalog
  db/                 Drizzle ORM schema, migrations, seed data
  authz/               Central authorization policy (used by every read/write path)
  design-tokens/       Design system tokens (color/type/spacing/motion), light+dark
infrastructure/
  docker/              docker-compose for local Postgres/Redis/MinIO/Mailhog
spec/                  The original master product/technical specification
docs/                  Architecture, roadmap, environment variable reference
```

Connector sync (Gmail backfill) and notification delivery (daily/weekly
brief, per-item email) run in a **separate worker process** — it does not
start with `pnpm dev`. Run it alongside the API in another terminal:

```bash
pnpm dev:worker
```

## Common commands

```bash
pnpm build        # build every package/app
pnpm dev          # run every app/service in dev/watch mode (API + web; NOT the worker — see above)
pnpm dev:worker   # run the background job worker (connector sync, notification delivery)
pnpm typecheck    # typecheck the whole workspace
pnpm test         # run all test suites
pnpm db:generate  # generate a new migration from schema changes
pnpm db:migrate   # apply migrations
pnpm db:seed      # (re)load demo data
pnpm db:studio    # Drizzle Studio — browse the local database
```
