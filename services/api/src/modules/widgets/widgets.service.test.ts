import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { WidgetsService } from "./widgets.service";
import { PreferencesService } from "../preferences/preferences.service";
import { IdentityService } from "../identity/identity.service";
import { verifySignedDeepLink } from "../../common/signed-deep-link";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;

/**
 * §36 SYS-001..008 real Postgres integration test. The adversarial core of this file is: a widget
 * preference set to "count_only" must never leak a title/summary/destination/merchant, no matter what —
 * this isn't just documented, it's proven against a real DB row.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("WidgetsService", () => {
  let db: Database;
  let widgets: WidgetsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `widgets-test-${ownerUserId}@example.com`, displayName: "Widgets Test" });
      const identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
      widgets = new WidgetsService(db, new PreferencesService(db, identity));
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping WidgetsService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("defaults every widget kind to detail/enabled when no preference row exists", async () => {
    if (!dbAvailable) return;
    const prefs = await widgets.listPreferences(ownerUserId);
    expect(prefs).toHaveLength(schema.WIDGET_KINDS.length);
    expect(prefs.every((p) => p.privacyMode === "detail" && p.enabled === true)).toBe(true);
  });

  it("persists a preference change and reflects it back", async () => {
    if (!dbAvailable) return;
    await widgets.setPreference(ownerUserId, "today_summary", { privacyMode: "count_only" });
    const prefs = await widgets.listPreferences(ownerUserId);
    const todaySummaryPref = prefs.find((p) => p.widgetKind === "today_summary");
    expect(todaySummaryPref?.privacyMode).toBe("count_only");
    // Setting one widget's preference must not affect an unrelated widget kind's default.
    const nextTripPref = prefs.find((p) => p.widgetKind === "next_trip");
    expect(nextTripPref?.privacyMode).toBe("detail");
  });

  it("upserts on a second write rather than creating a duplicate row", async () => {
    if (!dbAvailable) return;
    await widgets.setPreference(ownerUserId, "deliveries", { privacyMode: "detail" });
    await widgets.setPreference(ownerUserId, "deliveries", { enabled: false });
    const rows = await db
      .select()
      .from(schema.widgetPreferences)
      .where(eq(schema.widgetPreferences.userId, ownerUserId));
    const deliveryRows = rows.filter((r) => r.widgetKind === "deliveries");
    expect(deliveryRows).toHaveLength(1);
    // The second call only set `enabled` — `privacyMode` from the first call must survive, not reset to a default.
    expect(deliveryRows[0]?.privacyMode).toBe("detail");
    expect(deliveryRows[0]?.enabled).toBe(false);
  });

  describe("today-summary privacy mode", () => {
    it("masked mode returns only a count — no item id/category/summary/deep link anywhere in the payload", async () => {
      if (!dbAvailable) return;
      const sourceEventId = generateId("sourceEvent");
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId,
        kind: "manual_entry",
        contentHash: "widget-test-hash",
        occurredAt: new Date(),
        idempotencyKey: `widget-test:${sourceEventId}`,
      });
      await db.insert(schema.inboxItems).values({
        id: generateId("inboxItem"),
        ownerUserId,
        category: "receipt",
        summary: "SECRET-PURCHASE-DETAIL: $412.50 at Very Private Pharmacy",
        sourceEventId,
        confidenceBand: "medium",
        suggestedActions: [],
      });

      await widgets.setPreference(ownerUserId, "today_summary", { privacyMode: "count_only" });
      const result = await widgets.todaySummary(ownerUserId);
      expect(result.privacyMode).toBe("count_only");
      expect(result.needsYouCount).toBeGreaterThanOrEqual(1);
      expect(result.items).toBeUndefined();
      // Adversarial: serialize the whole response and confirm the sensitive text never appears anywhere in it.
      expect(JSON.stringify(result)).not.toContain("SECRET-PURCHASE-DETAIL");
    });

    it("detail mode includes the item summary and a valid, resource-scoped signed deep link", async () => {
      if (!dbAvailable) return;
      const sourceEventId = generateId("sourceEvent");
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId,
        kind: "manual_entry",
        contentHash: "widget-test-hash-2",
        occurredAt: new Date(),
        idempotencyKey: `widget-test-2:${sourceEventId}`,
      });
      const inboxItemId = generateId("inboxItem");
      await db.insert(schema.inboxItems).values({
        id: inboxItemId,
        ownerUserId,
        category: "receipt",
        summary: "Your order from Test Merchant shipped",
        sourceEventId,
        confidenceBand: "medium",
        suggestedActions: [],
      });

      await widgets.setPreference(ownerUserId, "today_summary", { privacyMode: "detail" });
      const result = await widgets.todaySummary(ownerUserId);
      expect(result.privacyMode).toBe("detail");
      expect(result.items).toBeDefined();
      const item = result.items!.find((i) => i.id === inboxItemId);
      expect(item?.summary).toBe("Your order from Test Merchant shipped");
      const resolved = verifySignedDeepLink(item!.deepLink);
      expect(resolved).toEqual({ resourceType: "inbox_item", resourceId: inboxItemId });
    });

    // FIN-007 "hidden on ... widgets" — a real gap found via spec-conformance audit: nothing anywhere
    // masked a dollar amount that happened to be embedded in a widget item's summary text. Distinct from
    // the SYS-001 "masked mode returns only a count" test above (that's the widget's own count_only privacy
    // mode hiding EVERYTHING); this proves financial privacy mode masks just the dollar figure while still
    // showing the rest of the summary in "detail" mode.
    it("masks a dollar amount embedded in an item summary when financial privacy mode is on, but shows it when off", async () => {
      if (!dbAvailable) return;
      const sourceEventId = generateId("sourceEvent");
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId,
        kind: "manual_entry",
        contentHash: "widget-test-hash-finprivacy",
        occurredAt: new Date(),
        idempotencyKey: `widget-test-finprivacy:${sourceEventId}`,
      });
      const inboxItemId = generateId("inboxItem");
      await db.insert(schema.inboxItems).values({
        id: inboxItemId,
        ownerUserId,
        category: "bill",
        summary: "Electric bill for $214.60 is due soon",
        sourceEventId,
        confidenceBand: "medium",
        suggestedActions: [],
      });
      await widgets.setPreference(ownerUserId, "today_summary", { privacyMode: "detail" });

      await db
        .insert(schema.personalizationPreferences)
        .values({ userId: ownerUserId, financialPrivacyModeEnabled: false })
        .onConflictDoUpdate({ target: schema.personalizationPreferences.userId, set: { financialPrivacyModeEnabled: false } });
      const withPrivacyOff = await widgets.todaySummary(ownerUserId);
      expect(withPrivacyOff.items!.find((i) => i.id === inboxItemId)?.summary).toBe("Electric bill for $214.60 is due soon");

      await db
        .update(schema.personalizationPreferences)
        .set({ financialPrivacyModeEnabled: true })
        .where(eq(schema.personalizationPreferences.userId, ownerUserId));
      const withPrivacyOn = await widgets.todaySummary(ownerUserId);
      const maskedSummary = withPrivacyOn.items!.find((i) => i.id === inboxItemId)?.summary;
      expect(maskedSummary).not.toContain("$214.60");
      expect(maskedSummary).toContain("••••");
      expect(maskedSummary).toContain("Electric bill"); // only the amount is masked

      await db.delete(schema.personalizationPreferences).where(eq(schema.personalizationPreferences.userId, ownerUserId));
    });

    it("never shows real detail text for a health_appointment item, even in detail mode", async () => {
      if (!dbAvailable) return;
      const sourceEventId = generateId("sourceEvent");
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId,
        kind: "manual_entry",
        contentHash: "widget-test-hash-3",
        occurredAt: new Date(),
        idempotencyKey: `widget-test-3:${sourceEventId}`,
      });
      await db.insert(schema.inboxItems).values({
        id: generateId("inboxItem"),
        ownerUserId,
        category: "health_appointment",
        summary: "Dr. Alvarez — oncology follow-up regarding biopsy results",
        sourceEventId,
        confidenceBand: "medium",
        suggestedActions: [],
      });

      await widgets.setPreference(ownerUserId, "today_summary", { privacyMode: "detail" });
      const result = await widgets.todaySummary(ownerUserId);
      expect(JSON.stringify(result)).not.toContain("oncology");
      expect(JSON.stringify(result)).not.toContain("biopsy");
      const healthItem = result.items!.find((i) => i.category === "health_appointment");
      expect(healthItem?.summary).toBe("A health appointment needs attention");
    });
  });

  describe("next-trip privacy mode", () => {
    it("masked mode never includes the destination label", async () => {
      if (!dbAvailable) return;
      const startDateSort = new Date(Date.now() + 10 * 86_400_000);
      await db.insert(schema.trips).values({
        id: generateId("trip"),
        ownerUserId,
        destinationLabel: "SECRET-DESTINATION-Lisbon",
        startDateSort,
        status: "upcoming",
      });

      await widgets.setPreference(ownerUserId, "next_trip", { privacyMode: "count_only" });
      const result = await widgets.nextTrip(ownerUserId);
      expect(result.privacyMode).toBe("count_only");
      expect(result.hasUpcomingTrip).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET-DESTINATION-Lisbon");
      expect(result.destinationLabel).toBeUndefined();
    });

    it("detail mode includes the destination label and days-until", async () => {
      if (!dbAvailable) return;
      const startDateSort = new Date(Date.now() + 5 * 86_400_000);
      await db.insert(schema.trips).values({
        id: generateId("trip"),
        ownerUserId,
        destinationLabel: "Denver",
        startDateSort,
        status: "upcoming",
      });

      await widgets.setPreference(ownerUserId, "next_trip", { privacyMode: "detail" });
      const result = await widgets.nextTrip(ownerUserId);
      expect(result.privacyMode).toBe("detail");
      expect(result.hasUpcomingTrip).toBe(true);
      expect(typeof result.daysUntil).toBe("number");
    });
  });

  describe("deliveries privacy mode", () => {
    it("masked mode returns only a count — never a tracking number or merchant name", async () => {
      if (!dbAvailable) return;
      await db.insert(schema.shipments).values({
        id: generateId("shipment"),
        ownerUserId,
        carrier: "UPS",
        trackingNumber: "1Z-SECRET-TRACKING-NUMBER",
        status: "in_transit",
      });

      await widgets.setPreference(ownerUserId, "deliveries", { privacyMode: "count_only" });
      const result = await widgets.deliveries(ownerUserId);
      expect(result.privacyMode).toBe("count_only");
      expect(result.inTransitCount).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(result)).not.toContain("SECRET-TRACKING");
      expect(result.items).toBeUndefined();
    });

    it("detail mode never includes the tracking number even for the items it does return", async () => {
      if (!dbAvailable) return;
      await db.insert(schema.shipments).values({
        id: generateId("shipment"),
        ownerUserId,
        carrier: "FedEx",
        trackingNumber: "FEDEX-SECRET-9999",
        status: "out_for_delivery",
      });

      await widgets.setPreference(ownerUserId, "deliveries", { privacyMode: "detail" });
      const result = await widgets.deliveries(ownerUserId);
      expect(result.privacyMode).toBe("detail");
      expect(JSON.stringify(result)).not.toContain("FEDEX-SECRET-9999");
      expect(JSON.stringify(result)).not.toContain("trackingNumber");
    });
  });

  it("logs an app intent invocation", async () => {
    if (!dbAvailable) return;
    const { id } = await widgets.logAppIntent(ownerUserId, {
      platform: "ios_widget",
      intentKind: "widget_tap",
      resourceType: "inbox_item",
      resourceId: "inbox_test",
      outcome: "success",
    });
    const [row] = await db.select().from(schema.appIntentLog).where(eq(schema.appIntentLog.id, id));
    expect(row?.userId).toBe(ownerUserId);
    expect(row?.outcome).toBe("success");
  });
});
