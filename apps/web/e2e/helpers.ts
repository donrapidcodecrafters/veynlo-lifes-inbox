import { expect, type Page } from "@playwright/test";

export interface TestUser {
  email: string;
  password: string;
  displayName: string;
}

// Seeded demo users (packages/db/src/seed/run.ts) have no password hash and can't sign in — every spec
// self-registers a fresh unique-email user via the real sign-up form instead.
export function uniqueTestUser(label: string): TestUser {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return {
    email: `e2e-${label}-${unique}@example.com`,
    password: "correct-horse-battery-staple",
    displayName: `E2E ${label}`,
  };
}

export async function signUp(page: Page, user: TestUser): Promise<void> {
  await page.goto("/sign-up", { waitUntil: "networkidle" });
  await page.getByLabel("Name").fill(user.displayName);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

// AppLayout bounces any authenticated user with an incomplete onboarding_state row to /onboarding
// regardless of which route they land on next, so every spec that isn't testing onboarding itself needs
// to clear it first — "Skip setup for now" is the fastest real path through the wizard's first step.
export async function skipOnboarding(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Skip setup for now" }).click();
  await expect(page).toHaveURL(/\/home/);
}

export async function signUpAndEnterApp(page: Page, user: TestUser): Promise<void> {
  await signUp(page, user);
  await skipOnboarding(page);
}
