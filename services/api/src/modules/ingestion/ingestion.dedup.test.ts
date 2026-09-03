import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * Real integration test against a real Postgres (this repo's other services/api tests are all pure-function
 * — nothing previously exercised IngestionService's dedup logic end-to-end, which is exactly how the
 * duplicate-bill/duplicate-subscription bug fixed here shipped unnoticed). Requires the local dev Postgres
 * from `docker compose up -d` (same one every other manual verification in this repo has used); skips
 * gracefully in an environment with no DB rather than failing CI outright.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService bill/subscription dedup", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `dedup-test-${ownerUserId}@example.com`, displayName: "Dedup Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService dedup tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("does not duplicate a bill when a second reminder email describes the same bill", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const dueDate = { iso_date: "2026-09-15", approximate_text: null };
    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
      ai.enqueue(
        "bill_extraction_v1",
        fakeExtraction({
          billerName: "Pacific Gas & Electric",
          amountDueMinorUnits: 12_345,
          currency: "USD",
          dueDate,
          autopayMentioned: false,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your PG&E bill is ready" : "Reminder: your PG&E bill is due soon",
        bodyText: "Amount due: $123.45. Due date: September 15, 2026.",
      });
    }

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(1);
    expect(bills[0]?.amountDueMinorUnits).toBe(12_345);
  });

  it("does not merge two genuinely different bills that happen to share amount and due date", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const dueDate = { iso_date: "2026-10-01", approximate_text: null };
    const billers = ["Comcast Internet", "City Water Utility"];
    for (const billerName of billers) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
      ai.enqueue("bill_extraction_v1", fakeExtraction({ billerName, amountDueMinorUnits: 5_000, currency: "USD", dueDate, autopayMentioned: false }));
      await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: `${billerName} bill`, bodyText: "Amount due: $50.00." });
    }

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    const matching = bills.filter((b) => b.amountDueMinorUnits === 5_000);
    expect(matching).toHaveLength(2); // two distinct billers, correctly NOT merged despite identical amount/date
  });

  it("does not duplicate a subscription when a second email confirms the same recurring service", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
      ai.enqueue(
        "subscription_extraction_v1",
        fakeExtraction({
          serviceLabel: "Streamflix Premium",
          merchantName: null,
          cadence: "monthly",
          amountMinorUnits: 1_599,
          currency: "USD",
          nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
          isTrial: i === 0,
          trialEndsDate: i === 0 ? { iso_date: "2026-09-20", approximate_text: null } : null,
          cancellationInstructionsUrl: null,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your Streamflix free trial started" : "Your Streamflix trial is ending — renewal confirmed",
        bodyText: "Streamflix Premium, $15.99/month.",
      });
    }

    const streams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    expect(streams).toHaveLength(1);
    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, streams[0]?.id ?? ""));
    expect(subs).toHaveLength(1);
  });

  /** Phase 2 §52.2 "subscription price change... awareness" (spec SUB-003) — found live while auditing
   * this: the update branch previously always kept the OLD amount, so even a second, differently-priced
   * email for the same service never actually changed anything. */
  it("detects a subscription price change: updates the stream's amount, records price_observations, and marks the subscription price_changed", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const amounts = [999, 1499]; // a real, > 50-cent price increase — not rounding noise
    for (const [i, amountMinorUnits] of amounts.entries()) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
      ai.enqueue(
        "subscription_extraction_v1",
        fakeExtraction({
          serviceLabel: "CloudNotes Plus",
          merchantName: null,
          cadence: "monthly",
          amountMinorUnits,
          currency: "USD",
          nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
          isTrial: false,
          trialEndsDate: null,
          cancellationInstructionsUrl: null,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your CloudNotes Plus receipt" : "Your CloudNotes Plus price is changing",
        bodyText: `CloudNotes Plus, $${(amountMinorUnits / 100).toFixed(2)}/month.`,
      });
    }

    // Scoped to this test's own service label, not a bare count for ownerUserId — the earlier tests in
    // this same file share this user and already left their own recurring_streams rows behind (same
    // pattern documented in ingestion.store-credit.test.ts's second test).
    const allStreams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    const streams = allStreams.filter((s) => s.serviceLabel === "CloudNotes Plus");
    expect(streams).toHaveLength(1);
    expect(streams[0]?.typicalAmountMinorUnits).toBe(1499);

    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, streams[0]!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.state).toBe("price_changed");

    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, streams[0]!.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedAmountMinorUnits).toBe(1499);
  });

  /**
   * SUB-003 audit — the flat `>= 50 minor units` diff used to be the ENTIRE price-change detector, with no
   * regard for magnitude: an ordinary state/local tax change on a cheap subscription (an 80-cent move on a
   * $9.99 plan) clears that old 50-cent floor and would have fired a false "price changed" alert. The new
   * detector requires BOTH an absolute floor ($1) AND a relative floor (>5%) — this diff (80 cents, ~8%)
   * clears the relative floor but NOT the new $1 absolute floor, so it must NOT fire. The observation is
   * still recorded (this is about gating the ALERT, not hiding real data), and — since neither a trial
   * transition nor a surprise change occurred — the subscription's state stays exactly what it already was.
   */
  it("does not fire a price-changed alert for a small, tax-sized wobble on a cheap subscription (fails the $1 absolute floor)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const amounts = [999, 1079]; // $9.99 -> $10.79: an 80-cent, ~8% move — plausible tax noise, not a real price change
    for (const [i, amountMinorUnits] of amounts.entries()) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
      ai.enqueue(
        "subscription_extraction_v1",
        fakeExtraction({
          serviceLabel: "TaxNoise Cloud",
          merchantName: null,
          cadence: "monthly",
          amountMinorUnits,
          currency: "USD",
          nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
          isTrial: false,
          trialEndsDate: null,
          cancellationInstructionsUrl: null,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your TaxNoise Cloud receipt" : "Your TaxNoise Cloud renewal receipt",
        bodyText: `TaxNoise Cloud, $${(amountMinorUnits / 100).toFixed(2)}/month.`,
      });
    }

    const allStreams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    const streams = allStreams.filter((s) => s.serviceLabel === "TaxNoise Cloud");
    expect(streams).toHaveLength(1);
    // The stream's typical amount still updates to the latest observed value — only the ALERT is suppressed.
    expect(streams[0]?.typicalAmountMinorUnits).toBe(1079);

    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, streams[0]!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.state).not.toBe("price_changed");

    // Still recorded — "record every observed price, just gate the surprise-notification threshold."
    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, streams[0]!.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedAmountMinorUnits).toBe(1079);
  });

  /**
   * SUB-003 — isolates the NEW relative-percentage floor specifically: $1.50 on a $50/month plan clears the
   * $1 absolute floor easily (and would have fired under the OLD flat "diff >= 50 cents" rule) but is only
   * a 3% move — comfortably inside ordinary tax-rate variation for a mid-priced subscription. Must NOT fire.
   */
  it("does not fire a price-changed alert for a small percentage move on a pricier subscription, even though it clears the $1 absolute floor", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const amounts = [5000, 5150]; // $50.00 -> $51.50: $1.50 / 3% — clears the $1 absolute floor, fails the 5% relative floor
    for (const [i, amountMinorUnits] of amounts.entries()) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
      ai.enqueue(
        "subscription_extraction_v1",
        fakeExtraction({
          serviceLabel: "Premium Gym Plus",
          merchantName: null,
          cadence: "monthly",
          amountMinorUnits,
          currency: "USD",
          nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
          isTrial: false,
          trialEndsDate: null,
          cancellationInstructionsUrl: null,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your Premium Gym Plus receipt" : "Your Premium Gym Plus renewal receipt",
        bodyText: `Premium Gym Plus, $${(amountMinorUnits / 100).toFixed(2)}/month.`,
      });
    }

    const allStreams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    const streams = allStreams.filter((s) => s.serviceLabel === "Premium Gym Plus");
    expect(streams).toHaveLength(1);
    expect(streams[0]?.typicalAmountMinorUnits).toBe(5150);

    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, streams[0]!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.state).not.toBe("price_changed");
  });

  /**
   * SUB-003 "promotional periods" — a subscription tracked as `state: "trial"` whose next email confirms a
   * real charge (isTrial: false) is an EXPECTED trial-ending transition, not a surprise price increase,
   * regardless of how large the dollar jump from the promo amount is (here $0 -> $9.99, which would clear
   * both the absolute and relative floors easily and fire as "price_changed" if this carve-out didn't
   * exist). Must land on the calmer, distinct "trial_ended" state, and the filed inbox item's summary must
   * read like an expected trial-ending charge, not a price-increase alert.
   */
  it("treats a trial-to-paid transition as an expected 'trial ended' event, not a surprise price change", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
    ai.enqueue(
      "subscription_extraction_v1",
      fakeExtraction({
        serviceLabel: "Streamflix Deluxe",
        merchantName: null,
        cadence: "monthly",
        amountMinorUnits: 0,
        currency: "USD",
        nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
        isTrial: true,
        trialEndsDate: { iso_date: "2026-09-20", approximate_text: null },
        cancellationInstructionsUrl: null,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Streamflix Deluxe free trial started — $0 for 3 months",
      bodyText: "Streamflix Deluxe, $0.00/month for 3 months, then $9.99/month.",
    });

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
    ai.enqueue(
      "subscription_extraction_v1",
      fakeExtraction({
        serviceLabel: "Streamflix Deluxe",
        merchantName: null,
        cadence: "monthly",
        amountMinorUnits: 999,
        currency: "USD",
        nextBillingDate: { iso_date: "2026-10-20", approximate_text: null },
        isTrial: false,
        trialEndsDate: null,
        cancellationInstructionsUrl: null,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Streamflix Deluxe trial has ended — payment confirmed",
      bodyText: "Streamflix Deluxe, $9.99/month. Your first payment has been processed.",
    });

    const allStreams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    const streams = allStreams.filter((s) => s.serviceLabel === "Streamflix Deluxe");
    expect(streams).toHaveLength(1);
    expect(streams[0]?.typicalAmountMinorUnits).toBe(999);

    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, streams[0]!.id));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.state).toBe("trial_ended");
    expect(subs[0]?.state).not.toBe("price_changed");

    // The $0 -> $9.99 move is still captured as real observed data, just not as a surprise-alert.
    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, streams[0]!.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedAmountMinorUnits).toBe(999);

    const inboxItems = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.linkedResourceType, "subscription"), eq(schema.inboxItems.linkedResourceId, subs[0]!.id)));
    const trialEndedItem = inboxItems.find((item) => item.summary.toLowerCase().includes("trial ended"));
    expect(trialEndedItem).toBeDefined();
    expect(trialEndedItem?.summary).toContain("9.99");
    expect(trialEndedItem?.summary.toLowerCase()).not.toContain("price");
  });

  /**
   * CAL-004 reschedule reconciliation, found live while auditing §13 of the spec: extractCalendarEvent
   * had no dedup at all (every other extractor in this file does) — a reminder or reschedule email about
   * an already-discovered appointment always inserted a sibling event instead of updating the existing
   * one, silently duplicating the user's calendar.
   *
   * A LATER follow-up audit found the update-in-place branch this dedup fix introduced always silently
   * applied the new date/time/location the moment a match was found, with no "offer, don't auto-apply"
   * step and no trusted-rule concept — exactly what spec's "Offer update or auto-update only when user has
   * an explicit trusted rule" line is written to prevent (see ingestion.reschedule-trust.test.ts for that
   * fix's own dedicated coverage). This test's own scenario is now the TRUSTED-sender case — a
   * `calendarRescheduleTrustedRules` row is seeded for the reschedule email's sender domain first — so it
   * still proves the underlying dedup mechanic (one row, updated in place, not a sibling) rather than the
   * newer "offer" gate, which the other test file covers on its own.
   */
  it("updates the existing discovered event, in place, when a reschedule email describes the same appointment from a trusted sender", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    await db.insert(schema.calendarRescheduleTrustedRules).values({ id: generateId("calendarRescheduleTrustedRule"), ownerUserId, senderDomain: "clinicportal.example" });

    const dates = ["2026-09-10", "2026-09-17"];
    for (const iso_date of dates) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
      ai.enqueue(
        "calendar_event_extraction_v1",
        fakeExtraction({
          title: "Dr. Alvarez follow-up",
          startDate: { iso_date, approximate_text: null },
          startTime: "14:00",
          timezone: "America/Los_Angeles",
          location: "123 Clinic Way",
          isAllDay: false,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        fromAddress: "scheduling@clinicportal.example",
        subject: iso_date === dates[0] ? "Your appointment is confirmed" : "Your appointment has been rescheduled",
        bodyText: `Dr. Alvarez follow-up on ${iso_date} at 2:00 PM.`,
      });
    }

    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const matching = events.filter((e) => e.title === "Dr. Alvarez follow-up");
    expect(matching).toHaveLength(1);
    expect((matching[0]?.start as { date?: string } | null)?.date).toBe("2026-09-17");
  });

  it("does not silently merge a same-titled email once two genuinely distinct events already share that title", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Two real, separate "Parent-teacher conference" appointments (a common enough generic title) already
    // exist for this owner — seeded directly, since routing both through ingestion would just exercise the
    // single-candidate update path proven by the test above. A third email with that same title is
    // genuinely ambiguous against two existing candidates — it must land as its own third event, not
    // silently overwrite either existing one ("more than one candidate -> treat as no match", same stance
    // as findExistingBill/findMatchingPurchaseLine).
    const futureSort = new Date(Date.now() + 30 * 86_400_000);
    await db.insert(schema.calendarEvents).values([
      {
        id: generateId("calendarEvent"),
        ownerUserId,
        title: "Parent-teacher conference",
        start: { precision: "date", instantUtc: null, date: "2026-10-05", timezone: null, sourceText: null },
        startSort: futureSort,
        isAllDay: false,
        source: "discovered_from_evidence",
        status: "confirmed",
        visibility: "private",
      },
      {
        id: generateId("calendarEvent"),
        ownerUserId,
        title: "Parent-teacher conference",
        start: { precision: "date", instantUtc: null, date: "2026-10-06", timezone: null, sourceText: null },
        startSort: futureSort,
        isAllDay: false,
        source: "discovered_from_evidence",
        status: "confirmed",
        visibility: "private",
      },
    ]);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Parent-teacher conference",
        startDate: { iso_date: "2026-10-07", approximate_text: null },
        startTime: "09:00",
        timezone: "America/Los_Angeles",
        location: null,
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your conference is confirmed",
      bodyText: "Parent-teacher conference on 2026-10-07 at 9:00 AM.",
    });

    // title is encrypted — no equality lookup in SQL (same reason findExistingDiscoveredCalendarEvent
    // fetches owner-scoped candidates and compares the decrypted title in application code).
    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const matching = events.filter((e) => e.title === "Parent-teacher conference");
    expect(matching).toHaveLength(3);
  });

  /**
   * RET-004 "Price-adjustment opportunity" — extractReceipt's new-purchase-line path (see
   * findMostRecentPriorPurchaseLine's doc comment) now detects when the user bought the exact same
   * product before at a higher price, within the deliberately simple 30-day-from-original-purchase
   * heuristic, and records a price_observations row + a "price_adjustment" inbox item for it — mirroring
   * the subscription price-change test above.
   */
  it("detects a price-adjustment opportunity when the same product is bought again cheaper within the 30-day window", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const purchases = [
      { orderNumber: "PADJ-ORIG-001", isoDate: "2026-08-05", unitPriceMinorUnits: 8_000 },
      { orderNumber: "PADJ-NEW-002", isoDate: "2026-08-20", unitPriceMinorUnits: 6_000 }, // 15 days later, cheaper
    ];
    for (const p of purchases) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
      ai.enqueue(
        "receipt_extraction_v1",
        fakeExtraction({
          merchantName: "Price Test Superstore",
          orderNumber: p.orderNumber,
          purchaseDate: { iso_date: p.isoDate, approximate_text: null },
          totalAmountMinorUnits: p.unitPriceMinorUnits,
          currency: "USD",
          taxMinorUnits: null,
          shippingMinorUnits: null,
          lineItems: [{ productLabel: "Price Test Blender 5000", quantity: 1, unitPriceMinorUnits: p.unitPriceMinorUnits }],
          returnDeadline: null,
          confidenceNotes: "Clear receipt.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: `Your Price Test Superstore order ${p.orderNumber}`,
        bodyText: `Price Test Blender 5000 x1, $${(p.unitPriceMinorUnits / 100).toFixed(2)}.`,
      });
    }

    const lines = await db
      .select({ line: schema.purchaseLines, purchase: schema.purchases })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const matching = lines.filter((l) => l.line.productLabel === "Price Test Blender 5000");
    expect(matching).toHaveLength(2);
    const original = matching.find((l) => l.line.unitPriceMinorUnits === 8_000);
    expect(original).toBeTruthy();

    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, original!.line.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedAmountMinorUnits).toBe(6_000);

    const inboxItems = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.category, "price_adjustment")));
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]?.linkedResourceId).toBe(original!.purchase.id);
    expect(inboxItems[0]?.suggestedActions).toEqual(["view_purchase", "dismiss"]);
  });

  it("does not flag a price-adjustment opportunity outside the 30-day window, or when the later purchase isn't cheaper", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Case A: genuinely cheaper, but 49 days later — outside the 30-day heuristic window.
    // Case B: within the window, but NOT cheaper (a price increase) — same "must actually be a drop" rule.
    const cases = [
      {
        product: "Price Test Gadget Outside Window",
        purchases: [
          { orderNumber: "PADJ-OOW-001", isoDate: "2026-06-01", unitPriceMinorUnits: 5_000 },
          { orderNumber: "PADJ-OOW-002", isoDate: "2026-07-20", unitPriceMinorUnits: 3_000 },
        ],
      },
      {
        product: "Price Test Gizmo Price Increase",
        purchases: [
          { orderNumber: "PADJ-INC-001", isoDate: "2026-08-01", unitPriceMinorUnits: 3_000 },
          { orderNumber: "PADJ-INC-002", isoDate: "2026-08-10", unitPriceMinorUnits: 5_000 },
        ],
      },
    ];

    for (const c of cases) {
      for (const p of c.purchases) {
        ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
        ai.enqueue(
          "receipt_extraction_v1",
          fakeExtraction({
            merchantName: "Price Test Superstore",
            orderNumber: p.orderNumber,
            purchaseDate: { iso_date: p.isoDate, approximate_text: null },
            totalAmountMinorUnits: p.unitPriceMinorUnits,
            currency: "USD",
            taxMinorUnits: null,
            shippingMinorUnits: null,
            lineItems: [{ productLabel: c.product, quantity: 1, unitPriceMinorUnits: p.unitPriceMinorUnits }],
            returnDeadline: null,
            confidenceNotes: "Clear receipt.",
          }),
        );
        await ingestion.ingestManualText({
          ownerUserId,
          householdId: null,
          subject: `Your Price Test Superstore order ${p.orderNumber}`,
          bodyText: `${c.product} x1, $${(p.unitPriceMinorUnits / 100).toFixed(2)}.`,
        });
      }
    }

    const lines = await db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    for (const c of cases) {
      const lineIds = lines.filter((l) => l.line.productLabel === c.product).map((l) => l.line.id);
      expect(lineIds).toHaveLength(2);
      const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, lineIds[0]!));
      expect(observations).toHaveLength(0);
      const observations2 = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, lineIds[1]!));
      expect(observations2).toHaveLength(0);
    }
  });

  /**
   * Adversarial re-verification of findMostRecentPriorPurchaseLine: buying the same product a THIRD time,
   * cheaper still, must compare against the second (most recent) purchase, not silently keep comparing
   * every later purchase back to the original first one. If the "most recent prior" logic regressed to a
   * first-match implementation, this test would still see two price_observations rows but both anchored to
   * the very first purchase line rather than the second alert being anchored to the second line.
   */
  it("fires a price-adjustment alert on a THIRD, still-cheaper repeat purchase, anchored to the most recent prior purchase (not the first)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const purchases = [
      { orderNumber: "PADJ-TRIPLE-001", isoDate: "2026-08-01", unitPriceMinorUnits: 10_000 },
      { orderNumber: "PADJ-TRIPLE-002", isoDate: "2026-08-10", unitPriceMinorUnits: 8_000 }, // cheaper than #1
      { orderNumber: "PADJ-TRIPLE-003", isoDate: "2026-08-20", unitPriceMinorUnits: 6_000 }, // cheaper than #2 too
    ];
    for (const p of purchases) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
      ai.enqueue(
        "receipt_extraction_v1",
        fakeExtraction({
          merchantName: "Price Test Superstore",
          orderNumber: p.orderNumber,
          purchaseDate: { iso_date: p.isoDate, approximate_text: null },
          totalAmountMinorUnits: p.unitPriceMinorUnits,
          currency: "USD",
          taxMinorUnits: null,
          shippingMinorUnits: null,
          lineItems: [{ productLabel: "Price Test Triple-Drop Widget", quantity: 1, unitPriceMinorUnits: p.unitPriceMinorUnits }],
          returnDeadline: null,
          confidenceNotes: "Clear receipt.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: `Your Price Test Superstore order ${p.orderNumber}`,
        bodyText: `Price Test Triple-Drop Widget x1, $${(p.unitPriceMinorUnits / 100).toFixed(2)}.`,
      });
    }

    const lines = await db
      .select({ line: schema.purchaseLines, purchase: schema.purchases })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const matching = lines.filter((l) => l.line.productLabel === "Price Test Triple-Drop Widget");
    expect(matching).toHaveLength(3);
    const first = matching.find((l) => l.line.unitPriceMinorUnits === 10_000)!;
    const second = matching.find((l) => l.line.unitPriceMinorUnits === 8_000)!;
    const third = matching.find((l) => l.line.unitPriceMinorUnits === 6_000)!;

    // Alert #1: filed when purchase #2 was ingested, anchored to purchase #1 (the only prior at that time).
    const obsOnFirst = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, first.line.id));
    expect(obsOnFirst).toHaveLength(1);
    expect(obsOnFirst[0]?.observedAmountMinorUnits).toBe(8_000);

    // Alert #2: filed when purchase #3 was ingested. The genuine assertion here is that it's anchored to
    // purchase #2 (the most recent prior purchase), NOT purchase #1 — a regression to "always compare
    // against the very first purchase" would instead put this observation on `first.line.id` and leave
    // `second.line.id` with none.
    const obsOnSecond = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, second.line.id));
    expect(obsOnSecond).toHaveLength(1);
    expect(obsOnSecond[0]?.observedAmountMinorUnits).toBe(6_000);

    // First purchase line must NOT have picked up a second, spurious observation from the third purchase.
    const obsOnFirstAfterThird = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, first.line.id));
    expect(obsOnFirstAfterThird).toHaveLength(1);

    // Third purchase line is the newest — nothing should ever be anchored to it as a "prior" purchase.
    const obsOnThird = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, third.line.id));
    expect(obsOnThird).toHaveLength(0);

    const inboxItems = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.category, "price_adjustment")));
    // Both cheaper repeats fire their own alert — not deduped/merged into one.
    expect(inboxItems.filter((i) => [first.purchase.id, second.purchase.id].includes(i.linkedResourceId ?? ""))).toHaveLength(2);
  });

  /**
   * Adversarial re-verification of PRICE_ADJUSTMENT_WINDOW_MS's exact boundary (30 * 86_400_000 ms, compared
   * with `<=`): a repeat purchase exactly 29 days after the original must fire, and one 31 days after must
   * not. Uses two independent products so the two cases can't interact with each other's window.
   */
  it("fires exactly at a 29-day gap and does not fire at a 31-day gap (30-day window boundary)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const cases = [
      {
        product: "Price Test Boundary Fires At 29 Days",
        purchases: [
          { orderNumber: "PADJ-B29-001", isoDate: "2026-01-01", unitPriceMinorUnits: 9_000 },
          { orderNumber: "PADJ-B29-002", isoDate: "2026-01-30", unitPriceMinorUnits: 7_000 }, // exactly 29 days later
        ],
        expectFire: true,
      },
      {
        product: "Price Test Boundary Does Not Fire At 31 Days",
        purchases: [
          { orderNumber: "PADJ-B31-001", isoDate: "2026-01-01", unitPriceMinorUnits: 9_000 },
          { orderNumber: "PADJ-B31-002", isoDate: "2026-02-01", unitPriceMinorUnits: 7_000 }, // exactly 31 days later
        ],
        expectFire: false,
      },
    ];

    for (const c of cases) {
      for (const p of c.purchases) {
        ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
        ai.enqueue(
          "receipt_extraction_v1",
          fakeExtraction({
            merchantName: "Price Test Superstore",
            orderNumber: p.orderNumber,
            purchaseDate: { iso_date: p.isoDate, approximate_text: null },
            totalAmountMinorUnits: p.unitPriceMinorUnits,
            currency: "USD",
            taxMinorUnits: null,
            shippingMinorUnits: null,
            lineItems: [{ productLabel: c.product, quantity: 1, unitPriceMinorUnits: p.unitPriceMinorUnits }],
            returnDeadline: null,
            confidenceNotes: "Clear receipt.",
          }),
        );
        await ingestion.ingestManualText({
          ownerUserId,
          householdId: null,
          subject: `Your Price Test Superstore order ${p.orderNumber}`,
          bodyText: `${c.product} x1, $${(p.unitPriceMinorUnits / 100).toFixed(2)}.`,
        });
      }
    }

    const lines = await db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));

    for (const c of cases) {
      const matching = lines.filter((l) => l.line.productLabel === c.product);
      expect(matching).toHaveLength(2);
      const original = matching.find((l) => l.line.unitPriceMinorUnits === 9_000)!;
      const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, original.line.id));
      expect(observations).toHaveLength(c.expectFire ? 1 : 0);
    }
  });

  /** Found live while auditing this session's own work: automation is a newer, less battle-tested
   * feature layered on top of an already-working ingestion pipeline via fileInboxItem's evaluateEvent
   * call — a bug there must never take down bill/purchase/etc. filing, which fileInboxItem's own
   * try/catch around that call now guarantees. */
  it("a throwing AutomationService does not prevent the bill from being filed", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    const throwingAutomation = { evaluateEvent: async () => { throw new Error("simulated automation bug"); } } as unknown as AutomationService;
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, throwingAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "Automation Resilience Test Co",
        amountDueMinorUnits: 4_242,
        currency: "USD",
        dueDate: { iso_date: "2026-10-01", approximate_text: null },
        autopayMentioned: false,
      }),
    );
    await expect(
      ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: "Your Automation Resilience Test Co bill",
        bodyText: "Amount due: $42.42. Due date: October 1, 2026.",
      }),
    ).resolves.not.toThrow();

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 4_242)).toBe(true);
  });
});
