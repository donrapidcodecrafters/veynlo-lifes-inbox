import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * §42 / §50.1 accessibility for the ADMIN app, which had no automated coverage at all — its own Playwright
 * config does not exist, and the web suite's baseURL points at :3000, so nothing had ever scanned :3100.
 *
 * The operator account is provisioned the same way a real one is (services/api create-admin), not seeded
 * around — there is deliberately no self-serve admin sign-up, and this respects that.
 *
 * Credentials come from the environment so nothing is committed:
 *   ADMIN_A11Y_EMAIL=... ADMIN_A11Y_PASSWORD=... npx playwright test e2e/zz-admin-a11y.spec.ts
 */
const ADMIN_BASE = process.env.E2E_ADMIN_URL ?? "http://localhost:3100";
const EMAIL = process.env.ADMIN_A11Y_EMAIL;
const PASSWORD = process.env.ADMIN_A11Y_PASSWORD;
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const SIGNED_IN_ROUTES = ["/dashboard", "/dashboard/admins", "/dashboard/invites", "/dashboard/merchants"];

interface Finding { route: string; id: string; impact: string; help: string; nodes: number }

let SCHEME: "light" | "dark" = "light";

async function scan(page: Page, route: string, into: Finding[], expectSignedIn = false) {
  await page.goto(`${ADMIN_BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (expectSignedIn) {
    expect(new URL(page.url()).pathname.startsWith("/sign-in"), `${route} bounced to ${page.url()}`).toBe(false);
  }
  // Admin has no theme toggle, so the only thing making it dark is the shared tokens' own
  // prefers-color-scheme block. Confirm it actually took, or a "dark" run is a second light run wearing
  // its name. Measured: dark paints rgb(14, 15, 20) and light rgb(248, 248, 251).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const looksDark = bg.replace(/[^0-9,]/g, "").split(",").map(Number).slice(0, 3).every((c) => c < 80);
  expect(looksDark, `expected a ${SCHEME} background, got ${bg}`).toBe(SCHEME === "dark");

  const textLength = (await page.locator("body").innerText()).trim().length;
  expect(textLength, `${route} rendered almost no text (${textLength} chars)`).toBeGreaterThan(40);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  for (const v of results.violations) into.push({ route, id: v.id, impact: v.impact ?? "unknown", help: v.help, nodes: v.nodes.length });
}

function report(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byRule.has(f.id)) byRule.set(f.id, []);
    byRule.get(f.id)!.push(f);
  }
  return [...byRule.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, fs]) => `\n[${fs[0]!.impact}] ${id}: ${fs[0]!.help}\n  ${fs.length} route(s): ${fs.map((f) => `${f.route} (${f.nodes} node${f.nodes === 1 ? "" : "s"})`).join(", ")}`)
    .join("\n");
}

/**
 * Both colour schemes.
 *
 * The admin app has no theme toggle and no data-theme handling of its own, which makes it easy to assume
 * it is light-only. It is not: it imports @veynlo/design-tokens/css, and that stylesheet switches on
 * `@media (prefers-color-scheme: dark)`. So admin renders in dark for anyone whose OS prefers dark, and
 * nothing had ever checked it — the same shape as DEF-076, where 58 violations sat in an app no scan had
 * ever been pointed at.
 *
 * Playwright emulates the media query directly, which is the real mechanism here rather than a stored
 * preference.
 */
for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`admin accessibility (${colorScheme})`, () => {
    test.use({ colorScheme });
    test.beforeEach(() => {
      SCHEME = colorScheme;
    });

    test("the admin sign-in page has no WCAG A/AA violations", async ({ page }) => {
      const findings: Finding[] = [];
      await scan(page, "/sign-in", findings);
      expect(findings, `axe violations on the admin sign-in page (${colorScheme}):${report(findings)}
`).toEqual([]);
    });

    test("every admin dashboard route has no WCAG A/AA violations", async ({ page }) => {
      test.skip(!EMAIL || !PASSWORD, "set ADMIN_A11Y_EMAIL and ADMIN_A11Y_PASSWORD (see create-admin)");
      test.setTimeout(180_000);
      await page.goto(`${ADMIN_BASE}/sign-in`);
      await page.getByLabel(/email/i).fill(EMAIL!);
      await page.getByLabel(/password/i).fill(PASSWORD!);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL("**/dashboard", { timeout: 20_000 });

      const findings: Finding[] = [];
      for (const route of SIGNED_IN_ROUTES) await scan(page, route, findings, true);
      expect(findings, `axe violations across ${SIGNED_IN_ROUTES.length} admin routes (${colorScheme}):${report(findings)}
`).toEqual([]);
    });
  });
}
