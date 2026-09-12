import { defineConfig, devices } from "@playwright/test";

/**
 * §50.1 "E2E platform: critical journeys on iOS, Android, web, macOS, Windows" — this config covers the
 * web slice of that requirement with real browser automation (Chromium via Playwright) against the real
 * running app (Next.js) and real running API/Postgres, never mocked network calls. See docs/RELEASE_GATES.md
 * for how this suite fits into the overall set of things that must pass before a release ships, and
 * .github/workflows/ci.yml's `e2e-tests` job for how it's run as a real, blocking gate in CI.
 *
 * This config deliberately does NOT try to start apps/web or services/api itself (no `webServer` block):
 * the full stack (Postgres/Redis, the API, and the web app) has several real external dependencies
 * (see infrastructure/docker/docker-compose.yml) that a single `webServer` command can't stand up cleanly,
 * and the CI job below already needs its own multi-step startup sequence anyway. Instead:
 *   - Locally: run `pnpm dev` (API + web) in one terminal, then `pnpm --filter @veynlo/web run test:e2e`
 *     in another, against whatever `E2E_WEB_URL`/`E2E_API_URL` you point it at (defaults below assume the
 *     standard `pnpm dev` ports from the root README).
 *   - In CI: the `e2e-tests` job builds and starts both processes itself, waits for them to be healthy,
 *     then runs this same config unchanged.
 */
const WEB_BASE_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // The zz-* specs are audit tooling, not product tests: they drive the SEEDED demo account
  // (alex@example.com, created by `pnpm db:seed`), write several hundred screenshots into
  // .claude/audit-screenshots, and reset database rows directly. CI neither seeds that account nor wants
  // that output, so they are excluded from the default suite and run explicitly on the machine doing the
  // audit:  npx playwright test e2e/zz-<name>.spec.ts
  // Opt-in rather than a flat exclude: a flat `testIgnore` also blocked running them explicitly by
  // filename on the audit machine, which defeats the point of keeping them. Run with AUDIT=1.
  testIgnore: process.env.AUDIT ? [] : "**/zz-*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Two workers EVERYWHERE, not just in CI. The suite shares one API process and one database across
  // specs (each spec creates its own user, but they still compete for the same Postgres connection pool
  // and Node event loop), and — the part that actually bites — POST /v1/auth/sign-in is deliberately
  // throttled to 10 requests per 60s per IP to stop credential guessing. Every spec signs in from
  // 127.0.0.1, so an unbounded local worker pool fires the whole suite's sign-ins inside about two
  // seconds and the API correctly answers 429. That presented as five unrelated product failures: five
  // specs stranded on /sign-in, each failing its assertion that the URL ends in /home.
  //
  // Measured on the Windows tower: default workers -> 5 of 10 specs failed, every one of them on a 429;
  // --workers=2 -> 10 of 10 passed. CI was always green only because two workers already spread the same
  // sign-ins past the throttle window.
  //
  // Capping concurrency is the fix rather than raising the throttle: that limit is a real security
  // control (see the @Throttle on IdentityController#signIn), this suite is not testing burst sign-in
  // behaviour, and weakening a security boundary to make tests go green is precisely what must not happen.
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
