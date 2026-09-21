import type { APIRequestContext, Page } from "@playwright/test";

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
/**
 * Waits out a 429 instead of failing on it.
 *
 * `POST /v1/auth/sign-up` is throttled at 20 per 60s per IP — deliberately, and correctly: its own comment
 * names "mass account creation" as the abuse pattern. Every spec here creates its own account through that
 * route, and the default suite makes **16** of those 20. That is 80% of the budget with no margin, so the
 * suite failed the moment anything nudged it over: a second run inside the same minute, a CI retry, or one
 * more spec. Observed directly — a back-to-back run failed nine specs, every one with
 * `POST /v1/auth/sign-up failed with 429`.
 *
 * The limiter is a real security control and is left exactly as strict. What changes is the fixture's
 * manners: a well-behaved client that is told "too many, wait" waits, rather than treating it as a fatal
 * error. Non-429 failures still throw immediately, so a genuine bug is never papered over by a retry.
 */
const THROTTLE_RETRIES = 4;
const THROTTLE_BACKOFF_MS = 20_000;

async function apiRequest(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await request.fetch(`${API_BASE_URL}${path}`, {
      method,
      data,
      headers: { "x-veynlo-csrf": "1" },
    });
    if (res.ok()) return res;

    const body = await res.text();
    const throttled = res.status() === 429;
    if (!throttled || attempt >= THROTTLE_RETRIES) {
      throw new Error(
        `${method} ${path} failed with ${res.status()}: ${body}` +
          (throttled ? ` (still throttled after ${THROTTLE_RETRIES} waits — the suite is creating accounts faster than the limit allows)` : ""),
      );
    }
    // The window is 60s; waiting a third of it per attempt clears a burst without stalling the run.
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_BACKOFF_MS));
  }
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

/**
 * Creates an account and leaves the BROWSER signed in, without driving the sign-in form.
 *
 * Most specs signed in through the UI purely as setup — they are about Documents, Connections, Settings,
 * not about the sign-in page. That cost one `POST /v1/auth/sign-in` each, and that route is throttled at
 * **10 per 60s per IP**, deliberately: its comment names credential guessing as the abuse pattern. The
 * default suite performed exactly **10** UI sign-ins and finished in about twelve seconds — sitting on
 * 100% of the limit, so any retry, any added spec, or any two runs inside a minute pushed it over and the
 * e2e job failed. Observed directly: a back-to-back run failed 8 specs.
 *
 * Sign-up already issues a session (`setSessionCookie` on the sign-up response), so there was never a need
 * to authenticate twice. Going through `page.request` puts that cookie in the browser's own jar —
 * Playwright shares cookie storage between `page` and `page.request` — so the page is signed in with no
 * second credential call. Verified before adopting it: sign-up 201, then `page.goto("/home")` stays on
 * /home rather than bouncing to /sign-in.
 *
 * The limiter is unchanged. What changed is that the suite stopped spending its budget on authentication it
 * had already done. `sign-in.spec.ts` still drives the real form, because that is the thing it tests.
 */
export async function createSignedInUser(page: Page, prefix?: string): Promise<TestUser> {
  const user = uniqueTestUser(prefix);
  const signUp = await page.request.post(`${API_BASE_URL}/v1/auth/sign-up`, {
    data: { email: user.email, password: user.password, displayName: user.displayName },
    headers: { "x-veynlo-csrf": "1" },
  });
  if (!signUp.ok()) throw new Error(`sign-up for ${prefix ?? "e2e"} failed with ${signUp.status()}: ${await signUp.text()}`);
  const skip = await page.request.post(`${API_BASE_URL}/v1/onboarding/skip`, { headers: { "x-veynlo-csrf": "1" } });
  if (!skip.ok()) throw new Error(`onboarding skip failed with ${skip.status()}: ${await skip.text()}`);
  return user;
}
