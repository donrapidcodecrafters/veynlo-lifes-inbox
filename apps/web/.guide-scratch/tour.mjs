import { chromium, request } from "@playwright/test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const WEB = "http://localhost:3000";
const API = "http://localhost:4000";
const SHOT_DIR = "/private/tmp/claude-501/-Users-donaldlundgren-veynlo-src/51f17180-c511-4a0f-ab55-fdd3b0c95945/scratchpad/web-guide/screenshots";
const DB_URL = "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
fs.mkdirSync(SHOT_DIR, { recursive: true });

function psql(sql) {
  return execFileSync("psql", [DB_URL, "-t", "-A", "-c", sql], { encoding: "utf8" }).trim();
}

const seed = JSON.parse(fs.readFileSync(new URL("./seed-info.json", import.meta.url), "utf8"));
const state1 = JSON.parse(fs.readFileSync(new URL("./state1.json", import.meta.url), "utf8"));
const state2 = JSON.parse(fs.readFileSync(new URL("./state2.json", import.meta.url), "utf8"));

const log = [];
function record(label, extra) {
  console.log("=== " + label + " ===");
  if (extra) console.log(JSON.stringify(extra, null, 2));
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
  // A. SCHOOL & ACTIVITIES
  // ---------------------------------------------------------------
  await page.goto(`${WEB}/life`);
  await page.waitForLoadState("networkidle");
  const schoolHeading = await page.getByRole("heading", { name: "School & activities" }).isVisible();
  record("life-page-loaded", { schoolHeadingVisible: schoolHeading });
  // Scroll to School & activities section and screenshot
  await page.getByRole("heading", { name: "School & activities" }).scrollIntoViewIfNeeded();
  await shot(page, "07-school-section-with-form");
  const schoolSectionText = await page.locator("section, div").filter({ hasText: "School & activities" }).first().innerText().catch(() => null);
  record("school-section-text", schoolSectionText);

  // Capture the permission form row + button text precisely
  const formRowText = await page.getByText("Field trip permission slip - Science Museum").locator("xpath=ancestor::div[contains(@class,'divide-y') or contains(@class,'rounded-xl')][1]").first().innerText().catch(() => null);
  record("permission-form-row-text", formRowText);

  // Click "Mark opened" to test state machine transition once
  const markBtn = page.getByRole("button", { name: /Mark opened/i });
  if (await markBtn.isVisible().catch(() => false)) {
    await markBtn.click();
    await page.waitForTimeout(800);
    await shot(page, "07-school-form-after-mark-opened");
    const afterText = await page.getByText("Field trip permission slip - Science Museum").locator("xpath=ancestor::div[contains(@class,'divide-y') or contains(@class,'rounded-xl')][1]").first().innerText().catch(() => null);
    record("permission-form-row-after-advance", afterText);
  } else {
    record("mark-opened-button-not-found", null);
  }

  // ---------------------------------------------------------------
  // B. TRIPS
  // ---------------------------------------------------------------
  await page.goto(`${WEB}/trips`);
  await page.waitForLoadState("networkidle");
  await shot(page, "07-trips-list-empty");
  const tripsPageText = await page.locator("body").innerText();
  record("trips-list-page-text", tripsPageText.slice(0, 2000));

  // Create a trip via the real UI form
  await page.locator("#trip-destination").fill("Lisbon");
  const startInput = page.locator("#trip-start");
  const endInput = page.locator("#trip-end");
  await startInput.fill("2026-11-10");
  await endInput.fill("2026-11-17");
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.waitForTimeout(1000);
  await shot(page, "07-trips-list-after-create");

  // Navigate into the trip
  await page.getByText("Lisbon", { exact: false }).first().click();
  await page.waitForURL(/\/trips\/.+/);
  await page.waitForLoadState("networkidle");
  const tripUrl = page.url();
  const tripId = tripUrl.split("/trips/")[1];
  record("trip-detail-url", tripUrl);
  await shot(page, "07-trip-detail-no-segments");
  const tripDetailTextEmpty = await page.locator("body").innerText();
  record("trip-detail-text-before-segments", tripDetailTextEmpty.slice(0, 2000));

  // Seed segments + a credit via direct API (no manual "add segment" UI exists in the app)
  const flightSeg = await apiCall(apiCtx1, "POST", `/v1/trips/${tripId}/segments`, {
    kind: "flight",
    providerName: "TAP Air Portugal",
    confirmationNumber: "ABC123",
    locationLabel: "JFK -> LIS",
    startDateIso: "2026-11-10T18:30:00.000Z",
    endDateIso: "2026-11-11T07:45:00.000Z",
  });
  const lodgingSeg = await apiCall(apiCtx1, "POST", `/v1/trips/${tripId}/segments`, {
    kind: "lodging",
    providerName: "Hotel Avenida Palace",
    confirmationNumber: "HTL-99881",
    locationLabel: "Lisbon, Portugal",
    startDateIso: "2026-11-11T15:00:00.000Z",
    endDateIso: "2026-11-17T11:00:00.000Z",
  });
  const credit = await apiCall(apiCtx1, "POST", "/v1/trips/credits", {
    tripId,
    providerName: "TAP Air Portugal",
    amountMinorUnits: 15000,
    currency: "USD",
    expirationDateIso: "2027-11-10T00:00:00.000Z",
  });
  record("seeded-segments-and-credit", { flightSeg, lodgingSeg, credit });

  await page.reload();
  await page.waitForLoadState("networkidle");
  await shot(page, "07-trip-detail-with-segments-and-credit");
  const tripDetailTextFull = await page.locator("body").innerText();
  record("trip-detail-text-with-segments", tripDetailTextFull.slice(0, 3000));

  // Open confirmation on the flight segment
  const openConfBtns = page.getByRole("button", { name: "Open confirmation" });
  if (await openConfBtns.first().isVisible().catch(() => false)) {
    await openConfBtns.first().click();
    await page.waitForTimeout(500);
    await shot(page, "07-trip-segment-evidence-open");
    const evidenceText = await page.locator("body").innerText();
    record("trip-segment-evidence-text", evidenceText.slice(0, 2500));
  }

  // Mark the credit used
  const markUsedBtn = page.getByRole("button", { name: "Mark used" });
  if (await markUsedBtn.first().isVisible().catch(() => false)) {
    await markUsedBtn.first().click();
    await page.waitForTimeout(600);
    await shot(page, "07-trip-credit-marked-used");
  }

  // Simulate a reservation change being detected (this normally only happens via AI-based re-ingestion
  // of a changed confirmation email; ANTHROPIC_API_KEY is not configured in this dev environment, so we
  // flip the same non-encrypted columns TripsService.reconcileSegment itself would write, purely to
  // observe the real UI code path for TRIP-009 disruption mode).
  psql(`update trip_segments set disruption_status='changed', disruption_detected_at=now() where id='${flightSeg.id}';`);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await shot(page, "07-trip-detail-disrupted");
  const disruptedText = await page.locator("body").innerText();
  record("trip-detail-text-disrupted", disruptedText.slice(0, 3000));

  // Also demonstrate "cancelled" on the lodging segment
  psql(`update trip_segments set status='cancelled', disruption_status='cancelled', disruption_detected_at=now() where id='${lodgingSeg.id}';`);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await shot(page, "07-trip-detail-cancelled-segment");
  const cancelledText = await page.locator("body").innerText();
  record("trip-detail-text-cancelled", cancelledText.slice(0, 3000));

  // Share button on trip detail (brief doc)
  await page.getByRole("button", { name: "Share" }).click();
  await page.waitForTimeout(400);
  await shot(page, "07-trip-detail-share-panel");
  const sharePanelText = await page.locator("body").innerText();
  record("trip-share-panel-text", sharePanelText.slice(-2000));

  fs.writeFileSync(new URL("./trip-id.json", import.meta.url), JSON.stringify({ tripId, flightSegId: flightSeg.id, lodgingSegId: lodgingSeg.id, creditId: credit.id }, null, 2));

  await ctx1.close();
  await apiCtx1.dispose();
  fs.writeFileSync(new URL("./tour-log-partA.json", import.meta.url), JSON.stringify(log, null, 2));
  await browser.close();
  console.log("PART A/B DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
