import { test, expect } from "@playwright/test";
import { createOnboardedUser } from "./support/api";

/**
 * Sign-in of an existing, already-onboarded user — the second half of the auth surface this app depends
 * on for every other journey. The account is created via the real API (see support/api.ts) rather than
 * through the sign-up UI (that path is already covered by sign-up-onboarding.spec.ts) so this spec stays
 * focused on exactly the thing it's named for.
 *
 * Sign-up itself leaves the browser context already authenticated (its response sets the session cookie),
 * so cookies are cleared before driving the sign-in form — otherwise this would trivially pass by never
 * actually needing to sign in at all.
 */
test.describe("Sign-in", () => {
  test("an existing user can sign in and lands on Home", async ({ page, context, request }) => {
    const user = await createOnboardedUser(request, "signin");
    await context.clearCookies();

    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { name: "Home", exact: true, level: 1 })).toBeVisible();
  });

  test("an incorrect password is rejected with an inline error, not a redirect", async ({ page, context, request }) => {
    const user = await createOnboardedUser(request, "signin-bad-pw");
    await context.clearCookies();

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
