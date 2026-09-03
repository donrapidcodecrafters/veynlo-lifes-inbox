import { chromium, request } from "@playwright/test";
import fs from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://localhost:4000";
const SHOT_DIR = "/private/tmp/claude-501/-Users-donaldlundgren-veynlo-src/51f17180-c511-4a0f-ab55-fdd3b0c95945/scratchpad/web-guide/screenshots";

const seed = JSON.parse(fs.readFileSync(new URL("./seed-info.json", import.meta.url), "utf8"));
const state1 = JSON.parse(fs.readFileSync(new URL("./state1.json", import.meta.url), "utf8"));
const state2 = JSON.parse(fs.readFileSync(new URL("./state2.json", import.meta.url), "utf8"));
const tripInfo = JSON.parse(fs.readFileSync(new URL("./trip-id.json", import.meta.url), "utf8"));

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
async function apiCall(ctx, method, path, data) {
  const res = await ctx.fetch(`${API}${path}`, { method, data, headers: { "x-veynlo-csrf": "1" } });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`${method} ${path} -> ${res.status()}: ${body}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const browser = await chromium.launch();
  const ctx1 = await browser.newContext({ storageState: state1 });
  const apiCtx1 = await request.newContext({ storageState: state1 });
  const page = await ctx1.newPage();
  page.setDefaultTimeout(15000);

  // ---------------------------------------------------------------
  // B (cont'd). Retake the cancelled-segment shot + Share panel
  // ---------------------------------------------------------------
  await page.goto(`${WEB}/trips/${tripInfo.tripId}`);
  await page.getByRole("heading", { name: "Trip to Lisbon" }).waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  await shot(page, "07-trip-detail-cancelled-segment");
  const cancelledText = await page.locator("body").innerText();
  record("trip-detail-text-cancelled", cancelledText.slice(0, 3500));

  await page.getByRole("button", { name: "Share" }).click();
  await page.waitForTimeout(400);
  await shot(page, "07-trip-detail-share-panel");
  const sharePanelText = await page.locator("body").innerText();
  record("trip-share-panel-text", sharePanelText.slice(-1800));

  // ---------------------------------------------------------------
  // C. SAVED MEMORY
  // ---------------------------------------------------------------
  await page.goto(`${WEB}/saved`);
  await page.getByRole("heading", { name: "Saved" }).waitFor({ state: "visible" });
  await shot(page, "07-saved-empty");
  const savedEmptyText = await page.locator("body").innerText();
  record("saved-empty-text", savedEmptyText.slice(0, 1200));

  await page.locator("#memory-url").fill("https://example.com/lisbon-restaurant-guide");
  await page.locator("#memory-text").fill("Restaurant recommendations for our Lisbon trip - ask for a table by the window at Belcanto.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(700);
  await shot(page, "07-saved-just-saved-confirmation");
  const justSavedText = await page.locator("body").innerText();
  record("saved-just-saved-text", justSavedText.slice(0, 800));

  await page.reload();
  await page.getByRole("heading", { name: "Saved" }).waitFor({ state: "visible" });
  await shot(page, "07-saved-list-with-item");
  await page.getByText("lisbon-restaurant-guide", { exact: false }).first().click();
  await page.waitForURL(/\/saved\/.+/);
  await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  const memoryUrl = page.url();
  const memoryId = memoryUrl.split("/saved/")[1];
  record("memory-detail-url", memoryUrl);
  await shot(page, "07-saved-detail-initial");
  const memoryDetailText = await page.locator("body").innerText();
  record("memory-detail-text", memoryDetailText.slice(0, 2500));

  // Scroll to Resurfacing card
  await page.getByText("Resurfacing", { exact: true }).scrollIntoViewIfNeeded();

  // Rule 1: date-based
  await page.getByRole("button", { name: "On a date" }).click();
  await page.locator("#rule-date").fill("2026-10-01");
  await shot(page, "07-saved-rule-date-picker");
  await page.getByRole("button", { name: "Add reminder" }).click();
  await page.waitForTimeout(600);
  await shot(page, "07-saved-rule-date-added");
  let rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
  record("rules-after-date-rule", rulesText);

  // Rule 2: person's birthday
  await page.getByRole("button", { name: "Before a person's birthday" }).click();
  await shot(page, "07-saved-rule-birthday-picker");
  await page.locator("#rule-dependent").selectOption({ label: seed.dependentName });
  await page.locator("#rule-days-before").fill("14");
  await page.getByRole("button", { name: "Add reminder" }).click();
  await page.waitForTimeout(600);
  await shot(page, "07-saved-rule-birthday-added");
  rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
  record("rules-after-birthday-rule", rulesText);

  // Rule 3: trip-location match
  await page.getByRole("button", { name: "When I plan a matching trip" }).click();
  await shot(page, "07-saved-rule-triplocation-picker");
  // Click the quick-pick chip for the Lisbon trip if present, else fill manually
  const lisbonChip = page.getByRole("button", { name: "Lisbon", exact: true });
  if (await lisbonChip.isVisible().catch(() => false)) {
    await lisbonChip.click();
  } else {
    await page.locator("#rule-location").fill("Lisbon");
  }
  await page.getByRole("button", { name: "Add reminder" }).click();
  await page.waitForTimeout(600);
  await shot(page, "07-saved-rule-triplocation-added");
  rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
  record("rules-after-triplocation-rule", rulesText);

  // Rule 4: location-proximity
  await page.getByRole("button", { name: "When I'm near a saved place" }).click();
  await shot(page, "07-saved-rule-proximity-picker");
  await page.locator("#rule-place").selectOption({ label: seed.placeLabel });
  await page.getByRole("button", { name: "Add reminder" }).click();
  await page.waitForTimeout(600);
  await shot(page, "07-saved-rule-proximity-added");
  rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
  record("rules-after-proximity-rule", rulesText);

  // Reload and verify all 4 persist with resolved labels
  await page.reload();
  await page.getByText("Resurfacing", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Resurfacing", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "07-saved-rules-all-four-after-reload");
  rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
  record("rules-all-four-after-reload", rulesText);

  // Delete the date rule (first "Remove" link in the rules <ul>)
  const removeButtons = page.locator("ul li button", { hasText: "Remove" });
  const removeCount = await removeButtons.count();
  record("remove-buttons-count", removeCount);
  if (removeCount > 0) {
    await removeButtons.first().click();
    await page.waitForTimeout(600);
    await shot(page, "07-saved-rule-after-delete");
    rulesText = await page.getByText("Resurfacing").locator("xpath=ancestor::div[contains(@class,'space-y-3')][1]").first().innerText();
    record("rules-after-delete", rulesText);
  }

  fs.writeFileSync(new URL("./memory-id.json", import.meta.url), JSON.stringify({ memoryId }, null, 2));

  await ctx1.close();
  await apiCtx1.dispose();
  fs.writeFileSync(new URL("./tour-log-partC.json", import.meta.url), JSON.stringify(log, null, 2));
  await browser.close();
  console.log("PART B-cont/C DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
