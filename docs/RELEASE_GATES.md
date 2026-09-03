# Release gates

Spec chapter 50 ("QA, Accessibility Validation & Release Gates") lists the
test layers this app should have and the gates a release should pass. This
document is the single, authoritative checklist for the second half of
that — consolidating what's actually wired into
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) today, what's a
manual step nobody should skip, and what's an honest, still-open gap —
rather than leaving it scattered across CI step comments and
[`SECURITY.md`](../SECURITY.md)'s own pre-submission checklist.

Status reflects this repository as of 2026-09. As with `SECURITY.md`, this
is describing what's real, not an aspirational policy.

## What must pass before a release ships

| # | Gate | Enforced by | Blocking? |
|---|------|-------------|-----------|
| 1 | Typecheck (every package/app) | CI `build-and-test` job — `pnpm -r run typecheck` | Yes |
| 2 | Lint (backend packages + API; `apps/web` lint is still a no-op — see its `package.json`) | CI `build-and-test` job — `pnpm -r run lint` | Yes |
| 3 | Unit + integration tests, real Postgres (744+ tests across `services/api`/`packages/core`/`packages/db` as of this writing) | CI `build-and-test` job — `pnpm -r run test` | Yes |
| 4 | Database migration applies cleanly | CI `build-and-test` job — `pnpm db:migrate` | Yes |
| 5 | Backup/restore drill (dump → restore into a throwaway DB → row counts match) | CI `build-and-test` job — `pnpm db:restore-drill` | Yes |
| 6 | Every app/service actually builds (API, worker, web, admin) | CI `build-and-test` job | Yes |
| 7 | End-to-end browser journeys against the real built web app + API + Postgres | CI `e2e-tests` job — `apps/web/e2e/`, Playwright | Yes |
| 8 | Automated accessibility checks (axe-core, WCAG 2.0/2.1 A+AA) on sign-up, Home, and Settings | CI `e2e-tests` job — same Playwright run, `apps/web/e2e/support/a11y.ts` | Yes |
| 9 | Secret scan (gitleaks) | CI `security-scan` job | Yes |
| 10 | SAST (Semgrep — security-audit, secrets, OWASP Top Ten rulesets) | CI `security-scan` job | Yes |
| 11 | Docker images for the API and worker actually build | CI `docker-build` job | Yes |
| 12 | Dependency vulnerability scan (`pnpm audit`) | CI `build-and-test` job | No — informational (see the step's own comment in `ci.yml` for why) |
| 13 | Manual screen-reader/keyboard/dynamic-type pass on accessibility-critical journeys | Not automated — see below | Required before a real release, not enforced by CI |
| 14 | Household authorization suite (no unauthorized data through API, Home feed, search/Ask, timeline, notifications, exports, caches, or shares) | Covered by the real-Postgres integration suite (gate 3), not a separate gate | Yes, via gate 3 |
| 15 | Feature flag/kill switch exists for new high-risk connectors/models/automation actions/notification types | Reviewed per-PR, not CI-enforced (no generic way to detect "this PR added something high-risk") | Manual review |
| 16 | App-store privacy/data-safety declarations match actual behavior | Not applicable until a real store submission — see `SECURITY.md`'s pre-submission checklist | Required before store submission |

If a gate above is marked "No" or "Manual", that is the honest state today,
not a decision that it doesn't matter — see "Known gaps" below for what
closing each one actually takes.

## The E2E + accessibility gate (`e2e-tests` job)

Spec §50.1 calls for "critical journeys on iOS, Android, web, macOS,
Windows" and §50.2 requires "accessibility critical journeys pass automated
checks plus manual screen-reader/keyboard/dynamic-type testing." Before this
was added, neither existed anywhere in this repository: there was no
committed browser-driven test suite, and no `axe-core`/`jest-axe`/`pa11y` in
any `package.json` — this closes the web slice of that gap.

- **Suite**: `apps/web/e2e/` (Playwright, `apps/web/playwright.config.ts`).
  A deliberately small, high-value core — five specs covering sign-up →
  onboarding → Home, sign-in of an existing user, the Connections page
  load, "Add manually" capture landing in (or correctly not landing in) the
  Inbox, and Settings hub navigation — not an exhaustive tour of every
  screen. Setup for specs that don't specifically test sign-up/sign-in uses
  the real API directly (`apps/web/e2e/support/api.ts`) rather than
  re-driving the login UI in every spec; the behavior under test always
  goes through the real running app.
- **Accessibility**: `@axe-core/playwright`, WCAG 2.0/2.1 A+AA rule set
  (`apps/web/e2e/support/a11y.ts`), asserted on sign-up, Home, and Settings.
  This is the automated half of §50.2's accessibility gate — real, useful,
  and exactly the kind of check that would catch an accessibility-label
  sweep (mobile or web) that only looked complete without actually being
  tested. It is not a substitute for the manual half (see below).
- **CI**: the `e2e-tests` job in `ci.yml` builds the real API and web app
  (`pnpm --filter @veynlo/api run build`, `pnpm --filter @veynlo/web run
  build`), starts both against real Postgres + Redis service containers
  (mirroring `build-and-test`'s Postgres setup, the same way local dev's
  `docker compose` provisions them), waits for both to report healthy, then
  runs the Playwright suite against them. It is a normal, blocking CI job —
  no `continue-on-error`, same as every other job in this file.
- **Platform scope, honestly**: this suite covers **web only**. The mobile
  app (`apps/mobile`) has no automated E2E coverage in CI — driving a real
  iOS/Android journey needs a device or simulator/emulator harness this
  environment doesn't have (see the root `README.md`'s own notes on what
  mobile verification has and hasn't been done). A recent mobile
  accessibility-label sweep was verified by manual/interactive testing, not
  by an automated gate — closing that gap for real means either a
  simulator-based CI lane (e.g. `expo start --web` under Playwright, which
  the root README already documents as having been used for one-off manual
  verification) or a real device farm; neither exists today. Desktop
  (macOS/Windows) and the browser extension are likewise not covered by any
  CI gate yet, despite having been verified manually at least once each
  (see `README.md`).
- **Running it locally**:
  ```bash
  pnpm dev            # services/api + apps/web
  pnpm --filter @veynlo/web exec playwright install chromium   # once
  pnpm --filter @veynlo/web run test:e2e
  ```
  `E2E_WEB_URL`/`E2E_API_URL` override the defaults
  (`http://localhost:3000`/`:4000`) if your dev stack runs elsewhere.

## Known gaps (spec chapter 50 vs. what's actually built)

Being direct about what §50.1's full test-layer list would need beyond what
exists today, so this document doesn't quietly imply more coverage than is
real:

- **Connector contract tests** (fixtures/sandboxes for provider pagination,
  cursor, webhook duplication, rate limits, token expiry) — the Gmail/
  Outlook connectors have real integration tests against mocked provider
  responses, not a dedicated sandbox/fixture harness per §50.1's framing.
- **AI replay/eval corpus** (versioned corpus with expected extraction/
  confidence, adversarial prompt injection, locale/date ambiguity) —
  `FakeModelProvider`-backed tests exist per-feature (see
  `services/api/src/modules/intelligence/fake-model-provider.ts` and its
  callers), but there's no single versioned eval corpus run as its own gate.
- **E2E on iOS/Android/macOS/Windows** — see "Platform scope" above.
- **Offline/network gate** (airplane mode, intermittent network, stale
  device, session revoke under bad connectivity) — not automated anywhere.
- **Load/resilience gate** (webhook burst, backfill, digest fan-out, Ask
  spikes, provider outage, DB/search failover) — not automated anywhere.
- **Billing gate** (trial/purchase/restore/upgrade/downgrade/cancel/grace/
  refund, out-of-order and double-store conflicts) — covered by real
  integration tests against Stripe's API shape, not a dedicated
  store-event-ordering gate.
- **Manual accessibility pass** (§50.2: "automated checks *plus* manual
  screen-reader/keyboard/dynamic-type testing") — the automated half now
  exists (this document's E2E section); the manual half is a real,
  separate pre-release step for a human to actually run, not something CI
  can currently claim to cover.
- **Critical-fact precision/confidence calibration against a domain
  threshold** — extraction confidence bands exist in the data model and are
  surfaced in the UI (Inbox, Home), but no CI gate measures precision
  against a numeric threshold on a held-out set.

None of the above block CI today because none of them exist as automated
checks yet — they're listed here so "what's a real gate" and "what's still
a manual or missing step" stay honestly distinguishable, matching this
repo's existing rule (see `README.md`'s "What's real vs. what's a stub")
that nothing pretends to be finished when it isn't.
