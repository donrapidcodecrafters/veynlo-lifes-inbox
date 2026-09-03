import { test, expect } from "@playwright/test";
import { createOnboardedUser, API_BASE_URL } from "./support/api";
import { seedCandidatePurchase } from "./support/db";

/**
 * §40.3 "Representative state machines" — real backend endpoints for the Purchase/Return/Subscription
 * lifecycle state machines (CommerceService.confirmPurchase/markPurchaseDisposed/initiateReturn/
 * markReturnLabelReady/markReturnRefundExpected/closeReturn/submitSubscriptionCancellation/
 * pauseSubscription/resumeSubscription) existed with real Postgres integration test coverage, but a live
 * QA pass found the web/mobile UI never grew real buttons for any of them — only badges. This is the live,
 * real-browser-against-the-real-running-stack proof that at least the purchase-confirm and
 * subscription-cancel actions actually work end-to-end through the UI, not just at the service layer.
 */
test.describe("Commerce lifecycle actions", () => {
  test("confirming a candidate purchase moves it to confirmed, then it can be marked disposed", async ({ page, request }) => {
    const user = await createOnboardedUser(request, "purchase-confirm");

    const meRes = await request.fetch(`${API_BASE_URL}/v1/auth/me`, { headers: { "x-veynlo-csrf": "1" } });
    expect(meRes.ok()).toBe(true);
    const me = (await meRes.json()) as { id: string };

    const purchaseId = `pur_e2e_${Date.now()}`;
    seedCandidatePurchase(me.id, purchaseId, `E2E-CONFIRM-${Date.now()}`);

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);

    await page.goto(`/life/purchases/${purchaseId}`);
    await expect(page.getByText("Status")).toBeVisible();
    await expect(page.getByText("candidate", { exact: true })).toBeVisible();

    const confirmButton = page.getByRole("button", { name: "Confirm this purchase" });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    // The status line re-renders from the same SWR cache key this button's own POST invalidates — no
    // reload needed, matching every other inline-mutation pattern already in this page (essential toggle,
    // gift/resale editors).
    await expect(page.getByText("confirmed", { exact: true })).toBeVisible();
    await expect(confirmButton).not.toBeVisible();

    const disposeButton = page.getByRole("button", { name: "Mark as disposed" });
    await expect(disposeButton).toBeVisible();
    // markPurchaseDisposed has no automatic path back — real confirmation step, same window.confirm
    // convention as every other hard-to-undo action in this app (see e.g. life/pets/[id].tsx's remove flow).
    page.once("dialog", (dialog) => dialog.accept());
    await disposeButton.click();

    await expect(page.getByText("disposed", { exact: true })).toBeVisible();
    await expect(disposeButton).not.toBeVisible();
  });

  test("canceling a subscription moves it to cancellation_pending and shows the submitted-cancellation banner", async ({ page, request }) => {
    const user = await createOnboardedUser(request, "sub-cancel");

    // §40.3 SUB-001 "manual add" — the one real API path to create a subscription outside of AI
    // extraction; lands it in state "active" (CreateSubscriptionDto's own confidenceBand: "verified" /
    // state: "active" reasoning), one of submitSubscriptionCancellation's real cancelable states.
    const createRes = await request.fetch(`${API_BASE_URL}/v1/subscriptions`, {
      method: "POST",
      headers: { "x-veynlo-csrf": "1" },
      data: { serviceLabel: `E2E Cancel Test ${Date.now()}`, merchantName: "E2E Cancel Test Merchant", amountMinorUnits: 999, currency: "USD" },
    });
    expect(createRes.ok()).toBe(true);
    const { id: subscriptionId } = (await createRes.json()) as { id: string };

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);

    await page.goto(`/life/subscriptions/${subscriptionId}`);
    await expect(page.getByRole("heading", { name: /E2E Cancel Test/ })).toBeVisible();

    const cancelButton = page.getByRole("button", { name: "Cancel subscription" });
    await expect(cancelButton).toBeVisible();
    // submitSubscriptionCancellation is a real, hard-to-undo user intent (see CommerceService's own doc
    // comment) — confirmed via the same window.confirm convention as the dispose action above.
    page.once("dialog", (dialog) => dialog.accept());
    await cancelButton.click();

    await expect(page.getByText("Cancellation submitted")).toBeVisible();
    await expect(page.getByText("cancellation pending", { exact: false })).toBeVisible();
    await expect(cancelButton).not.toBeVisible();
  });
});
