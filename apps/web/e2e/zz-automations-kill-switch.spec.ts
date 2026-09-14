import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createOnboardedUser } from "./support/api";

/**
 * DEF-066. `toggleKillSwitch` applied an optimistic SWR update, then awaited the PUT with no try/catch. On
 * a rejected PUT the revalidating `mutateKillSwitch()` after it never ran, and this SWR key has no
 * `refreshInterval` (unlike runs/preparedActions), so nothing corrected the cache: the switch stayed
 * rendered "on" AND the banner rendered "Automations are paused. No rule will run until you turn this back
 * on." while the server had paused nothing and every rule kept firing. A safety control failing to the
 * unsafe state while telling the user it was safe, with the rejection unhandled so no error appeared.
 *
 * Isolation, while the Android sweep owns the live database: the kill switch is per-user
 * (AutomationController.setKillSwitch takes user.userId), so each test creates its OWN fresh account and
 * toggles only that account's switch. Nothing here touches usr_demo_alex, the account the sweep drives.
 * Redirecting the browser to a second API instance was tried first and does not work — auth resolves
 * client-side and the session cookie does not survive the rewrite.
 */
const API = "http://localhost:4000";

/** The message toggleKillSwitch shows when the PUT is rejected without an ApiError message of its own.
 *  Asserted by text rather than by role: this page already renders an alert-role node of its own, so
 *  getByRole("alert") would pass whether or not the kill switch reported anything. */
const KILL_SWITCH_ERROR = /Couldn't change the kill switch. It has been left as it was./;

/**
 * Account via the API, session via the real sign-in form — the pattern every other spec in this directory
 * uses. createOnboardedUser on its own creates the account but leaves the browser with no session cookie,
 * so the app bounces straight to /sign-in.
 */
async function signInAsNewUser(page: Page, request: APIRequestContext, prefix: string) {
  const user = await createOnboardedUser(request, prefix);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe("automations kill switch", () => {
  test("a failed PUT rolls the switch back and says so, instead of claiming automations are paused", async ({ page, request }) => {
    await signInAsNewUser(page, request, "killswitch");
    await page.goto("/automations");

    const sw = page.getByRole("switch", { name: /pause all automations/i });
    // Enabled only once the real value has loaded, so this also proves we are past the loading state
    // rather than asserting against the disabled placeholder.
    await expect(sw).toBeEnabled({ timeout: 15_000 });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    const banner = page.getByText(/No rule will run until you turn this back on/i);
    const killSwitchError = page.getByText(KILL_SWITCH_ERROR);
    await expect(killSwitchError).toHaveCount(0);
    await expect(banner).toHaveCount(0);

    // Fail ONLY the kill-switch PUT. Every other request still goes through, so the page keeps working
    // around it — this is one failed request, not a dead network.
    await page.route(`${API}/v1/automation/kill-switch`, async (route) => {
      if (route.request().method() === "PUT") {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await sw.click();

    // The three things that were wrong before the fix.
    await expect(killSwitchError).toBeVisible({ timeout: 10_000 });
    await expect(sw, "the switch must return to its real state, not keep the optimistic one").toHaveAttribute("aria-checked", "false");
    await expect(banner, "must never claim automations are paused when the request to pause them failed").toHaveCount(0);
  });

  test("a successful PUT still pauses, so the rollback did not break the normal path", async ({ page, request }) => {
    await signInAsNewUser(page, request, "killswitch-ok");
    await page.goto("/automations");

    const sw = page.getByRole("switch", { name: /pause all automations/i });
    await expect(sw).toBeEnabled({ timeout: 15_000 });
    await expect(sw).toHaveAttribute("aria-checked", "false");

    await sw.click();

    await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    await expect(page.getByText(/No rule will run until you turn this back on/i)).toBeVisible();
    await expect(page.getByText(KILL_SWITCH_ERROR)).toHaveCount(0);

    // Survives a reload, which is what distinguishes a real server-side pause from an optimistic update
    // that merely looked like one — the exact distinction the defect erased.
    await page.reload();
    await expect(page.getByRole("switch", { name: /pause all automations/i })).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  });
});
