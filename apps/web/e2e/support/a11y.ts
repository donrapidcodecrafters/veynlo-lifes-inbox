import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * §50.1 "Accessibility... automated checks" / §50.2 "Accessibility critical journeys pass automated checks
 * plus manual screen-reader/keyboard/dynamic-type testing" — this is the automated half of that gate.
 * Scoped to WCAG 2.0/2.1 A+AA, axe-core's standard "would fail a real audit" tag set. Manual screen-reader/
 * keyboard/dynamic-type testing (the other half of §50.2) is out of scope for an automated suite and stays
 * a real, separate pre-release step — see docs/RELEASE_GATES.md.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Runs an axe-core scan against the current page and fails the test with a readable violation list if
 * anything is found. Kept as a shared helper (rather than inlining `new AxeBuilder(...).analyze()` in every
 * spec) so every accessibility assertion in this suite checks the same rule set and fails the same way.
 */
export async function expectNoAccessibilityViolations(page: Page, context?: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

  if (results.violations.length > 0) {
    const summary = results.violations
      .map((v) => `- [${v.impact ?? "unknown"}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})\n  ${v.helpUrl}`)
      .join("\n");
    throw new Error(`Accessibility violations found${context ? ` on ${context}` : ""}:\n${summary}`);
  }

  expect(results.violations).toEqual([]);
}
