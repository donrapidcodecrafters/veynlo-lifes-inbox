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

async function scan(page: Page, route: string, into: Finding[], expectSignedIn = false) {
  await page.goto(`${ADMIN_BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  if (expectSignedIn) {
    expect(new URL(page.url()).pathname.startsWith("/sign-in"), `${route} bounced to ${page.url()}`).toBe(false);
  }
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

test.describe("admin accessibility", () => {
  test("the admin sign-in page has no WCAG A/AA violations", async ({ page }) => {
    const findings: Finding[] = [];
    await scan(page, "/sign-in", findings);
    expect(findings, `axe violations on the admin sign-in page:${report(findings)}\n`).toEqual([]);
  });

  test("every admin dashboard route has no WCAG A/AA violations", async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "set ADMIN_A11Y_EMAIL and ADMIN_A11Y_PASSWORD (see create-admin)");
    test.setTimeout(180_000);
    await page.goto(`${ADMIN_BASE}/sign-in`);
    await page.getByLabel(/email/i).fill(EMAIL!);
    await page.getByLabel(/password/i).fill(PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

    const findings: Finding[] = [];
    for (const route of SIGNED_IN_ROUTES) await scan(page, route, findings, true);
    expect(findings, `axe violations across ${SIGNED_IN_ROUTES.length} admin routes:${report(findings)}\n`).toEqual([]);
  });
});
