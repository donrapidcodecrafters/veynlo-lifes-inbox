import { defineConfig, devices } from "@playwright/test";

// Smoke suite, not cross-browser coverage — chromium only. Both servers are started here rather than
// assumed pre-running so `playwright test` works the same locally and in CI; `reuseExistingServer`
// lets local iteration reuse an already-running `pnpm dev` instead of restarting it.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  // Default 5s is too tight once 3 workers are hitting the same local API/web servers concurrently —
  // a real sign-in round trip (POST /v1/auth/sign-in, then the client-side redirect) can comfortably
  // exceed that under contention even though nothing is actually wrong.
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @veynlo/api run start",
      url: "http://localhost:4000/health/live",
      reuseExistingServer: !process.env.CI,
      cwd: "../..",
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @veynlo/web run start",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      cwd: "../..",
      timeout: 60_000,
    },
  ],
});
