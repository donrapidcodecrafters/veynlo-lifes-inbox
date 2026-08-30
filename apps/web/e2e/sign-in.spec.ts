import { test, expect } from "@playwright/test";
import { signUp, skipOnboarding, uniqueTestUser } from "./helpers";

test("sign up, sign out, and sign back in", async ({ page }) => {
  const user = uniqueTestUser("signin");

  await signUp(page, user);
  await skipOnboarding(page);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/home/);
});
