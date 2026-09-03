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
system is put together. See
[docs/DEV_ENVIRONMENT_MIGRATION.md](docs/DEV_ENVIRONMENT_MIGRATION.md) for
splitting development across two machines (a tower for everything, a Mac kept
only for Xcode/iOS Simulator testing). See [SECURITY.md](SECURITY.md) for data protection
(field-level encryption, key rotation), account deletion, network hardening,
and an honest pre-submission checklist for the App Store/Play Store/a real
pentest.

## Quick start

Prerequisites: Node 20+, pnpm 10+, Docker.

```bash
pnpm install

# Build the shared workspace packages (@veynlo/core, @veynlo/db, ...) before anything else —
# every app/service resolves them via their package.json "main"/"exports", which point at
# ./dist, and that doesn't exist until this runs. Skipping this makes typecheck fail with
# TS2307 "Cannot find module '@veynlo/core'" and vitest fail with "Failed to resolve entry
# for package @veynlo/core" — platform-independent, hits a fresh clone on any OS identically.
pnpm --filter "./packages/*" run build

# Start local infra (Postgres+pgvector, Redis, MinIO, Mailhog — Mailhog catches all
# outbound email in dev at http://localhost:8025, no real SMTP provider needed)
cd infrastructure/docker && docker compose up -d && cd ../..

# Create the MinIO bucket the API expects (first time only). Uses the compose network + the
# "minio" service's own DNS name rather than --network host — host networking doesn't behave
# the same on Windows/macOS Docker Desktop as it does on Linux, so this form is the one that
# actually works identically on all three.
docker run --rm --network veynlo_default --entrypoint sh minio/mc:latest -c \
  "mc alias set local http://minio:9000 veynlo veynlo_dev_password && mc mb -p local/veynlo-documents"

# Apply migrations and load realistic demo data
pnpm db:migrate
pnpm db:seed

# Configure the API (copy and edit — every value has a safe local default
# except secrets, which you should set explicitly even locally)
cp services/api/.env.example services/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/admin/.env.example apps/admin/.env.local

# Create your own admin console account (there's no self-serve admin sign-up by design)
pnpm --filter @veynlo/api run create-admin -- --email you@veynlo.app --role superadmin

# Run everything
pnpm dev
```

- API: http://localhost:4000
- Web: http://localhost:3000
- Admin console: http://localhost:3100 (sign in with the account you just created)
- MinIO console: http://localhost:9001 (veynlo / veynlo_dev_password)
- Mailhog (captured outbound email in dev): http://localhost:8025

Postgres is published on **5433**, not 5432 — many dev machines already run
a local Postgres on 5432, and this avoids fighting it for the port.

To run the mobile app (not part of `pnpm dev` — Expo has its own dev
server/QR flow):

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
cd apps/mobile
npx expo start        # then press i (iOS Simulator), a (Android emulator), or w (web preview)
```

## What's real vs. what's a stub

Per the project's guiding rule, nothing pretends to be functional when it
isn't:

- **Real and working end-to-end**: email/password auth with revocable
  sessions, household + dependent management, the Gmail and Outlook
  connectors (real OAuth + Gmail API / Microsoft Graph API, cleanly gated
  behind config, both sharing one ingestion pipeline), the ingestion
  pipeline (deterministic prefilter → Claude-based structured extraction →
  canonical facts/purchases/bills/events → Inbox review) with real
  incremental sync for both providers (a recurring worker tick drives
  Gmail's `history.list` and Outlook's delta query off a stored cursor,
  not just a one-time backfill), document upload to
  S3-compatible storage with real Claude-vision OCR for images and real
  PDF OCR via Anthropic's beta document-input surface, structured
  search + grounded Ask, Stripe billing/entitlements, a background worker
  process (BullMQ + Redis) that runs connector sync and notification
  delivery durably instead of inline on an HTTP request — including real
  SMTP email delivery (Mailhog in dev) for the daily/weekly brief and
  per-discovery notifications, with quiet-hours/intensity suppression — and
  the whole web app (Home, Inbox, Ask, Life, Connections, Settings) talking
  to the real API, and a separate internal admin console (its own app,
  its own operator-account identity plane, audited support lookups, and a
  merchant data-quality tool for merging/undoing duplicate merchant
  records with full lineage).
- **Present but requires configuration to activate**: the Gmail connector
  (needs `GOOGLE_OAUTH_CLIENT_ID/SECRET`), the Outlook connector (needs
  `MICROSOFT_OAUTH_CLIENT_ID/SECRET`), AI extraction and PDF/image OCR
  (need `ANTHROPIC_API_KEY` — without it, ingestion degrades gracefully to
  deterministic-only and marks messages "filed" rather than fabricating
  results, and document uploads skip OCR rather than crash), Stripe
  billing (needs `STRIPE_SECRET_KEY`/webhook secret).
- **Explicitly not built yet** (see docs/ROADMAP.md for the full list):
  a signed/notarized desktop build and a Windows build (only an unsigned
  macOS/arm64 build has been produced here), admin account management UI
  (accounts are created via a CLI script), most of Phase 2+ domains
  (home/vehicle/travel/family/school/etc.).

The mobile app (`apps/mobile`, Expo + expo-router) has full screen parity
with web — Home, Inbox, Ask, Life, Settings, Timeline, Documents,
Connections — talking to the real API over a bearer-token session (native
has no browser cookie jar; see docs/ARCHITECTURE.md's auth section). Real
native builds have been produced and verified on both platforms:
`expo run:ios` on a real iPhone 16 Pro Simulator and `expo run:android`
on a real Android emulator (API 36) — see docs/ARCHITECTURE.md's "Native
mobile build" section for the three genuine upstream Expo/Xcode-26 bugs
it took to get both working, all fixed via `pnpm patch`. Every screen and
nav path was also verified interactively via Playwright against
`expo start --web` (a real Chromium instance driving the actual React
Native codebase). Real device builds (only simulator/emulator so far)
are next.

The browser extension (`apps/browser-extension`, Manifest V3, any
Chromium-based browser) saves the current page or a text selection to your
Veynlo inbox via the toolbar popup or a right-click menu, using the same
bearer-token auth transport as mobile. See its own README for how to load
it unpacked. Verified live via a Playwright-driven real Chromium instance
with the extension actually loaded, against the real API.

The desktop app (`apps/desktop`, Tauri 2, macOS/Windows/Linux) is a native
window around the real web app — no separate frontend. Requires a Rust
toolchain (`rustup.rs`) to build. Verified live in this environment: both
`tauri dev` and a real `tauri build` (unsigned `.app` + `.dmg`) completed
successfully; production use needs real code signing and the window
pointed at a deployed web origin instead of localhost. See its own README.

## Internationalization (i18n)

§38.2 of the spec requires all user-facing strings to be externalized (no hardcoded copy, no
concatenated grammar) and locale-aware date/time/currency formatting. Before this pass, no i18n
library existed anywhere in this repo and every UI string was a hardcoded English literal, even
though `users.locale` (`packages/db/src/schema/identity.ts`) has been stored per-user since the
first migration. What's built now is the real *architecture* the spec's §53.1 extension standard
demands — English is the only shipped language, but adding a second one is a translation-file
change, not a re-architecture:

- **`packages/core/src/util/locale.ts`** is the canonical, platform-shared source of truth:
  `SUPPORTED_UI_LOCALES` (today: `["en"]`), and two resolvers — `resolveUiLocale()` (which
  translated message bundle to load) and `resolveFormattingLocale()` (which full BCP-47 tag to
  hand `Intl.NumberFormat`/`DateTimeFormat`, kept regionally precise even when the UI bundle
  doesn't change). Read that file's header comment for the full fallback-chain design.
- **`apps/web`** uses `next-intl` (`src/i18n/provider.tsx` + `src/i18n/messages/en.json`), wired
  into the root layout. **`apps/admin`** uses the same library the same way (`src/i18n/`), except
  it only resolves device/browser locale — there is no per-admin locale preference to route
  through (`admins` is a separate table from `users`, see that provider's own doc comment).
  **`apps/mobile`** uses `i18next`/`react-i18next` (`src/lib/i18n/`, `src/lib/i18n-provider.tsx`).
- **Where the locale comes from**: a signed-in user's stored `users.locale` preference once the
  session loads (routed through `apps/web`'s `useSession()` / `apps/mobile`'s `useAuth()`
  `SessionUser.locale`), falling back to the device/browser locale pre-auth or on `apps/admin`,
  falling back to English/`en-US` if neither resolves to a shipped locale.
- **Adding a new locale**: add its base language tag to `SUPPORTED_UI_LOCALES`, drop a translated
  `messages/<locale>.json` (web/admin) or `lib/i18n/<locale>.json` (mobile) file with the exact
  same keys as `en.json`, and register it in that app's message loader. Nothing else — the
  fallback chain, provider wiring, and every `t("...")` call site — needs to change.
- **Adding a new translatable string**: add the key to the relevant `en.json`/message file
  (namespaced by feature, e.g. `home.title`, `settings.deleteAccount.cta`) and call
  `useTranslations("home")` (web/admin) or `useTranslation("translation", { keyPrefix: "home" })`
  (mobile) in the component instead of hardcoding the literal. A count-dependent string uses ICU
  plural syntax (`next-intl`) or i18next's `_one`/`_other` key suffixes (mobile) — never
  concatenated singular/plural fragments (see `apps/web/src/app/(app)/home/page.tsx`'s
  `degradedBanner` key for a worked example of both the bug this avoids and the fix).
- **What's covered vs. not**: this pass extracted a representative slice proving the pattern
  end-to-end — navigation/tab labels, the Home dashboard, the Settings page's header/top
  sections/sign-out/delete-account, sign-in/sign-up, and one domain list page per platform (Inbox)
  — not literally every string in the app, which would be enormous effort for zero user-visible
  benefit while English is the only shipped locale. Untranslated strings are plain literals, same
  as before this pass; extending coverage is the same `t("<namespace>.<key>")` pattern already
  used throughout.
- **What this pass deliberately did NOT do**: translate any string into a non-English language.
  Real translation needs either a paid translation vendor or substantial human review to be
  trustworthy for a life-admin app (a wrong machine-translated date/legal/financial string is
  worse than no translation) — that's a deferred, cost-gated follow-up, not something fabricated
  here. `SUPPORTED_UI_LOCALES` lists only `"en"` until that follow-up happens.

## Workspace layout

```
apps/
  web/                Next.js consumer web app
  admin/               Next.js internal support console (separate app, separate auth)
  mobile/              Expo (React Native) consumer app — iOS/Android, shares design tokens with web
  browser-extension/  Manifest V3 extension (Chromium-based browsers) — save pages/selections to Veynlo
services/
  api/                NestJS/Fastify API — the whole backend for now
packages/
  core/               Shared domain types, zod schemas, entitlement/plan catalog
  db/                 Drizzle ORM schema, migrations, seed data
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
pnpm lint         # lint backend packages (core/db/api) with the shared root ESLint config;
                  # apps/web is still a no-op pending a Next-aware config
pnpm test         # run all test suites
pnpm db:generate  # generate a new migration from schema changes
pnpm db:migrate   # apply migrations
pnpm db:seed      # (re)load demo data
pnpm db:studio    # Drizzle Studio — browse the local database
```
