import { test } from "@playwright/test";

/**
 * Diagnostic: enumerate EVERY <nav> at 390px with its box and computed position.
 *
 * The occlusion probe reported "nav height 0, not pinned" on 28 routes, which would be an implausible
 * number of identical defects — far more likely that `document.querySelector("nav")` matched the first
 * nav in the DOM (a desktop sidebar hidden at mobile, hence zero height) rather than the bottom tab bar
 * that is plainly visible in the screenshots. Confirm which before reporting anything as a defect.
 */

test("enumerate navs at 390px", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("alex@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Demo-Password-1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/lists");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);

  const info = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("nav").forEach((n, i) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      const cls = typeof n.className === "string" ? n.className.slice(0, 80) : "";
      out.push(
        `nav[${i}] pos=${cs.position} display=${cs.display} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} h=${Math.round(r.height)} w=${Math.round(r.width)} z=${cs.zIndex} class="${cls}" text="${(n.textContent || "").trim().slice(0, 60)}"`,
      );
    });
    // Also find whatever element actually contains the bottom tab labels, whether or not it is a <nav>.
    const hits: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const t = (el.textContent || "").replace(/\s+/g, "");
      if (t === "HomeInboxAskLifeSettings" && el.children.length > 0) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        hits.push(
          `TABBAR <${el.tagName.toLowerCase()}> pos=${cs.position} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} h=${Math.round(r.height)} class="${(typeof el.className === "string" ? el.className : "").slice(0, 80)}"`,
        );
      }
    });
    return {
      navs: out,
      tabbar: hits,
      viewportH: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      bodyPadBottom: getComputedStyle(document.body).paddingBottom,
    };
  });

  console.log(`viewport=${info.viewportH} scrollHeight=${info.scrollH} bodyPaddingBottom=${info.bodyPadBottom}`);
  console.log(`-- ${info.navs.length} <nav> element(s) --`);
  for (const n of info.navs) console.log("  " + n);
  console.log(`-- tab bar candidates --`);
  for (const t of info.tabbar) console.log("  " + t);
  if (info.tabbar.length === 0) console.log("  (none matched by label text)");
});
