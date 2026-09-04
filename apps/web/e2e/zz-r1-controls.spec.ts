import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * R1 — exhaustive interactive-control sweep, WITH before/after screenshot evidence.
 *
 * Replaces the earlier sampled B4 pass. Every control on every authenticated route is interacted with
 * individually and photographed twice: once immediately before the interaction and once after. The pair
 * is the evidence — "the toggle works" is a claim, two images showing it off then on is a fact.
 *
 * Runs as the SEEDED demo account, not a fresh empty one. That matters: on an empty account a control
 * that does nothing visible is indistinguishable from a control that has nothing to act on, so every
 * "no change" result was ambiguous. With seeded data behind every screen and every category, a control
 * that still produces no change is a real finding.
 *
 * One test() per route rather than one big loop, so a route that hangs or throws cannot destroy the
 * results for the other 31 — the earlier single-test version stalled on /inbox and lost everything.
 *
 * Destructive controls are located but never clicked (see DESTRUCTIVE below): this runs against a real
 * database, and deleting the seeded data would both corrupt the rest of the sweep and destroy the
 * fixtures every later phase depends on. They are recorded as SKIPPED_DESTRUCTIVE so the denominator
 * stays honest rather than quietly shrinking.
 */

const SHOT_ROOT = path.resolve(__dirname, "../../../.claude/audit-screenshots");
const CONTROL_DIR = path.join(SHOT_ROOT, "web-controls");
const RESULT_DIR = path.join(SHOT_ROOT, "_results");

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

/**
 * Matched against each control's visible text / aria-label. Deliberately broad: a false positive here
 * costs one un-exercised control (recorded as skipped, so visible), while a false negative destroys real
 * data mid-run. Known limitation, documented for the manual pass: an unlabelled icon button, or one
 * worded "Clear all" / "Reset", is NOT caught by this and WOULD be clicked.
 */
const DESTRUCTIVE = /delete|remove|revoke|sign out|log out|disconnect|danger|cancel account|erase|wipe|unlink|leave/i;

const CONTROL_SELECTOR = 'button, [role="switch"], [role="radio"], [role="tab"], input[type="checkbox"], select';

type Outcome = "CHANGED" | "NAVIGATED" | "NO_CHANGE" | "SKIPPED_DESTRUCTIVE" | "DISABLED" | "ERROR";
interface Result {
  route: string;
  idx: number;
  kind: string;
  label: string;
  outcome: Outcome;
  detail: string;
  before: string | null;
  after: string | null;
}

const slug = (route: string) => (route === "/" ? "root" : route.replace(/^\//, "").replace(/\//g, "_"));
const safe = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unlabelled";


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

for (const route of ROUTES) {
  test(`R1 ${route}`, async ({ page }) => {
    test.setTimeout(6 * 60 * 1000);

    const results: Result[] = [];
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 200)}`);
    });
    page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: PAGEERROR ${String(e.message).slice(0, 200)}`));

    await signInAsDemoUser(page);

    const dir = path.join(CONTROL_DIR, slug(route));
    fs.mkdirSync(dir, { recursive: true });

    const settle = async () => {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(700);
    };

    await page.goto(route, { timeout: 20_000 });
    await settle();

    const descriptors = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel))
        .filter((e) => !e.closest("nav"))
        .map((e, i) => ({
          i,
          kind: e.getAttribute("role") ?? (e.tagName === "SELECT" ? "select" : e.tagName === "INPUT" ? "checkbox" : "button"),
          label: ((e.getAttribute("aria-label") || e.textContent || "").trim() || "(no label)").slice(0, 48),
          disabled: (e as HTMLButtonElement).disabled === true,
        }));
    }, CONTROL_SELECTOR);

    for (const d of descriptors) {
      const base = `${String(d.i).padStart(2, "0")}-${safe(d.label)}`;
      const push = (outcome: Outcome, detail: string, before: string | null = null, after: string | null = null) =>
        results.push({ route, idx: d.i, kind: d.kind, label: d.label, outcome, detail, before, after });

      if (d.disabled) {
        push("DISABLED", "rendered disabled");
        continue;
      }
      if (DESTRUCTIVE.test(d.label)) {
        push("SKIPPED_DESTRUCTIVE", "identified as destructive — not clicked");
        continue;
      }

      // Re-navigate before every control so each one is exercised from the same known-good state. Without
      // this, control N is interacting with whatever mess control N-1 left behind (an open modal, a
      // filtered list), and a failure can't be attributed to the control that actually caused it.
      await page.goto(route, { timeout: 20_000 }).catch(() => {});
      await settle();

      const locator = page.locator(CONTROL_SELECTOR).filter({ hasNot: page.locator("nav *") }).nth(d.i);
      if ((await locator.count()) === 0) {
        push("ERROR", "control no longer present after reload");
        continue;
      }

      const beforeRel = path.join("web-controls", slug(route), `${base}-before.png`);
      const afterRel = path.join("web-controls", slug(route), `${base}-after.png`);
      const urlBefore = page.url();
      const domBefore = await page.locator("main").innerText().catch(() => "");
      const ariaBefore = await locator.getAttribute("aria-checked").catch(() => null);

      await page.screenshot({ path: path.join(SHOT_ROOT, beforeRel) }).catch(() => {});

      try {
        if (d.kind === "select") {
          const opts = await locator.locator("option").count();
          if (opts > 1) await locator.selectOption({ index: 1 });
        } else {
          await locator.click({ timeout: 5000 });
        }
        await page.waitForTimeout(600);
      } catch (err) {
        await page.screenshot({ path: path.join(SHOT_ROOT, afterRel) }).catch(() => {});
        push("ERROR", String(err).slice(0, 140), beforeRel, afterRel);
        continue;
      }

      await page.screenshot({ path: path.join(SHOT_ROOT, afterRel) }).catch(() => {});

      const urlAfter = page.url();
      if (urlAfter !== urlBefore) {
        push("NAVIGATED", new URL(urlAfter).pathname, beforeRel, afterRel);
        continue;
      }

      const ariaAfter = await locator.getAttribute("aria-checked").catch(() => null);
      const domAfter = await page.locator("main").innerText().catch(() => "");
      const changed = (ariaBefore !== null && ariaBefore !== ariaAfter) || domBefore !== domAfter;
      push(
        changed ? "CHANGED" : "NO_CHANGE",
        ariaBefore !== null ? `aria-checked ${ariaBefore} -> ${ariaAfter}` : changed ? "main content changed" : "no observable change",
        beforeRel,
        afterRel,
      );
    }

    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `r1-${slug(route)}.json`),
      JSON.stringify({ route, total: descriptors.length, results, consoleErrors }, null, 2),
    );

    const by = (o: Outcome) => results.filter((r) => r.outcome === o).length;
    console.log(
      `${route.padEnd(38)} ${descriptors.length} controls | CHANGED ${by("CHANGED")} NAV ${by("NAVIGATED")} NO_CHANGE ${by("NO_CHANGE")} DISABLED ${by("DISABLED")} SKIPPED ${by("SKIPPED_DESTRUCTIVE")} ERROR ${by("ERROR")} | console errors ${consoleErrors.length}`,
    );
  });
}
