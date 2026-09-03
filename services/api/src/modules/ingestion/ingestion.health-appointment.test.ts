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
 * §27 "Health Logistics (Non-Diagnostic)" (HLTH-001) — real end-to-end coverage of
 * IngestionService.extractHealthAppointment via the public ingestManualText entry point, mirroring
 * ingestion.dedup.test.ts's own pattern. Proves three things a unit test on the schema alone couldn't:
 * (1) a discovered appointment is filed into `health_appointments`, never `calendar_events`, so it never
 * accidentally inherits calendar_events' plain-household-membership visibility; (2) `prepInstructions` is
 * copied through verbatim when the (fake, but schema-shaped) model returns one, and stays null when it
 * doesn't — never synthesized by the write path itself; (3) CAL-004-style reschedule reconciliation dedups
 * a second email about the same appointment instead of creating a sibling.
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

describe("IngestionService.extractHealthAppointment", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `hlth-ingest-${ownerUserId}@example.com`, displayName: "Health Ingest Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService.extractHealthAppointment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
      await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("files a discovered appointment into health_appointments (never calendar_events), private by default, with prepInstructions passed through only when the model actually returned one", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["health_appointment"] }));
    ai.enqueue(
      "health_appointment_extraction_v1",
      fakeExtraction({
        providerName: "Dr. Chen",
        appointmentType: "dental",
        startDate: { iso_date: "2026-10-20", approximate_text: null },
        startTime: "09:30",
        timezone: "America/Los_Angeles",
        location: "456 Oak St",
        prepInstructions: "Arrive 15 minutes early to complete paperwork",
        confidenceNotes: "clear",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Appointment confirmed with Dr. Chen",
      bodyText: "Your dental appointment is confirmed for Oct 20, 2026 at 9:30am. Arrive 15 minutes early to complete paperwork.",
    });

    const appointments = await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.providerName).toBe("Dr. Chen");
    expect(appointments[0]?.appointmentType).toBe("dental");
    expect(appointments[0]?.prepInstructions).toBe("Arrive 15 minutes early to complete paperwork");
    expect(appointments[0]?.visibility).toBe("private");
    expect(appointments[0]?.source).toBe("discovered_from_evidence");

    // Never leaked into calendar_events — a household member with only ordinary "shared calendar"
    // visibility must never be able to see this via the wrong table.
    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(events).toHaveLength(0);
  });

  it("leaves prepInstructions null when the model doesn't return one — never synthesizes a generic instruction for the appointment type", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["health_appointment"] }));
    ai.enqueue(
      "health_appointment_extraction_v1",
      fakeExtraction({
        providerName: "Quest Diagnostics",
        appointmentType: "lab work",
        startDate: { iso_date: "2026-11-02", approximate_text: null },
        startTime: null,
        timezone: null,
        location: null,
        prepInstructions: null, // the source text never said "fast beforehand" — must stay null, never inferred
        confidenceNotes: "clear",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Lab work scheduled",
      bodyText: "Your lab work with Quest Diagnostics is scheduled for Nov 2, 2026.",
    });

    const appointments = await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
    const labAppointment = appointments.find((a) => a.providerName === "Quest Diagnostics");
    expect(labAppointment?.prepInstructions).toBeNull();
  });

  it("a second email about the same appointment updates the existing row instead of creating a sibling (CAL-004-style reconciliation)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    for (const location of ["100 First Ave", "200 Second Ave — location changed"]) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["health_appointment"] }));
      ai.enqueue(
        "health_appointment_extraction_v1",
        fakeExtraction({
          providerName: "Dr. Patel",
          appointmentType: "primary care",
          startDate: { iso_date: "2026-12-05", approximate_text: null },
          startTime: "14:00",
          timezone: "America/New_York",
          location,
          prepInstructions: null,
          confidenceNotes: "clear",
        }),
      );
      await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Appointment with Dr. Patel", bodyText: `Your appointment is at ${location}.` });
    }

    const appointments = await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
    const patelAppointments = appointments.filter((a) => a.providerName === "Dr. Patel");
    expect(patelAppointments).toHaveLength(1);
    expect(patelAppointments[0]?.location).toBe("200 Second Ave — location changed");
  });

  it("does not extract at all when health_logistics entitlement is false (free plan)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    const freeEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => false } as unknown as EntitlementsService;
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, freeEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["health_appointment"] }));
    ai.enqueue(
      "health_appointment_extraction_v1",
      fakeExtraction({ providerName: "Should not be filed", appointmentType: null, startDate: { iso_date: "2026-12-25", approximate_text: null }, startTime: null, timezone: null, location: null, prepInstructions: null, confidenceNotes: "" }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Appointment", bodyText: "body" });

    const appointments = await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
    expect(appointments.find((a) => a.providerName === "Should not be filed")).toBeUndefined();
  });
});
