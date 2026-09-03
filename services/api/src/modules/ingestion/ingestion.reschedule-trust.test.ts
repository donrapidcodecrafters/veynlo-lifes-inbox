import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { InboxService } from "../attention/inbox.service";
import { ConflictService } from "../schedule/conflict.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { HouseholdService } from "../household/household.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — a follow-up audit
 * found `extractCalendarEvent`'s reschedule-reconciliation update branch (ingestion.dedup.test.ts's own
 * CAL-004 dedup fix) always silently overwrote the existing event's date/time/location the instant a
 * second email matched it, with no "offer, don't apply" step and no trusted-rule concept anywhere in this
 * codebase. This is the real, buildable fix: a match with NO trusted rule for the sender's domain files an
 * attention item OFFERING the change (`calendarRescheduleProposals` + `["apply_change", "dismiss"]`
 * suggestedActions) and leaves the existing row untouched; a match WITH a trusted rule auto-applies exactly
 * as before (covered by ingestion.dedup.test.ts's own updated test). This file covers: the offer path
 * itself, applying an offered change via InboxService.applyRescheduleChange, and the "Always trust..."
 * opt-in that lets the NEXT reschedule from that sender auto-apply instead of being offered again.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
// Never touches a household-shared event in these tests, so the real ConflictService's HouseholdService
// dependency is never actually invoked (only reached when calendarEvents.householdId is set).
const stubHouseholds = {} as HouseholdService;
const stubCalendarWriteBack = { pushEvent: async () => ({ pushed: true }) } as unknown as CalendarWriteBackService;

describe("CAL-004 reschedule reconciliation — offer, don't auto-apply without a trusted rule", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let inbox: InboxService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `reschedule-trust-${ownerUserId}@example.com`, displayName: "Reschedule Trust Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CAL-004 trust tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function seedDiscoveredEvent(title: string, isoDate: string) {
    const eventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title,
      start: { precision: "date", instantUtc: null, date: isoDate, timezone: null, sourceText: null },
      startSort: new Date(`${isoDate}T00:00:00Z`),
      isAllDay: false,
      source: "discovered_from_evidence",
      status: "confirmed",
      visibility: "private",
      reminderMinutesBefore: 60,
    });
    return eventId;
  }

  it("files an offered change (never auto-applies) when no trusted rule covers the sender's domain", async () => {
    if (!dbAvailable) return;
    const eventId = await seedDiscoveredEvent("United flight 482", "2026-11-01");
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, new ConflictService(db, stubHouseholds), stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "United flight 482",
        startDate: { iso_date: "2026-11-03", approximate_text: null },
        startTime: "09:00",
        timezone: "America/Denver",
        location: "Gate B12",
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "notifications@united.com",
      subject: "Your flight has been rescheduled",
      bodyText: "United flight 482 has moved to 2026-11-03 at 9:00 AM, Gate B12.",
    });

    // The existing row must be completely untouched — still the ORIGINAL date.
    const [event] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect((event?.start as { date?: string } | null)?.date).toBe("2026-11-01");
    expect(event?.location).toBeNull();

    // No sibling row was created either — this is still a "match found", just not auto-applied.
    const allMatching = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(allMatching.filter((e) => e.title === "United flight 482")).toHaveLength(1);

    const [inboxItem] = await db
      .select()
      .from(schema.inboxItems)
      .where(eq(schema.inboxItems.linkedResourceId, eventId));
    expect(inboxItem).toBeTruthy();
    expect(inboxItem?.suggestedActions).toEqual(["apply_change", "dismiss"]);

    const [proposal] = await db.select().from(schema.calendarRescheduleProposals).where(eq(schema.calendarRescheduleProposals.calendarEventId, eventId));
    expect(proposal).toBeTruthy();
    expect((proposal?.proposedStart as { date?: string } | null)?.date).toBe("2026-11-03");
    expect(proposal?.proposedLocation).toBe("Gate B12");
    expect(proposal?.senderDomain).toBe("united.com");

    // Applying the offered change now actually moves the event, and "trust this sender" creates a rule.
    inbox = new InboxService(db, stubCalendarWriteBack, new ConflictService(db, stubHouseholds));
    const result = await inbox.applyRescheduleChange(inboxItem!.id, ownerUserId, { trustSender: true });
    expect(result.trustedSenderAdded).toBe(true);

    const [updatedEvent] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect((updatedEvent?.start as { date?: string } | null)?.date).toBe("2026-11-03");
    expect(updatedEvent?.location).toBe("Gate B12");

    const [confirmedItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, inboxItem!.id));
    expect(confirmedItem?.reviewState).toBe("confirmed");

    const [trustedRule] = await db
      .select()
      .from(schema.calendarRescheduleTrustedRules)
      .where(eq(schema.calendarRescheduleTrustedRules.ownerUserId, ownerUserId));
    expect(trustedRule?.senderDomain).toBe("united.com");
  });

  it("auto-applies the very next reschedule from that now-trusted sender, with no offer filed", async () => {
    if (!dbAvailable) return;
    // Depends on the previous test having created a "united.com" trusted rule for this owner — real
    // end-to-end proof that trusting a sender actually changes behavior on a SUBSEQUENT email, not just a
    // one-off flag nothing reads.
    const eventId = await seedDiscoveredEvent("United flight 900", "2026-12-01");
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, new ConflictService(db, stubHouseholds), stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "United flight 900",
        startDate: { iso_date: "2026-12-02", approximate_text: null },
        startTime: "07:00",
        timezone: "America/Denver",
        location: "Gate A1",
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "notifications@united.com",
      subject: "Your flight has been rescheduled",
      bodyText: "United flight 900 has moved to 2026-12-02 at 7:00 AM, Gate A1.",
    });

    const [event] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect((event?.start as { date?: string } | null)?.date).toBe("2026-12-02"); // auto-applied

    const [inboxItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.linkedResourceId, eventId));
    expect(inboxItem?.suggestedActions).toEqual(["confirm", "dismiss"]); // not an offer this time

    const proposals = await db.select().from(schema.calendarRescheduleProposals).where(eq(schema.calendarRescheduleProposals.calendarEventId, eventId));
    expect(proposals).toHaveLength(0);
  });

  it("lets a user add/remove a trusted-sender rule directly, independent of any offered item", async () => {
    if (!dbAvailable) return;
    inbox = new InboxService(db, stubCalendarWriteBack, new ConflictService(db, stubHouseholds));
    const added = await inbox.addTrustedRescheduleRule(ownerUserId, "Delta.com");
    expect(added.senderDomain).toBe("delta.com"); // normalized

    let rules = await inbox.listTrustedRescheduleRules(ownerUserId);
    expect(rules.some((r) => r.senderDomain === "delta.com")).toBe(true);

    await inbox.removeTrustedRescheduleRule(added.id, ownerUserId);
    rules = await inbox.listTrustedRescheduleRules(ownerUserId);
    expect(rules.some((r) => r.senderDomain === "delta.com")).toBe(false);
  });
});
