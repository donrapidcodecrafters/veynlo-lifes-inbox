import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createOnboardedUser } from "./support/api";

/**
 * DEF-068, the same defect as DEF-066 on a different control. `updatePrefs` wrote the new value into the
 * SWR cache optimistically and awaited the PUT with no try/catch, so a rejection skipped the revalidating
 * mutate() and nothing corrected it — this key has no refreshInterval either.
 *
 * It matters here because of what these toggles are. "Show details in notifications"
 * (`sensitivePreviewsEnabled`) decides whether amounts, dates and descriptions appear in a notification
 * preview — on a lock screen. A user turning that OFF would have seen it move and stay off, while the
 * server never accepted the change and kept sending the details.
 *
 * Each test signs in as its own fresh account, so nothing here touches the seeded demo account the Android
 * sweep is driving.
 */
const API = "http://localhost:4000";
const SAVE_ERROR = /Couldn't save that setting\. It has been left as it was\./;

async function signInAsNewUser(page: Page, request: APIRequestContext, prefix: string) {
  const user = await createOnboardedUser(request, prefix);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe("notification preferences", () => {
  test("a failed save must not leave a privacy toggle showing a setting the server rejected", async ({ page, request }) => {
    await signInAsNewUser(page, request, "prefs");
    await page.goto("/settings");

    const previews = page.getByRole("switch", { name: /Show details in notifications/i });
    await expect(previews).toBeVisible({ timeout: 15_000 });
    // Defaults on, so turning it OFF is the privacy-relevant direction — the one a user takes deliberately.
    await expect(previews).toHaveAttribute("aria-checked", "true");

    await page.route(`${API}/v1/notification-preferences`, async (route) => {
      if (route.request().method() === "PUT") {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await previews.click();

    await expect(page.getByText(SAVE_ERROR), "the user must be told the setting did not save").toBeVisible({ timeout: 10_000 });
    await expect(
      previews,
      "the toggle must show the server's real value, not the one the server refused",
    ).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
  });

  test("a successful save still persists across a reload", async ({ page, request }) => {
    await signInAsNewUser(page, request, "prefs-ok");
    await page.goto("/settings");

    const previews = page.getByRole("switch", { name: /Show details in notifications/i });
    await expect(previews).toBeVisible({ timeout: 15_000 });
    await expect(previews).toHaveAttribute("aria-checked", "true");

    await previews.click();
    await expect(previews).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
    await expect(page.getByText(SAVE_ERROR)).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("switch", { name: /Show details in notifications/i })).toHaveAttribute(
      "aria-checked",
      "false",
      { timeout: 15_000 },
    );
  });
});
