import { test, expect } from "@playwright/test";
import { createOnboardedUser, isAiConfigured } from "./support/api";

/**
 * "Add manually" capture (CaptureForm in inbox/page.tsx) — the most important capture path that needs no
 * connector at all. `POST /v1/ingestion/manual` runs fully synchronously in-request (see
 * IngestionService.ingestManualText), so there's no polling/async job to wait on here.
 *
 * What happens *after* submission genuinely depends on whether this deployment has `ANTHROPIC_API_KEY`
 * configured (see README's "what's real vs. what's a stub" and OnboardingState.aiConfigured):
 *   - AI configured: real extraction runs and, for content it recognizes, a card appears in the Inbox.
 *   - AI not configured (the default in this repo's own CI — see .env.example): every field-level
 *     extractor short-circuits before producing anything (proven at the integration level by
 *     services/api/src/modules/ingestion/ingestion.ai-kill-switch.test.ts), so the source event is marked
 *     "filed" and — correctly — nothing appears in the Inbox.
 * This spec checks `aiConfigured` up front and asserts whichever outcome is actually correct for this
 * environment, rather than assuming AI is always on (it usually isn't) or skipping the check entirely.
 */
test.describe("Manual capture", () => {
  test.beforeEach(async ({ page, request }) => {
    const user = await createOnboardedUser(request, "capture");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
  });

  test("submitting a manual capture succeeds, and the Inbox reflects the real backend outcome", async ({ page, request }) => {
    const aiConfigured = await isAiConfigured(request);
    const subject = `Your Amazon.com order has shipped ${Date.now()}`;

    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

    await page.getByRole("button", { name: "Add manually" }).click();
    await page.getByRole("tab", { name: "Paste text" }).click();
    await page.getByLabel("Subject").fill(subject);
    // Names a real, recognizable merchant and gives the model enough concrete detail (order number, item,
    // amount) to confidently classify as an actionable shipment — found live: a generic, merchant-less
    // "Your order has shipped! Order #123-4567890..." fixture reliably classified as domain "irrelevant"
    // against a real model (this branch had only ever run against a stub/unconfigured provider before, so
    // this fixture's suitability was never actually verified against live AI until now). Confirmed directly
    // against the API that this content reliably produces a real `needs_review` source event with a
    // `shipment`-category inbox item.
    await page
      .getByLabel("Content")
      .fill(
        "Hello, your Amazon.com order #123-4567890-1234567 has shipped and is on its way. " +
          "Item: Anker USB-C Charging Cable (6ft). Order total: $42.50. Expected delivery: in 3-5 business days. " +
          "Track your package for updates. Thank you for shopping with Amazon.",
      );
    await page.getByRole("button", { name: "Submit" }).click();

    await expect(page.getByText("Submitted.", { exact: false })).toBeVisible();

    if (aiConfigured) {
      // Real extraction is on — reload the Inbox and expect a corresponding card to have appeared. AI
      // classification is non-deterministic in phrasing but the raw subject we submitted is a reliable
      // enough anchor since summaries in this app are generated from the source content.
      await page.getByRole("button", { name: "Done" }).click();
      await page.reload();
      await expect(page.getByText(subject, { exact: false }).or(page.getByText(/shipped|shipment|order/i)).first()).toBeVisible({
        timeout: 15_000,
      });
    } else {
      // Deterministic-only mode: the submission itself succeeded (asserted above), and the item is
      // intentionally never surfaced as an Inbox card without a configured model provider — confirm the
      // Inbox still renders its normal "caught up" state rather than crashing or showing a phantom card
      // for content nothing actually classified.
      await page.getByRole("button", { name: "Done" }).click();
      await page.reload();
      await expect(page.getByText(subject, { exact: false })).toHaveCount(0);
    }
  });
});
