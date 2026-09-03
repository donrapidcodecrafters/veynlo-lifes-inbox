import type { APIRequestContext } from "@playwright/test";

/**
 * Same default the app itself uses (see src/lib/api-client.ts) — overridable so CI (or a developer
 * pointing this suite at a non-default port) can run against a different API instance.
 */
export const API_BASE_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

export interface TestUser {
  email: string;
  password: string;
  displayName: string;
}

let sequence = 0;

/** A fresh, collision-free identity for every test run — never reuses seed data or another spec's user. */
export function uniqueTestUser(prefix = "e2e"): TestUser {
  sequence += 1;
  const stamp = `${Date.now()}-${process.pid}-${sequence}`;
  return {
    email: `${prefix}-${stamp}@example.com`.toLowerCase(),
    password: "Correct-Horse-Battery-Staple-9",
    displayName: `Playwright ${prefix}`,
  };
}

/**
 * `POST`/`PUT`/etc. through Playwright's API request context need the same `x-veynlo-csrf` header the
 * real web app's fetch wrapper always sends (see src/lib/api-client.ts and services/api/src/common/
 * csrf.ts) — without it, any state-changing call made *after* a session cookie already exists (e.g.
 * onboarding-skip right after sign-up) is rejected with CSRF_CHECK_FAILED.
 */
async function apiRequest(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown) {
  const res = await request.fetch(`${API_BASE_URL}${path}`, {
    method,
    data,
    headers: { "x-veynlo-csrf": "1" },
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`${method} ${path} failed with ${res.status()}: ${body}`);
  }
  return res;
}

/**
 * Creates a brand-new account directly against the real API and immediately skips onboarding, giving each
 * spec a ready-to-use "existing, already-onboarded user" without re-driving the sign-up/onboarding UI in
 * every test that isn't specifically about those flows. Uses `request` fixture that's bound to the same
 * browser context as `page` (Playwright shares cookie storage between the two), so the session cookie the
 * sign-up response sets is picked up automatically by any `page.goto()` that follows.
 *
 * This mirrors the app's own real HTTP contract (POST /v1/auth/sign-up, POST /v1/onboarding/skip) rather
 * than seeding the database directly — same "exercise the real backend, not a shortcut" discipline as the
 * project's existing Postgres-backed integration tests.
 */
export async function createOnboardedUser(request: APIRequestContext, prefix?: string): Promise<TestUser> {
  const user = uniqueTestUser(prefix);
  await apiRequest(request, "POST", "/v1/auth/sign-up", {
    email: user.email,
    password: user.password,
    displayName: user.displayName,
    timezone: "America/New_York",
  });
  await apiRequest(request, "POST", "/v1/onboarding/skip");
  return user;
}

/**
 * §onboarding "aiConfigured" — true only when `ANTHROPIC_API_KEY` is set on the API process (see
 * OnboardingService/README's "what's real vs. what's a stub"). Manual-capture E2E coverage needs this:
 * without a configured model provider, the deterministic-only pipeline intentionally never produces a
 * visible Inbox card (it marks the source event "filed" and stops — see ingestion.ai-kill-switch.test.ts
 * in services/api for the same behavior proven at the integration level), so the spec asserts a different,
 * still-real outcome depending on which mode this environment is running in, rather than assuming AI is
 * always configured (it isn't in CI today) or silently skipping the check.
 */
export async function isAiConfigured(request: APIRequestContext): Promise<boolean> {
  const res = await request.fetch(`${API_BASE_URL}/v1/onboarding/state`, { headers: { "x-veynlo-csrf": "1" } });
  if (!res.ok()) return false;
  const body = (await res.json()) as { aiConfigured?: boolean };
  return Boolean(body.aiConfigured);
}
