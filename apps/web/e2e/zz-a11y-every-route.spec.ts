import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createOnboardedUser } from "./support/api";

/**
 * §42 / §50.1 "Accessibility ... automated checks" across the WHOLE app, not a sample.
 *
 * The suite already had `expectNoAccessibilityViolations`, but only 5 call sites in 2 spec files against
 * 75 page routes — so the helper existed and the coverage did not. This walks every static route (54 of
 * them; the `[id]` routes need fixtures and are covered separately by the interaction sweeps) and reports
 * every violation in one place rather than failing on the first.
 *
 * Signs in as its own fresh account, so nothing here touches the seeded demo account the Android sweep is
 * driving.
 */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const PUBLIC_ROUTES = [
  "/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password",
  "/accessibility", "/privacy-policy", "/acceptable-use-policy", "/cookie-policy",
  "/data-retention-policy", "/dmca", "/family-child-data", "/law-enforcement-requests",
  "/partner-data-processing", "/responsible-disclosure", "/security-overview", "/subprocessors",
];

const SIGNED_IN_ROUTES = [
  "/home", "/inbox", "/ask", "/life", "/lists", "/saved", "/places", "/documents",
  "/automations", "/connections", "/entities", "/emergency-binder", "/onboarding",
  "/life/identity", "/life/people/merge", "/life/pets/merge", "/life/properties/merge",
  "/life/vehicles/merge",
  "/settings", "/settings/billing", "/settings/calendar-trust", "/settings/data-export",
  "/settings/household", "/settings/notifications", "/settings/personalization",
  "/settings/privacy", "/settings/security", "/settings/sender-rules", "/settings/sharing",
  "/settings/sharing/caregiver-passes", "/settings/sharing/legacy-release",
];

interface Finding {
  route: string;
  id: string;
  impact: string;
  help: string;
  nodes: number;
}

async function scan(page: Page, route: string, into: Finding[], expectSignedIn = false) {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  // Let client-rendered content settle; an axe run against a spinner measures the spinner.
  await page.waitForTimeout(1200);

  // Prove the page under test is the page requested, before measuring it. A signed-in route that bounced
  // to /sign-in would otherwise be scanned as the sign-in form and pass — a clean result about the wrong
  // page. That exact failure (an accessible-looking pass measured against a sign-in screen) is what made a
  // whole Android sweep worthless earlier in this audit; a scan is only evidence if the instrument was
  // pointed at the subject.
  if (expectSignedIn) {
    expect(new URL(page.url()).pathname.startsWith("/sign-in"), `${route} bounced to ${page.url()} — not signed in`).toBe(false);
  }
  // And that something actually rendered, rather than an empty error boundary.
  const textLength = (await page.locator("body").innerText()).trim().length;
  expect(textLength, `${route} rendered almost no text (${textLength} chars) — scanning it proves nothing`).toBeGreaterThan(40);

  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  for (const v of results.violations) {
    into.push({ route, id: v.id, impact: v.impact ?? "unknown", help: v.help, nodes: v.nodes.length });
  }
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
    .map(([id, fs]) => `\n[${fs[0]!.impact}] ${id}: ${fs[0]!.help}\n  on ${fs.length} route(s): ${fs.map((f) => f.route).join(", ")}`)
    .join("\n");
}

test.describe("accessibility — every static route", () => {
  test("public routes have no WCAG A/AA violations", async ({ page }) => {
    test.setTimeout(300_000);
    const findings: Finding[] = [];
    for (const route of PUBLIC_ROUTES) await scan(page, route, findings);
    expect(findings, `axe violations across ${PUBLIC_ROUTES.length} public routes:${report(findings)}\n`).toEqual([]);
  });

  test("signed-in routes have no WCAG A/AA violations", async ({ page, request }) => {
    test.setTimeout(600_000);
    const user = await createOnboardedUser(request, "a11y");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);

    const findings: Finding[] = [];
    for (const route of SIGNED_IN_ROUTES) await scan(page, route, findings, true);
    expect(findings, `axe violations across ${SIGNED_IN_ROUTES.length} signed-in routes:${report(findings)}\n`).toEqual([]);
  });
});
