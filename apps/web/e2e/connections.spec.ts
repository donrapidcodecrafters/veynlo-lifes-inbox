import { test, expect } from "@playwright/test";
import { createOnboardedUser, API_BASE_URL } from "./support/api";

/**
 * Connections page load — every connector card (Gmail, Outlook, calendars, etc; see AVAILABLE_CONNECTORS
 * in the page itself) always renders regardless of whether OAuth credentials are configured on this
 * deployment, so this doubles as a real round-trip check: clicking "Connect" on a connector this local/CI
 * environment has no OAuth app for should surface the real CONNECTOR_NOT_CONFIGURED response from the API
 * (see connections/page.tsx's own `connect()` handler), not a client-side crash or a silent no-op.
 */
test.describe("Connections", () => {
  test.beforeEach(async ({ page, request }) => {
    const user = await createOnboardedUser(request, "connections");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
  });

  test("the Connections page loads and lists available connectors", async ({ page }) => {
    await page.goto("/connections");
    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();

    const gmailCard = page.getByText("Gmail", { exact: true });
    await expect(gmailCard).toBeVisible();
    const outlookCard = page.getByText("Outlook", { exact: true });
    await expect(outlookCard).toBeVisible();
  });

  test("attempting to connect Gmail surfaces the real backend outcome for this deployment's configuration", async ({ page }) => {
    await page.goto("/connections");

    // Whether Gmail is "configured" here is a live deployment fact (GOOGLE_OAUTH_CLIENT_ID/SECRET in the
    // API's own .env), not something this spec should hardcode either way — checked directly against the
    // same endpoint connections/page.tsx's connect() calls, so the assertion below always matches reality
    // instead of assuming a fixed local/CI state that a real credential (this environment now has one) or a
    // fresh clone (which doesn't) would silently invalidate.
    const authRes = await page.request.fetch(`${API_BASE_URL}/v1/connectors/gmail/authorize`, { headers: { "x-veynlo-csrf": "1" } });

    // Scoped precisely via XPath rather than a broad `hasText` filter — the Gmail card's DOM shape is
    // <div><p>Gmail</p><p>description</p></div><button>Connect</button> (see connections/page.tsx's
    // AVAILABLE_CONNECTORS.map), so this walks from the exact "Gmail" label to its sibling Connect button
    // rather than risking a `hasText: "Gmail"` match against an outer layout wrapper that (like every
    // ancestor of this card) technically also "contains" both the text and *some* Connect button.
    const gmailConnectButton = page.locator(
      'xpath=//p[normalize-space(text())="Gmail"]/parent::div/following-sibling::button[normalize-space(text())="Connect"]',
    );

    if (authRes.ok()) {
      // Real credentials configured — connect() does a full navigation (window.location.href) to the real
      // provider's consent screen, so the meaningful assertion here is that it's actually Google's real
      // domain, not this app's own error path.
      await gmailConnectButton.click();
      await page.waitForURL(/accounts\.google\.com/, { timeout: 15_000 });
    } else {
      // Not configured on this deployment (fresh clone / CI without secrets) — original assertion: the
      // real, specific CONNECTOR_NOT_CONFIGURED error surfaces in the UI, not a client-side crash or no-op.
      await gmailConnectButton.click();
      // `getByRole("alert")` alone also matches Next.js's own `#__next-route-announcer__` live region
      // (present on every page for accessible client-side navigation announcements), so this excludes it
      // by id rather than risking a strict-mode violation between the two real `role="alert"` elements.
      const errorAlert = page.locator('[role="alert"]:not(#__next-route-announcer__)');
      await expect(errorAlert).toContainText(/Gmail isn't configured/i);
    }
  });
});
