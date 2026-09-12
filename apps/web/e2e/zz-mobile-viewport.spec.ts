import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Mobile capture that reflects what a phone actually shows, plus a real check on the fixed bottom nav.
 *
 * Why this exists: the first mobile pass used `fullPage: true`, which stitches the entire scrollable page
 * into one tall image. A position:fixed bottom bar is painted once at its viewport position, so it landed
 * in the MIDDLE of a 390x1180 image — a canvas no phone ever displays. Those screenshots could not answer
 * the question they were taken to answer, and looked like the nav was broken when the capture was.
 *
 * This captures viewport-sized frames (exactly 390x844, what the user sees) scrolled top to bottom, and
 * separately MEASURES the two things the images cannot prove:
 *   1. is the bottom nav actually pinned to the bottom of the viewport, and
 *   2. is any content permanently hidden underneath it at full scroll — the real defect class, where a
 *      page lacks bottom padding equal to the nav height and its last row can never be read or tapped.
 */

const SHOT_ROOT = path.resolve(__dirname, "../../../.claude/audit-screenshots");
const OUT = path.join(SHOT_ROOT, "web-mobile-390-viewport");

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

const slug = (r: string) => r.replace(/^\//, "").replace(/\//g, "_");

test("mobile 390x844 — real viewport frames + bottom-nav occlusion check", async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  fs.mkdirSync(OUT, { recursive: true });

  const findings: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route, { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);

    const dir = path.join(OUT, slug(route));
    fs.mkdirSync(dir, { recursive: true });

    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const vh = 844;
    const frames = Math.min(Math.ceil(pageHeight / vh), 6);

    for (let i = 0; i < frames; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), i * vh);
      await page.waitForTimeout(350);
      // No fullPage: this is exactly what fits on the screen at this scroll position.
      await page.screenshot({ path: path.join(dir, `frame-${i + 1}.png`) }).catch(() => {});
    }

    // Scroll fully to the bottom, then measure the nav against the content behind it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, "bottom.png") }).catch(() => {});

    const probe = await page.evaluate(() => {
      const vpH = window.innerHeight;
      // There are TWO <nav> elements: the desktop sidebar (collapsed to height 0 at mobile) and the
      // fixed bottom tab bar. querySelector("nav") returns the sidebar and reported "height 0, not
      // pinned" on every route — 28 phantom defects. Pick the visible fixed one instead.
      const nav = Array.from(document.querySelectorAll("nav"))
        .filter((n) => n.getBoundingClientRect().height > 0)
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] ?? null;
      if (!nav) return { hasNav: false } as const;
      const nr = nav.getBoundingClientRect();
      const cs = getComputedStyle(nav);

      // Anything rendered UNDER the nav band that is real content (not the nav itself) is unreachable.
      const occluded: string[] = [];
      const main = document.querySelector("main");
      if (main) {
        for (const el of Array.from(main.querySelectorAll("*"))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (el.children.length > 0) continue; // leaf nodes only — avoids reporting every ancestor
          const text = (el.textContent || "").trim();
          if (!text) continue;
          // Overlaps the nav band vertically and is horizontally within it.
          if (r.bottom > nr.top + 2 && r.top < nr.bottom - 2 && r.left < nr.right && r.right > nr.left) {
            occluded.push(`${el.tagName.toLowerCase()} "${text.slice(0, 45)}"`);
          }
        }
      }
      return {
        hasNav: true,
        position: cs.position,
        navTop: Math.round(nr.top),
        navBottom: Math.round(nr.bottom),
        navHeight: Math.round(nr.height),
        viewportH: vpH,
        pinnedToBottom: Math.abs(nr.bottom - vpH) <= 2,
        bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
        occluded: occluded.slice(0, 5),
      } as const;
    });

    if (!probe.hasNav) {
      findings.push(`${route}: NO <nav> present at 390px`);
      continue;
    }
    const status = probe.pinnedToBottom ? "pinned-ok" : `NOT-PINNED (bottom=${probe.navBottom} vs vp=${probe.viewportH})`;
    const occ = probe.occluded.length ? ` | OCCLUDED: ${probe.occluded.join("; ")}` : "";
    console.log(
      `${route.padEnd(36)} pos=${probe.position} nav=${probe.navHeight}px ${status}${occ}`,
    );
    if (!probe.pinnedToBottom) findings.push(`${route}: nav not pinned to viewport bottom — ${status}`);
    if (probe.occluded.length) findings.push(`${route}: content under nav at full scroll — ${probe.occluded.join("; ")}`);
  }

  console.log(`\n===== findings: ${findings.length} =====`);
  for (const f of findings) console.log(`  ${f}`);
  fs.writeFileSync(path.join(SHOT_ROOT, "_results", "mobile-viewport-findings.json"), JSON.stringify(findings, null, 2));
});
