import { chromium, request } from "@playwright/test";
import fs from "node:fs";

const WEB = "http://localhost:3000";
const API = "http://localhost:4000";
const SHOT_DIR = "/private/tmp/claude-501/-Users-donaldlundgren-veynlo-src/51f17180-c511-4a0f-ab55-fdd3b0c95945/scratchpad/web-guide/screenshots";

const seed = JSON.parse(fs.readFileSync(new URL("./seed-info.json", import.meta.url), "utf8"));
const state1 = JSON.parse(fs.readFileSync(new URL("./state1.json", import.meta.url), "utf8"));
const state2 = JSON.parse(fs.readFileSync(new URL("./state2.json", import.meta.url), "utf8"));

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
  const page = await ctx1.newPage();
  page.setDefaultTimeout(15000);

  // Idempotency: remove any "Grocery run" list from a previous run of this script
  const apiCtxCleanup = await request.newContext({ storageState: state1 });
  const existingLists = await apiCall(apiCtxCleanup, "GET", "/v1/lists");
  for (const l of existingLists.filter((l) => l.name === "Grocery run")) {
    await apiCall(apiCtxCleanup, "DELETE", `/v1/lists/${l.id}`);
  }
  await apiCtxCleanup.dispose();

  // ---------------------------------------------------------------
  // D. LISTS
  // ---------------------------------------------------------------
  await page.goto(`${WEB}/lists`);
  await page.getByRole("heading", { name: "Lists" }).waitFor({ state: "visible" });
  await shot(page, "07-lists-empty");
  record("lists-empty-text", (await page.locator("body").innerText()).slice(0, 1200));

  await page.locator("#list-name").fill("Grocery run");
  await page.locator("#list-kind").selectOption({ label: "Grocery" });
  await shot(page, "07-lists-create-form-filled");
  const householdSelect = page.locator("#list-household");
  if (await householdSelect.isVisible().catch(() => false)) {
    await householdSelect.selectOption({ label: "Guide Test Household" });
  }
  await shot(page, "07-lists-create-form-with-household");
  await page.getByRole("button", { name: "Create list" }).click();
  await page.waitForTimeout(700);
  await shot(page, "07-lists-list-after-create");
  record("lists-after-create-text", (await page.locator("body").innerText()).slice(0, 1500));

  await page.getByText("Grocery run", { exact: false }).first().click();
  await page.waitForURL(/\/lists\/.+/);
  await page.getByRole("heading", { name: "Grocery run" }).waitFor({ state: "visible" });
  const listUrl = page.url();
  const listId = listUrl.split("/lists/")[1];
  record("list-detail-url", listUrl);
  await shot(page, "07-list-detail-empty-items");
  record("list-detail-empty-text", (await page.locator("body").innerText()).slice(0, 1200));

  // Add items
  await page.getByPlaceholder("Add an item…").fill("Milk");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder("Add an item…").fill("Eggs");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, "07-list-detail-with-items");
  record("list-detail-with-items-text", (await page.locator("body").innerText()).slice(0, 1500));

  // Check off Milk
  await page.getByLabel("Check off Milk").click();
  await page.waitForTimeout(700);
  await shot(page, "07-list-detail-milk-checked");

  // Assign Eggs to the second household member
  const eggsSelect = page.getByText("Eggs", { exact: true }).locator("xpath=ancestor::div[contains(@class,'flex-wrap')][1]").locator("select").first();
  const eggsOptions = await eggsSelect.locator("option").allTextContents();
  record("eggs-assign-select-options", eggsOptions);
  await eggsSelect.selectOption({ label: "Spouse" });
  await page.waitForTimeout(700);
  await shot(page, "07-list-detail-eggs-assigned");
  record("list-detail-after-assign-text", (await page.locator("body").innerText()).slice(0, 1500));

  // Share panel — add an object-level grant
  await page.getByRole("button", { name: "Share" }).click();
  await page.waitForTimeout(400);
  await shot(page, "07-list-detail-share-panel-empty");
  const thirdEmail = `guide-friend-${Date.now()}@example.com`;
  const shareForm = page.locator("form").filter({ has: page.locator('input[type="email"]') });
  await shareForm.locator('input[type="email"]').fill(thirdEmail);
  await shareForm.getByRole("button", { name: "Share", exact: true }).click();
  await page.waitForTimeout(700);
  await shot(page, "07-list-detail-share-panel-granted");
  record("list-share-panel-after-grant-text", (await page.locator("body").innerText()).slice(-1500));

  fs.writeFileSync(new URL("./list-id.json", import.meta.url), JSON.stringify({ listId, thirdEmail }, null, 2));

  await ctx1.close();

  // Now view as the second (household member) user
  const ctx2 = await browser.newContext({ storageState: state2 });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(15000);
  await page2.goto(`${WEB}/lists`);
  await page2.getByRole("heading", { name: "Lists" }).waitFor({ state: "visible" });
  await shot(page2, "07-lists-as-second-member");
  record("lists-as-second-member-text", (await page2.locator("body").innerText()).slice(0, 1200));

  await page2.getByText("Grocery run", { exact: false }).first().click();
  await page2.waitForURL(/\/lists\/.+/);
  await page2.getByRole("heading", { name: "Grocery run" }).waitFor({ state: "visible" });
  await shot(page2, "07-list-detail-as-second-member");
  record("list-detail-as-second-member-text", (await page2.locator("body").innerText()).slice(0, 1500));
  await ctx2.close();

  // ---------------------------------------------------------------
  // E. SAVED PLACES
  // ---------------------------------------------------------------
  const ctx3 = await browser.newContext({ storageState: state1 });
  const page3 = await ctx3.newPage();
  page3.setDefaultTimeout(15000);

  await page3.goto(`${WEB}/places`);
  await page3.getByRole("heading", { name: "Saved places" }).waitFor({ state: "visible" });
  await shot(page3, "07-places-list-with-home");
  record("places-list-text", (await page3.locator("body").innerText()).slice(0, 1200));

  await page3.getByText("Home", { exact: false }).first().click();
  await page3.waitForURL(/\/places\/.+/);
  await page3.waitForTimeout(500);
  await shot(page3, "07-place-detail-home-initial");
  record("place-detail-initial-text", (await page3.locator("body").innerText()).slice(0, 1500));

  // Create a reminder zone (geofence)
  await page3.getByRole("button", { name: "Arriving" }).click();
  await shot(page3, "07-place-detail-geofence-form");
  await page3.getByRole("button", { name: "Create reminder zone" }).click();
  await page3.waitForTimeout(600);
  await shot(page3, "07-place-detail-geofence-created");
  record("place-detail-after-geofence-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Add a context rule (reminder) to the geofence
  await page3.getByLabel("Remind me to…").fill("Grab the reusable bags");
  await page3.getByRole("button", { name: "Add", exact: true }).click();
  await page3.waitForTimeout(600);
  await shot(page3, "07-place-detail-context-rule-added");
  record("place-detail-after-rule-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Toggle geofence off
  await page3.getByRole("switch").first().click().catch(async () => {
    await page3.locator('[role="switch"], input[type="checkbox"]').first().click();
  });
  await page3.waitForTimeout(500);
  await shot(page3, "07-place-detail-geofence-toggled-off");
  record("place-detail-after-toggle-text", (await page3.locator("body").innerText()).slice(0, 2000));

  // Remove the reminder rule
  const removeRuleBtn = page3.getByRole("button", { name: "Remove" });
  if (await removeRuleBtn.first().isVisible().catch(() => false)) {
    await removeRuleBtn.first().click();
    await page3.waitForTimeout(500);
    await shot(page3, "07-place-detail-rule-removed");
    record("place-detail-after-rule-removed-text", (await page3.locator("body").innerText()).slice(0, 2000));
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
  await page3.waitForTimeout(600);
  await shot(page3, "07-places-list-with-work-no-coords");
  record("places-list-final-text", (await page3.locator("body").innerText()).slice(0, 1500));

  await ctx3.close();

  fs.writeFileSync(new URL("./tour-log-partDE.json", import.meta.url), JSON.stringify(log, null, 2));
  await browser.close();
  console.log("PART D/E DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
