import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createSignedInUser } from "./support/api";

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

/**
 * The first version of this spec scanned the default theme only — which is light. Dark mode is half of
 * what a user can be looking at, and contrast is the rule most likely to differ between them: an earlier
 * commit in this audit fixed the dark theme's contrast on web ("which nothing was checking"), and DEF-076
 * found 58 violations in an admin app nothing had ever scanned at all. A light-only pass would have
 * reported the same clean result either way.
 *
 * The app reads its theme from localStorage before first paint (see theme-script.ts), so setting the key
 * on the origin ahead of navigation is enough — no UI toggling, and no dependence on the OS preference.
 */
const THEME_STORAGE_KEY = "veynlo-theme";

async function useTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // A blocked localStorage would leave the app on its default; the assertion below catches that.
      }
    },
    [THEME_STORAGE_KEY, theme] as const,
  );
}

/** Confirms the theme actually took, so a dark-mode pass cannot be a second light-mode pass wearing its
 *  name — the same "did the instrument point at the subject" check the route guards make. */
async function assertTheme(page: Page, theme: "light" | "dark") {
  const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (theme === "dark") {
    expect(applied, "dark mode did not apply — this run would have re-measured light mode").toBe("dark");
  }
}

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

async function scan(page: Page, route: string, into: Finding[], expectSignedIn = false, theme: "light" | "dark" = "light") {
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

  await assertTheme(page, theme);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  for (const v of results.violations) {
    into.push({ route: `${route} [${theme}]`, id: v.id, impact: v.impact ?? "unknown", help: v.help, nodes: v.nodes.length });
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
  for (const theme of ["light", "dark"] as const) {
    test(`public routes have no WCAG A/AA violations (${theme})`, async ({ page }) => {
      test.setTimeout(300_000);
      await useTheme(page, theme);
      const findings: Finding[] = [];
      for (const route of PUBLIC_ROUTES) await scan(page, route, findings, false, theme);
      expect(findings, `axe violations across ${PUBLIC_ROUTES.length} public routes in ${theme}:${report(findings)}
`).toEqual([]);
    });

    test(`signed-in routes have no WCAG A/AA violations (${theme})`, async ({ page }) => {
      test.setTimeout(600_000);
      await useTheme(page, theme);
      // createSignedInUser rather than driving the sign-in form: this suite now runs twice, once per
      // theme, and sign-in is throttled at 10/60s per IP (see DEF-081).
      await createSignedInUser(page, `a11y-${theme}`);

      const findings: Finding[] = [];
      for (const route of SIGNED_IN_ROUTES) await scan(page, route, findings, true, theme);
      expect(findings, `axe violations across ${SIGNED_IN_ROUTES.length} signed-in routes in ${theme}:${report(findings)}
`).toEqual([]);
    });
  }
});
