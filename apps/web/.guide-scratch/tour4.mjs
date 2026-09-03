import { chromium } from "@playwright/test";
import fs from "node:fs";

const WEB = "http://localhost:3000";
const SHOT_DIR = "/private/tmp/claude-501/-Users-donaldlundgren-veynlo-src/51f17180-c511-4a0f-ab55-fdd3b0c95945/scratchpad/web-guide/screenshots";

const state1 = JSON.parse(fs.readFileSync(new URL("./state1.json", import.meta.url), "utf8"));

const log = [];
function record(label, extra) {
  console.log("=== " + label + " ===");
  if (extra !== undefined && extra !== null) console.log(typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  log.push({ label, extra, ts: new Date().toISOString() });
}
async function shot(page, name) {
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("screenshot:", path);
}

async function main() {
  const browser = await chromium.launch();
  const ctx3 = await browser.newContext({ storageState: state1 });
  const page3 = await ctx3.newPage();
  page3.setDefaultTimeout(15000);

  await page3.goto(`${WEB}/places`);
  await page3.getByRole("heading", { name: "Saved places" }).waitFor({ state: "visible" });
  await shot(page3, "07-places-list-with-home");
  record("places-list-text", (await page3.locator("body").innerText()).slice(0, 1200));

  // Scope the click to the places card list, not the left nav "Home" link
  await page3.locator('a[href^="/places/"]').filter({ hasText: "Home" }).first().click();
  await page3.waitForURL(/\/places\/plc_.+/);
  await page3.waitForTimeout(500);
  await shot(page3, "07-place-detail-home-initial");
  record("place-detail-initial-text", (await page3.locator("body").innerText()).slice(0, 1500));

  // Create a reminder zone (geofence)
  await page3.getByRole("button", { name: "Arriving" }).click();
  await shot(page3, "07-place-detail-geofence-form");
  await page3.getByRole("button", { name: "Create reminder zone" }).click();
  await page3.waitForTimeout(700);
  await shot(page3, "07-place-detail-geofence-created");
  record("place-detail-after-geofence-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Add a context rule (reminder) to the geofence
  await page3.getByLabel("Remind me to…").fill("Grab the reusable bags");
  await page3.getByRole("button", { name: "Add", exact: true }).click();
  await page3.waitForTimeout(700);
  await shot(page3, "07-place-detail-context-rule-added");
  record("place-detail-after-rule-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Toggle geofence off via the Switch component
  await page3.locator('button[role="switch"]').first().click();
  await page3.waitForTimeout(600);
  await shot(page3, "07-place-detail-geofence-toggled-off");
  record("place-detail-after-toggle-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Remove the reminder rule
  const removeRuleBtn = page3.getByRole("button", { name: "Remove" });
  if (await removeRuleBtn.first().isVisible().catch(() => false)) {
    await removeRuleBtn.first().click();
    await page3.waitForTimeout(600);
    await shot(page3, "07-place-detail-rule-removed");
    record("place-detail-after-rule-removed-text", (await page3.locator("body").innerText()).slice(0, 2000));
  }

  // Idempotency: remove a leftover "Work" place from a previous run, if any
  await page3.goto(`${WEB}/places`);
  await page3.getByRole("heading", { name: "Saved places" }).waitFor({ state: "visible" });
  const existingWork = page3.locator('a[href^="/places/"]').filter({ hasText: "Work" });
  if (await existingWork.first().isVisible().catch(() => false)) {
    await existingWork.first().click();
    await page3.waitForURL(/\/places\/plc_.+/);
    await page3.getByRole("button", { name: "Remove this place" }).click();
    await page3.waitForTimeout(600);
  }

  // Add a second place via the full manual UI form (no coordinates) to show "Work"-style creation + "No coordinates yet"
  await page3.goto(`${WEB}/places`);
  await page3.getByRole("heading", { name: "Saved places" }).waitFor({ state: "visible" });
  await page3.getByRole("button", { name: "+ Add a place" }).click();
  await shot(page3, "07-places-add-form-empty");
  await page3.locator("#label").fill("Work");
  await page3.locator("#address").fill("1 Infinite Loop, Cupertino, CA 95014");
  await shot(page3, "07-places-add-form-filled-no-coords");
  await page3.getByRole("button", { name: "Save place" }).click();
  await page3.waitForTimeout(700);
  await shot(page3, "07-places-list-with-work-no-coords");
  record("places-list-final-text", (await page3.locator("body").innerText()).slice(0, 1500));

  await ctx3.close();

  fs.writeFileSync(new URL("./tour-log-partE.json", import.meta.url), JSON.stringify(log, null, 2));
  await browser.close();
  console.log("PART E DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
