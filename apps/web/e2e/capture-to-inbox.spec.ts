import { test, expect } from "@playwright/test";
import { signUpAndEnterApp, uniqueTestUser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signUpAndEnterApp(page, uniqueTestUser("capture"));
});

test("captures a pasted receipt into the inbox", async ({ page }) => {
  await page.goto("/inbox");

  await page.getByRole("button", { name: "Add manually" }).click();

  await page.locator("#capture-subject").fill("Your order has shipped");
  await page.locator("#capture-from").fill("orders@example.com");
  await page
    .locator("#capture-body")
    .fill("Your order #12345 has shipped and is expected to arrive on Friday. Track your package for updates.");

  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByText("Submitted. If Veynlo finds something worth reviewing in it, a card will appear here shortly.")).toBeVisible();
});
