import { test, expect } from "@playwright/test";
import { expectNoAccessibilityViolations } from "./support/a11y";
import { createOnboardedUser } from "./support/api";

/**
 * Settings hub navigation — Settings fans out into several sub-pages (Privacy, Security, Household,
 * Personalization, Billing); this walks into and back out of two of them (enough to prove the hub's
 * links are wired correctly without turning this into an exhaustive tour of every settings sub-page).
 */
test.describe("Settings", () => {
  test.beforeEach(async ({ page, request }) => {
    const user = await createOnboardedUser(request, "settings");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
  });

  test("Settings loads and links into Privacy and Security and back", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expectNoAccessibilityViolations(page, "/settings");

    // Each settings row has the shape <div><p>{title}</p><p>{description}</p></div><a><button>Open</button>
    // (see settings/page.tsx) — scoped via XPath from the exact title text to its sibling link, same
    // reasoning as connections.spec.ts's Gmail-card lookup: a broad `hasText` filter would just as happily
    // match an outer layout wrapper that also technically "contains" both the title and *an* Open link.
    async function openSection(title: string, expectedPath: string, expectedHeading: string) {
      const openLink = page.locator(`xpath=//p[normalize-space(text())="${title}"]/parent::div/following-sibling::a[1]`);
      await openLink.click();
      await expect(page).toHaveURL(new RegExp(`${expectedPath}$`));
      await expect(page.getByRole("heading", { name: expectedHeading, level: 1 })).toBeVisible();
      await page.getByRole("link", { name: "← Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
    }

    await openSection("Privacy", "/settings/privacy", "Privacy");
    await openSection("Security", "/settings/security", "Security");
  });
});
