import { test, expect } from "@playwright/test";
import { createOnboardedUser } from "./support/api";

/**
 * Regression coverage for a real bug found via a live QA pass: DocumentsPage keys its SWR cache per filter
 * tab (`/v1/documents?filter=${filter}`), and every state-changing action only ever called that one hook's
 * own `mutate()` — never the sibling tabs' cache entries. Unarchiving a document restored it correctly
 * server-side, but switching back to the "Active" tab within SWR's dedupingInterval still showed the stale,
 * pre-unarchive "No documents yet" response cached from right after the earlier Archive action. Fixed by
 * `revalidateAllFilters()`, which invalidates every `/v1/documents?filter=*` cache entry (via `useSWRConfig`)
 * on any action that can move a document between buckets. This test drives exactly that sequence through the
 * real UI against the real running stack — it must fail on the old per-hook `mutate()` and pass with the fix.
 */
test.describe("Documents — archive/unarchive tab revalidation", () => {
  test("unarchiving a document makes it reappear on the Active tab without a page reload", async ({ page, request }) => {
    const user = await createOnboardedUser(request, "doc-unarchive");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);

    await page.goto("/documents");
    // `exact: true` matters here: Playwright's `name` option is a substring match by default, so plain
    // "Documents" also matches the empty state's own <h3>"No documents yet"</h3> — two elements, and
    // strict mode fails. It only bites for a user with zero documents, which is exactly the fresh user
    // every CI run creates, so this failed in CI while passing against a populated local database.
    await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();

    const fileName = `unarchive-regression-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(`Regression test for unarchive tab revalidation.\n`),
    });
    const card = page.locator("li", { hasText: fileName });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Archive it, confirming it leaves the Active tab and lands in Archived.
    await card.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.locator("li", { hasText: fileName })).toHaveCount(0);
    await page.getByRole("tab", { name: "Archived" }).click();
    const archivedCard = page.locator("li", { hasText: fileName });
    await expect(archivedCard.getByRole("button", { name: "Unarchive" })).toBeVisible();

    // Unarchive, then immediately switch back to Active — this is the exact sequence that used to show a
    // stale empty state (the sibling tab's SWR cache never got invalidated by the unarchive mutation).
    await archivedCard.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.locator("li", { hasText: fileName })).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("tab", { name: "Active" }).click();
    await expect(page.locator("li", { hasText: fileName })).toBeVisible({ timeout: 15_000 });
  });
});
