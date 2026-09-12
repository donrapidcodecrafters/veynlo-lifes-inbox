import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
 * DEF-102 — the extracted appointment TIME must survive ingestion.
 *
 * Four extraction schemas declare `startTime` ("HH:MM 24-hour, in the timezone below") and, until this was
 * fixed, nothing anywhere read any of them: every temporal was built by `toTemporalValue(date, timezone)`,
 * which has no time parameter. A 2:00 PM appointment was stored as a bare date with `startSort` at UTC
 * midnight, and every feature keyed off `startSort` inherited that — CAL-002 reminders fired ~22 hours
 * early, CAL-001 cross-source linking (a +/-3h window) could only ever match appointments near UTC
 * midnight, and CAL-004's reschedule window dropped events up to a day early.
 *
 * These assert the INSTANT, not just "precision changed", because an instant that is present but wrong is
 * the failure mode that would look fixed. Each expected value is the real UTC time of that wall clock in
 * that zone, computed by hand:
 *
 *     14:00 America/Los_Angeles on a September date  =  21:00Z  (PDT, UTC-7)
 *     09:30 America/New_York     on a September date  =  13:30Z  (EDT, UTC-4)
 *
 * Dates are relative to now and never pinned. The reschedule/upcoming windows these paths run through are
 * measured against the clock, so a hardcoded date silently stops testing ingestion and starts testing the
 * window — which is exactly how ingestion.dedup.test.ts came to fail on a commit that touched nothing near
 * it, the morning after the date it was pinned to.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** A date a few days out, so nothing here depends on when it is run. */
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("DEF-102 — an extracted appointment keeps its time of day", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `apptime-${ownerUserId}@example.com`,
        displayName: "Appointment Time Test",
        timezone: "America/New_York",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DEF-102 tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  function fresh() {
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
  }

  async function eventsTitled(title: string) {
    const rows = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    return rows.filter((r) => r.title === title);
  }

  it("a calendar event states the instant its stated time falls on, not midnight", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(4);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Alignment with the roofer",
        startDate: { iso_date: date, approximate_text: null },
        startTime: "14:00",
        timezone: "America/Los_Angeles",
        location: "123 Clinic Way",
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "scheduling@roofers.example",
      subject: "Your appointment is confirmed",
      bodyText: `Alignment with the roofer on ${date} at 2:00 PM.`,
    });

    const [event] = await eventsTitled("Alignment with the roofer");
    expect(event).toBeDefined();
    const start = event!.start as { precision?: string; instantUtc?: string | null; date?: string | null };
    expect(start.precision).toBe("instant");
    expect(start.instantUtc).toBe(`${date}T21:00:00.000Z`);
    // The sort key is what reminders, ordering and every matching window actually read.
    expect(event!.startSort?.toISOString()).toBe(`${date}T21:00:00.000Z`);
  });

  it("falls back to the OWNER's zone when the email named a time but no zone", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(5);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Parent-teacher conference",
        startDate: { iso_date: date, approximate_text: null },
        startTime: "09:30",
        timezone: null,
        location: null,
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "office@school.example",
      subject: "Conference time",
      bodyText: `Parent-teacher conference on ${date} at 9:30 AM.`,
    });

    const [event] = await eventsTitled("Parent-teacher conference");
    expect(event).toBeDefined();
    // The user's stored zone is America/New_York, so 09:30 local is 13:30Z in September.
    expect((event!.start as { instantUtc?: string | null }).instantUtc).toBe(`${date}T13:30:00.000Z`);
  });

  it("still refuses to invent an instant when the email gave a date and no time", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(6);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Bulk waste collection",
        startDate: { iso_date: date, approximate_text: null },
        startTime: null,
        timezone: "America/Los_Angeles",
        location: null,
        isAllDay: true,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "notices@city.example",
      subject: "Collection notice",
      bodyText: `Bulk waste collection on ${date}.`,
    });

    const [event] = await eventsTitled("Bulk waste collection");
    expect(event).toBeDefined();
    const start = event!.start as { precision?: string; instantUtc?: string | null };
    expect(start.precision).toBe("date");
    expect(start.instantUtc).toBeNull();
  });

  it("an all-day event never gains an instant, even when the model answers with a time as well", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(9);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "School closed for in-service",
        startDate: { iso_date: date, approximate_text: null },
        // The schema declares isAllDay and startTime independently, so a model CAN answer both. Nothing
        // forbids it, and the resulting row would have the reminder default, the display and the
        // write-back all disagreeing about whether this event has a time.
        startTime: "09:00",
        timezone: "America/New_York",
        location: null,
        isAllDay: true,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "office@school.example",
      subject: "No school",
      bodyText: `School closed for in-service on ${date}.`,
    });

    const [event] = await eventsTitled("School closed for in-service");
    expect(event).toBeDefined();
    expect(event!.isAllDay).toBe(true);
    const start = event!.start as { precision?: string; instantUtc?: string | null };
    expect(start.precision).toBe("date");
    expect(start.instantUtc).toBeNull();
  });
  it("a school event keeps its time — the field is called eventTime, and the defect was never about the name", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(8);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["school"] }));
    ai.enqueue(
      "school_extraction_v1",
      fakeExtraction({
        title: "Picture day",
        schoolName: "Lincoln Elementary",
        eventKind: "other" as const,
        eventDate: { iso_date: date, approximate_text: null },
        eventTime: "09:00",
        timezone: "America/New_York",
        isAllDay: false,
        location: null,
        arrivalNote: null,
        matchedChildDisplayName: null,
        formTitle: null,
        formDueDate: null,
        feeAmountMinorUnits: null,
        prepInstructions: [],
        confidenceNotes: "",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "office@school.example",
      subject: "Picture day",
      bodyText: `Picture day is on ${date} at 9:00 AM.`,
    });

    const rows = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, ownerUserId));
    const picture = rows.find((r) => r.title === "Picture day");
    expect(picture).toBeDefined();
    // 09:00 America/New_York in September is 13:00Z.
    expect((picture!.start as { instantUtc?: string | null }).instantUtc).toBe(`${date}T13:00:00.000Z`);
  });
  it("a health appointment keeps its time too — the rule is not calendar-only", async () => {
    if (!dbAvailable) return;
    fresh();
    const date = dayFromNow(7);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["health_appointment"] }));
    ai.enqueue(
      "health_appointment_extraction_v1",
      fakeExtraction({
        providerName: "Dr. Alvarez",
        appointmentType: "primary care",
        startDate: { iso_date: date, approximate_text: null },
        startTime: "09:30",
        timezone: "America/New_York",
        location: "12 Health Way",
        prepInstructions: null,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      fromAddress: "scheduling@clinic.example",
      subject: "Appointment confirmed",
      bodyText: `Dr. Alvarez on ${date} at 9:30 AM.`,
    });

    const rows = await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
    expect(rows.length).toBeGreaterThan(0);
    const appt = rows[rows.length - 1]!;
    expect((appt.dateTime as { instantUtc?: string | null }).instantUtc).toBe(`${date}T13:30:00.000Z`);
  });
});
