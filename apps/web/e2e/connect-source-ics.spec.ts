import { test, expect } from "@playwright/test";
import { signUpAndEnterApp, uniqueTestUser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signUpAndEnterApp(page, uniqueTestUser("ics"));
});

// The only connector that's usable headlessly — Gmail/Outlook/calendar all require a real external OAuth
// redirect. IcsAdapter.connect() probes the feed URL synchronously with a real HTTP fetch before creating
// the connection row, so the fixture has to be genuinely reachable: served from apps/web/public, which the
// web server already started by playwright.config.ts's webServer entry serves for free.
test("connects an ICS calendar feed", async ({ page, baseURL }) => {
  await page.goto("/connections");

  await page.getByRole("button", { name: "Add feed" }).click();

  await page.locator("#ics-url").fill(`${baseURL}/e2e-fixtures/sample.ics`);
  await page.locator("#ics-name").fill("E2E Fixture Feed");

  await page.getByRole("button", { name: "Add feed" }).click();

  await expect(page.getByText("Calendar feed", { exact: true })).toBeVisible();
  await expect(page.getByText(/items discovered/)).toBeVisible();
});
