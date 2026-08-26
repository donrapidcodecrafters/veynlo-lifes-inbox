# Architecture

This follows the master spec's recommended architecture (§41-45) unless
noted otherwise. It's a strongly modular monolith today, not microservices —
module boundaries are enforced by convention (separate NestJS modules with
narrow exports) so pieces can be split into separate services later without
a rewrite, per the spec's explicit guidance to avoid premature service
sprawl.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Shared types across API/web without publishing packages |
| Web | Next.js 15 (App Router) + Tailwind v4 | Fast to build a genuinely polished UI; Tailwind v4's `@theme` maps directly onto our CSS-variable design tokens |
| API | NestJS 11 + Fastify | Module system matches the spec's bounded-context list (Appendix I) directly; Fastify for throughput |
| Database | PostgreSQL 16 + pgvector | Single source of truth; vector search colocated rather than a separate service until scale demands it |
| ORM | Drizzle | SQL-first migrations (reviewable, source-controlled), native-enough pgvector support via a small custom column type |
| Object storage | S3-compatible (MinIO locally) | Documents/receipts/scans — never a public URL, always short-lived signed URLs |
| Jobs/queues | Redis + BullMQ | Connector sync and notification dispatch/delivery run as durable, retrying jobs — never inline on an HTTP request |
| Email | Nodemailer over SMTP (Mailhog in dev) | Daily/weekly briefs and per-item notifications actually send; no fake "would send" logging |
| AI | Anthropic (`@anthropic-ai/sdk`) | Structured extraction via forced tool-use against a zod schema; Haiku for cheap/routine extraction, Sonnet for Ask synthesis |
| Billing | Stripe | Entitlement ledger normalizes across billing sources per spec §46 |

## Module boundaries (`services/api/src/modules/*`)

Mirrors spec Appendix I:

- **identity** — auth, sessions, devices. Owns nothing about life-domain content.
- **household** — membership, dependents, invitations.
- **connectors** — provider credentials, OAuth, sync orchestration. Never touches domain meaning.
- **ingestion** — turns a raw source event into domain candidates. This is the pipeline (see below).
- **intelligence** — the only place that calls the Anthropic API. Schema-constrained, versioned, cost-tiered.
- **commerce / schedule / documents** — domain read/write APIs (purchases, returns, subscriptions, bills, calendar events, tasks, document vault).
- **attention** — the Home "Needs You" queue and the Inbox review surface.
- **notifications** — preferences, daily/weekly brief composition, quiet-hours/intensity suppression, and real SMTP delivery. Push/desktop channels aren't wired (no client to receive them yet).
- **automation** — types/schema exist in `@veynlo/core`; no rule engine or execution yet (ROADMAP).
- **search** — structured SQL search + grounded Ask (semantic/vector search not yet wired — search_documents table + pgvector column exist, embeddings pipeline doesn't yet).
- **billing** — Stripe checkout + webhook, entitlement resolution.
- **admin** — metadata-only support console, gated by a shared-secret header (real RBAC is a known gap, see ROADMAP).

`packages/authz` is the one authorization chokepoint every module is
expected to call before returning or mutating another principal's data —
see its own tests (`packages/authz/src/policy.test.ts`) run against a real
Postgres instance, not a mock.

## The ingestion pipeline (§39.1)

```
SourceEvent (raw, idempotent)
  → deterministic prefilter + relevance gate   (packages: intelligence/deterministic-prefilter.ts)
  → domain classification                       (AI, schema-constrained — or skipped if unconfigured)
  → structured extraction                        (AI, schema-constrained; dates/amounts are `null`, never guessed)
  → entity resolution                            (merchant-by-name for MVP; full entity-resolution graph is a ROADMAP item)
  → canonical persistence + InboxItem creation    (commerce/schedule schema)
```

Every extraction is versioned (`extractorName`), schema-validated before it
can touch canonical tables, and produces a review item in the Inbox rather
than silently mutating state — confirming an Inbox item is what promotes a
candidate to `confidenceBand: "verified"`. Filing an Inbox item at
high/verified confidence also creates a `"useful"`-priority notification
(dedupe key `inbox-item:<id>`) — low/needs-review candidates stay silent in
the Inbox rather than paging the user about something Veynlo itself isn't
sure of.

## Background jobs and the worker process

`services/api` has two entry points compiled from the same codebase:

- `src/main.ts` — the HTTP server (Fastify).
- `src/worker-main.ts` — a headless process (`NestFactory.createApplicationContext`,
  no HTTP listener) that runs three BullMQ workers: `connector-sync`,
  `notification-dispatch`, `notification-delivery`. It resolves the exact
  same providers (`GmailAdapter`, `NotificationDeliveryService`, etc.) via
  Nest's DI container, so job-processing logic is never duplicated between
  the HTTP and worker codepaths.

Both processes must run for the product to work end-to-end in dev
(`pnpm dev` for HTTP + web, `pnpm dev:worker` for the worker) — an OAuth
callback or a filed Inbox item enqueues a job and returns immediately; the
job only actually runs once the worker process picks it up.

Job flow, concretely:

```
Gmail OAuth callback → enqueue connector-sync(kind: "initial")
  → [worker] GmailAdapter.initialSync() → ingestion pipeline → InboxItem
    → (if high/verified confidence) NotificationDeliveryService.createAndEnqueue()
      → enqueue notification-delivery
        → [worker] checks quiet hours/intensity → sends via Nodemailer → notifications.state = "sent"

Recurring cron (13:00 UTC daily / Monday) → notification-dispatch(daily|weekly)
  → [worker] NotificationDispatchService composes one digest per eligible user
    → same notification-delivery path as above
```

Every job is retried with exponential backoff on failure (BullMQ `attempts`/
`backoff`), deduplicated by `jobId` where re-enqueuing the same logical work
item should be a no-op, and safe to reprocess — `connector-sync` relies on
`source_events.idempotency_key`, `notification-delivery` checks
`notifications.state !== "queued"` before sending.

**Deviation from the spec's literal repo layout**: §41.3 suggests a separate
`/services/workers` app. This repo keeps one codebase with two bootstrap
entry points instead, specifically to avoid duplicating GmailAdapter/
IngestionService/NotificationDeliveryService logic across two packages.
Revisit if the worker ever needs to scale or deploy on a genuinely different
release cadence than the API.

## Data model

`packages/db/src/schema/*` is the single source of truth; `packages/core`
holds the equivalent zod types for use in application code (API responses,
validation) — they're deliberately not the same objects, since DB rows use
`Date` and zod-validated entities use ISO strings; `@veynlo/core`'s
`resolveCapability` and similar functions accept either.

Key tables: `users`/`households`/`household_memberships` (identity+household),
`connections`/`connection_credentials` (encrypted OAuth tokens, separate table
per §45.1), `source_events`/`facts`/`canonical_entities`/`relationships`
(the provenance/knowledge-graph layer), `purchases`/`return_cases`/`shipments`/
`recurring_streams`/`subscriptions`/`bills` (commerce), `calendar_events`/`tasks`
(schedule), `documents`/`document_versions` (vault), `inbox_items`/`attention_items`/
`notifications` (attention layer), `entitlements`/`billing_events` (billing).

Money is always `{ minorUnits: integer, currency: string }` — never a float.
Dates that aren't fully certain use `TemporalValue` (`packages/core/src/util/time.ts`):
an explicit `precision` field (`instant | date | month | approximate | unknown`)
so "we don't know" is representable and never silently upgraded to a fake
certainty.

## Authorization model

`resolveAccess(db, principalUserId, resource)` in `packages/authz` is the
only function that should ever decide whether a principal can see a row
that isn't their own. It checks, in order: ownership → household
membership (only for `visibility: "household"` resources) → explicit
resource grants. `shared_link` visibility is a separate token-based path
(`resolveShareLinkAccess`). This is deny-by-default: if none of those
match, access is denied.

## What's deliberately not built yet

See `docs/ROADMAP.md` for the full, prioritized list. The short version:
workers/queues for background sync (connectors currently sync inline on
connect), PDF OCR, entity-resolution/merge-lineage beyond simple
merchant-name matching, notification delivery (push/email — preferences
and history exist, sending doesn't), automation rule execution, mobile/
desktop/browser-extension clients, and real admin RBAC.
