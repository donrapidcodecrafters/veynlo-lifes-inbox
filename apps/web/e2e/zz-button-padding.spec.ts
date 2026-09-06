import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Measures the horizontal breathing room inside EVERY button on every authenticated route.
 *
 * Prompted by a real defect found on mobile: the shared React Native Button fixed its height and centred
 * its content but reserved no horizontal padding, so any button sized to its content rendered with the
 * label flush against both edges. Full-width buttons hid it entirely, which is how it survived.
 *
 * Checking the shared component's source is not sufficient — a correct component says nothing about the
 * raw <button> elements scattered through pages, and a correct class list says nothing about what a
 * cramped parent does to the rendered box. So this measures the real geometry: the gap between each
 * button's content box and the actual bounding box of its text.
 *
 * Reported, never silently tolerated:
 *   TOUCHING  gap <= 1px  — text is against the edge
 *   CRAMPED   gap <  6px  — technically inside, visibly wrong
 *   CLIPPED   text is wider than the button's content box
 */

const SHOT_ROOT = path.resolve(__dirname, "../../../.claude/audit-screenshots");
const DEMO_EMAIL = "alex@example.com";
const DEMO_PASSWORD = "Demo-Password-1";

const ROUTES = [
  "/home", "/inbox", "/ask", "/life", "/life/identity", "/timeline", "/documents", "/connections",
  "/entities", "/lists", "/places", "/saved", "/trips", "/automations", "/emergency-binder",
  "/settings", "/settings/billing", "/settings/calendar-trust", "/settings/data-export",
  "/settings/household", "/settings/notifications", "/settings/personalization", "/settings/privacy",
  "/settings/security", "/settings/sender-rules", "/settings/sharing",
  "/settings/sharing/caregiver-passes", "/settings/sharing/legacy-release",
];

// Both themes and both widths: a button can fit at 1280 and be crushed at 390, and a theme swap can
// change border widths. Checking one combination would just relocate the blind spot.
const VARIANTS = [
  { name: "desktop-light", width: 1280, height: 900, scheme: "light" as const },
  { name: "desktop-dark", width: 1280, height: 900, scheme: "dark" as const },
  { name: "mobile-light", width: 390, height: 844, scheme: "light" as const },
  { name: "mobile-dark", width: 390, height: 844, scheme: "dark" as const },
];

test("every button has horizontal breathing room", async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  const findings: string[] = [];
  let measured = 0;

  for (const v of VARIANTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.emulateMedia({ colorScheme: v.scheme });

    for (const route of ROUTES) {
      await page.goto(route, { timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(600);

      const results = await page.evaluate(() => {
        const out: Array<{ label: string; gap: number; textW: number; boxW: number; verdict: string }> = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, a[role=button]"))) {
          const label = (el.textContent || "").trim();
          if (!label) continue; // icon-only buttons have no text to crowd
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0) continue;

          // Measure the TEXT itself, not the declared padding: a class can say px-4 while a cramped
          // parent or a long label still leaves the glyphs against the edge.
          const range = document.createRange();
          range.selectNodeContents(el);
          const textRect = range.getBoundingClientRect();
          const borderL = parseFloat(cs.borderLeftWidth) || 0;
          const borderR = parseFloat(cs.borderRightWidth) || 0;
          const contentLeft = rect.left + borderL;
          const contentRight = rect.right - borderR;
          const gapLeft = textRect.left - contentLeft;
          const gapRight = contentRight - textRect.right;
          const gap = Math.min(gapLeft, gapRight);
          const boxW = contentRight - contentLeft;

          // Only a control that LOOKS like a button needs interior padding. A plain text link rendered
          // as <button> (no background, no border) legitimately sits flush with its own text, and
          // flagging those would bury the real defects in false positives.
          const hasBg = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
          const hasBorder = borderL > 0 || borderR > 0;
          if (!hasBg && !hasBorder) continue;

          let verdict = "";
          if (textRect.width > boxW + 0.5) verdict = "CLIPPED";
          else if (gap <= 1) verdict = "TOUCHING";
          else if (gap < 6) verdict = "CRAMPED";
          if (verdict) out.push({ label: label.slice(0, 40), gap: Math.round(gap * 10) / 10, textW: Math.round(textRect.width), boxW: Math.round(boxW), verdict });
        }
        return out;
      });

      const total = await page.locator("button, a[role=button]").count();
      measured += total;
      for (const r of results) {
        findings.push(`[${v.name}] ${route} "${r.label}" ${r.verdict} gap=${r.gap}px (text ${r.textW}px in ${r.boxW}px box)`);
      }
    }
    console.log(`${v.name}: swept ${ROUTES.length} routes`);
  }

  console.log(`\n===== buttons measured: ${measured} | problems: ${findings.length} =====`);
  for (const f of findings.slice(0, 60)) console.log(`  ${f}`);
  fs.mkdirSync(path.join(SHOT_ROOT, "_results"), { recursive: true });
  fs.writeFileSync(path.join(SHOT_ROOT, "_results", "button-padding.json"), JSON.stringify({ measured, findings }, null, 2));
});
