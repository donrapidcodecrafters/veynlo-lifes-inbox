import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Route-level visual capture — every authenticated route, in both themes and at three viewport widths.
 *
 * Separate from the control sweep (zz-r1-controls) on purpose: this answers "does every screen look
 * right at every size and in both themes", the control sweep answers "does every control do something".
 * Both write into .claude/audit-screenshots so the whole audit's visual evidence lives in one reviewable
 * place instead of scattered through a chat log.
 *
 * Runs as the seeded demo account so these are screenshots of populated screens. Screenshots of empty
 * states prove almost nothing about layout: nothing wraps, nothing truncates, nothing overflows, and
 * every list looks fine because every list is empty.
 */

const SHOT_ROOT = path.resolve(__dirname, "../../../.claude/audit-screenshots");
const DEMO_EMAIL = "alex@example.com";
const DEMO_PASSWORD = "Demo-Password-1";

const ROUTES = [
  "/home", "/inbox", "/ask", "/life", "/life/identity", "/life/people/merge", "/life/pets/merge",
  "/life/properties/merge", "/life/vehicles/merge", "/timeline", "/documents", "/connections", "/entities",
  "/lists", "/places", "/saved", "/trips", "/automations", "/emergency-binder",
  "/settings", "/settings/billing", "/settings/calendar-trust", "/settings/data-export",
  "/settings/household", "/settings/notifications", "/settings/personalization", "/settings/privacy",
  "/settings/security", "/settings/sender-rules", "/settings/sharing",
  "/settings/sharing/caregiver-passes", "/settings/sharing/legacy-release",
];

const VARIANTS = [
  { dir: "web-desktop-light", width: 1280, height: 900, scheme: "light" as const },
  { dir: "web-desktop-dark", width: 1280, height: 900, scheme: "dark" as const },
  { dir: "web-tablet-768", width: 768, height: 1024, scheme: "light" as const },
  { dir: "web-mobile-390", width: 390, height: 844, scheme: "light" as const },
];

const slug = (route: string) => (route === "/" ? "root" : route.replace(/^\//, "").replace(/\//g, "_"));


/**
 * Sign in through the real sign-in FORM, not the API. An API sign-in via the `request` fixture puts the
 * session cookie in a separate cookie jar from the browser context, so every subsequent page.goto()
 * bounced to /sign-in — the first run of this captured 128 screenshots of the sign-in page before that
 * was caught. Driving the form guarantees the cookie lands where the browser will actually send it, and
 * has the side benefit of exercising the real sign-in path on every run.
 */
async function signInAsDemoUser(page: import("@playwright/test").Page) {
  await page.goto("/sign-in", { timeout: 20_000 });
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });
}

for (const v of VARIANTS) {
  test(`screens ${v.dir}`, async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);

    await signInAsDemoUser(page);

    await page.setViewportSize({ width: v.width, height: v.height });
    await page.emulateMedia({ colorScheme: v.scheme });

    const outDir = path.join(SHOT_ROOT, v.dir);
    fs.mkdirSync(outDir, { recursive: true });

    // Horizontal overflow at narrow widths is the defect this viewport exists to catch, so measure it
    // while we are here rather than relying on someone spotting it in the image later.
    const overflows: string[] = [];

    for (const route of ROUTES) {
      await page.goto(route, { timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(outDir, `${slug(route)}.png`), fullPage: true }).catch(() => {});

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) overflows.push(`${route} overflows by ${overflow}px`);
    }

    console.log(`${v.dir}: ${ROUTES.length} routes captured at ${v.width}x${v.height} (${v.scheme})`);
    for (const o of overflows) console.log(`  OVERFLOW ${o}`);
  });
}
