import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createOnboardedUser } from "./support/api";
import { execSql } from "./support/db";

/**
 * DEF-070 — the owner's way back, and the bound on the recipient's window, verified through the UI rather
 * than only in the service tests.
 *
 * Before this, a finalized legacy release was permanent AND unrevocable. `access()` checked only
 * `status === "released"`, `revoke()` threw ALREADY_RELEASED, and nothing ever cleared `releaseTokenHash` —
 * so the emailed link reached household roster, vehicles, properties, pets, identity records, documents,
 * medications and emergency instructions forever, with no way for the owner to close it even while
 * demonstrably alive and using the app. The web UI additionally hid the Revoke button whenever
 * `status === "released"`, so even after the backend allowed it the capability would have been unreachable.
 *
 * A released config is seeded directly because reaching that state through the UI needs two separate
 * admin operators and an elapsed waiting period — the service tests cover that lifecycle
 * (legacy-release.test.ts); this spec covers what the owner can actually do once it is there.
 */
const API = "http://localhost:4000";

async function signInAsNewUser(page: Page, request: APIRequestContext, prefix: string) {
  const user = await createOnboardedUser(request, prefix);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  return user;
}

/** The owner id the API assigned, read back so the seeded row belongs to the signed-in account. */
async function currentUserId(page: Page): Promise<string> {
  const res = await page.request.get(`${API}/v1/auth/me`);
  const body = (await res.json()) as { id?: string; userId?: string };
  return (body.id ?? body.userId)!;
}

test.describe("legacy release — the owner can end a finalized release", () => {
  test("shows the expiry and ends access, instead of hiding Revoke once released", async ({ page, request }) => {
    await signInAsNewUser(page, request, "legacy-owner");
    const ownerId = await currentUserId(page);
    const configId = `lrc_e2e_${Date.now()}`;

    execSql(
      `INSERT INTO legacy_release_configs
         (id, owner_user_id, trusted_contact_email, categories, waiting_period_days, status,
          released_at, release_token_hash, release_expires_at)
       VALUES
         ('${configId}', '${ownerId}', 'trusted@example.com', '["identity_records"]', 30, 'released',
          now(), 'hash_${configId}', now() + interval '365 days')`,
    );

    await page.goto("/settings/sharing/legacy-release");

    // The expiry is stated, so "permanent" is no longer the user's mental model either.
    await expect(page.getByText(/Your trusted contact's link works until/i)).toBeVisible({ timeout: 15_000 });

    // And the way out exists at all — this button was hidden for released configs.
    const endAccess = page.getByRole("button", { name: /End access now/i });
    await expect(endAccess).toBeVisible();

    page.once("dialog", (d) => {
      // The confirmation must describe THIS act, not the generic one for an unfired arrangement.
      expect(d.message()).toMatch(/stops working immediately/i);
      void d.accept();
    });
    await endAccess.click();

    await expect(page.getByText("Revoked").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /End access now/i })).toHaveCount(0);
  });
});
