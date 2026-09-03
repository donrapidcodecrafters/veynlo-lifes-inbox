import { chromium } from "@playwright/test";
import fs from "node:fs";

const WEB = "http://localhost:3000";
const SHOT_DIR = "/private/tmp/claude-501/-Users-donaldlundgren-veynlo-src/51f17180-c511-4a0f-ab55-fdd3b0c95945/scratchpad/web-guide/screenshots";
const state1 = JSON.parse(fs.readFileSync(new URL("./state1.json", import.meta.url), "utf8"));

async function shot(page, name) {
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("screenshot:", path);
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: state1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(`${WEB}/places`);
  await page.getByRole("heading", { name: "Saved places" }).waitFor({ state: "visible" });
  await shot(page, "07-places-list-with-home-restored");
  console.log("=== places-list-restored-text ===");
  console.log((await page.locator("body").innerText()).slice(0, 1200));

  await page.locator('a[href^="/places/"]').filter({ hasText: "Home" }).first().click();
  await page.waitForURL(/\/places\/plc_.+/);
  await page.waitForTimeout(500);
  console.log("=== place-detail-restored-text ===");
  console.log((await page.locator("body").innerText()).slice(0, 2500));
  await shot(page, "07-place-detail-home-restored-with-rule");

  // Turn the geofence back on
  const switchBtn = page.locator('button[role="switch"]').first();
  const isChecked = await switchBtn.getAttribute("aria-checked");
  console.log("geofence switch aria-checked:", isChecked);
  if (isChecked === "false") {
    await switchBtn.click();
    await page.waitForTimeout(600);
  }
  await shot(page, "07-place-detail-geofence-active-again");

  // Now precisely remove just the context rule (not the place!) — the rule row's own "Remove" button
  // sits inside the Card that also contains "Grab the reusable bags" text.
  const ruleRemoveBtn = page.getByText("Grab the reusable bags", { exact: true }).locator("xpath=following-sibling::button[text()='Remove']");
  const ruleRemoveVisible = await ruleRemoveBtn.isVisible().catch(() => false);
  console.log("precise rule-remove button visible:", ruleRemoveVisible);
  if (ruleRemoveVisible) {
    await ruleRemoveBtn.click();
    await page.waitForTimeout(600);
    await shot(page, "07-place-detail-rule-removed-final");
    console.log("=== place-detail-after-precise-rule-removal ===");
    console.log((await page.locator("body").innerText()).slice(0, 2000));
  }

  await ctx.close();
  await browser.close();
  console.log("TOUR5 DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
