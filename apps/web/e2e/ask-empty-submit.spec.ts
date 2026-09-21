import { test, expect } from "@playwright/test";
import { createSignedInUser } from "./support/api";

/**
 * Ask must never look like it accepted an empty question.
 *
 * Found by submitting every form in the app three times — empty, invalid, valid — and recording what the
 * page said each time. Ask was the only form that said NOTHING on an empty submit: `ask()` bails on
 * `!q.trim()`, but the button was always enabled, so pressing it on an empty box produced no message, no
 * error and no sign the press had registered. Three other forms in the app (`/lists` "Create list",
 * `/saved` "Save", `/automations` "Create rule") already disable their submit until there is something to
 * send; Ask now does the same, which makes "nothing will happen" visible instead of silent.
 *
 * The assertion is on the DISABLED STATE rather than on the absence of a response, because "no response"
 * is exactly what the defect looked like — a test written that way would have passed against the bug.
 */
test.describe("Ask — empty submit", () => {
  test.beforeEach(async ({ page, request }) => {
    const user = await createSignedInUser(page, "ask-empty");
  });

  test("the submit button is unavailable until there is a question to send", async ({ page }) => {
    await page.goto("/ask");

    // Scoped to the form: the mode switch above it also has a button labelled "Ask", and an unscoped
    // role lookup matches both.
    const submit = page.locator("form").getByRole("button", { name: "Ask", exact: true });
    const input = page.getByPlaceholder("When does my warranty expire?");

    await expect(submit).toBeDisabled();

    // Whitespace is not a question — trimming is what `ask()` itself checks, so the button has to agree.
    await input.fill("   ");
    await expect(submit).toBeDisabled();

    await input.fill("When does my warranty expire?");
    await expect(submit).toBeEnabled();

    // And back again, so the enabling is genuinely bound to the field rather than a one-way latch.
    await input.fill("");
    await expect(submit).toBeDisabled();
  });
});
