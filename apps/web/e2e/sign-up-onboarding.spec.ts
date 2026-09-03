import { test, expect } from "@playwright/test";
import { expectNoAccessibilityViolations } from "./support/a11y";
import { uniqueTestUser } from "./support/api";

/**
 * The single most important golden path in the app: a brand-new visitor creates an account, is routed
 * into onboarding (ONB-001 — see apps/web/src/app/(app)/layout.tsx), and reaches a working Home screen.
 * This test drives the real sign-up form end to end rather than seeding a user via the API (unlike most
 * other specs in this suite) because the form itself — validation, redirect wiring, the onboarding
 * hand-off — is exactly the thing worth protecting against regressions here.
 *
 * Onboarding itself always offers "Skip for now" (see OnboardingPage's own doc comment: it steers users
 * toward setting up a connector, it never traps them) — this test takes that path because a fresh Postgres
 * instance backing web-only E2E CI has no OAuth apps configured, so it can't drive a real Gmail/Outlook
 * connect. This still proves the whole first-run path: sign-up -> onboarding's first screen -> Home.
 */
test.describe("Sign-up and onboarding", () => {
  test("a new user can sign up, is routed to onboarding, and reaches Home", async ({ page }) => {
    const user = uniqueTestUser("signup");

    await page.goto("/sign-up");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    await expectNoAccessibilityViolations(page, "/sign-up");

    await page.getByLabel("Name").fill(user.displayName);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "What do you most want help with?" })).toBeVisible();

    await page.getByRole("button", { name: "Skip for now" }).click();

    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { name: "Home", exact: true, level: 1 })).toBeVisible();
    await expectNoAccessibilityViolations(page, "/home");
  });
});
