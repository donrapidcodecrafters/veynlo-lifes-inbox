import { test } from "@playwright/test";

/**
 * Pinpoints WHICH element overflows at 390px, rather than only reporting that the page does.
 *
 * DEF-006 was previously marked fixed and "re-verified 0 overflow" — but that verification ran against an
 * empty account, where nothing overflows because there is nothing rendered. With seeded data /life
 * overflows by the same 28px as before and /connections by 15px, so this walks the DOM and reports the
 * offending elements with enough identity (tag, class, text) to fix them.
 */

const DEMO_EMAIL = "alex@example.com";
const DEMO_PASSWORD = "Demo-Password-1";

test("locate 390px overflow sources", async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of ["/life", "/connections"]) {
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1200);

    const report = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const offenders: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // Only report the element itself sticking out, not every ancestor that contains it.
        if (r.right > docWidth + 0.5) {
          const hasOffendingChild = Array.from(el.children).some(
            (c) => c.getBoundingClientRect().right > docWidth + 0.5,
          );
          if (hasOffendingChild) continue;
          const cls = typeof el.className === "string" ? el.className.slice(0, 90) : "";
          offenders.push(
            `${el.tagName.toLowerCase()} right=${Math.round(r.right)} (over by ${Math.round(r.right - docWidth)}px) w=${Math.round(r.width)} class="${cls}" text="${(el.textContent || "").trim().slice(0, 50)}"`,
          );
        }
      }
      return { docWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
    });

    console.log(`\n=== ${route} — client ${report.docWidth}px, scroll ${report.scrollWidth}px ===`);
    if (report.offenders.length === 0) console.log("  (no single element identified)");
    for (const o of report.offenders.slice(0, 12)) console.log(`  ${o}`);
  }
});
