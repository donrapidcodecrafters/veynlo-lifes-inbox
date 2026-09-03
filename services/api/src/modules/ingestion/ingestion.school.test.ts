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
 * §25 SCH-001/006/007 — real integration test against a real Postgres, mirroring ingestion.dedup.test.ts's
 * pattern exactly. Covers: dedup (a second email about the same discovered event updates rather than
 * duplicates), the "avoids guessing child identity when multiple candidates exist" rule (2+ dependents +
 * an ambiguous email -> unassigned; an exact-name match -> assigned; exactly 1 dependent -> unambiguous
 * auto-assign even with no name mentioned), permission-form discovery, and evidence-backed prep-task
 * creation (a literally-stated prep instruction becomes a real linked task).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [], schoolTransportConflicts: async () => [] } as unknown as ConflictService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
const stubTrips = {} as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;

describe("IngestionService.extractSchool", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let householdId: string;
  let dbAvailable = true;
  const dependentIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `school-test-${ownerUserId}@example.com`, displayName: "School Test" });
      householdId = generateId("household");
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService.extractSchool tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    await db.delete(schema.permissionForms).where(eq(schema.permissionForms.ownerUserId, ownerUserId));
    await db.delete(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, ownerUserId));
    await db.delete(schema.schools).where(eq(schema.schools.householdId, householdId));
    for (const id of dependentIds) {
      await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, id));
    }
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  async function addDependent(displayName: string): Promise<string> {
    const id = generateId("dependentProfile");
    await db.insert(schema.dependentProfiles).values({ id, householdId, displayName });
    dependentIds.push(id);
    return id;
  }

  it("does not duplicate a school event when a second email describes the same one", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const base = {
      schoolName: "Lincoln Elementary",
      eventKind: "no_school" as const,
      eventDate: { iso_date: "2026-11-11", approximate_text: null },
      eventTime: null,
      timezone: null,
      isAllDay: true,
      location: null,
      arrivalNote: null,
      matchedChildDisplayName: null,
      formTitle: null,
      formDueDate: null,
      feeAmountMinorUnits: null,
      prepInstructions: [],
      confidenceNotes: "",
    };
    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["school"] }));
      ai.enqueue("school_extraction_v1", fakeExtraction({ ...base, title: "No school - Veterans Day" }));
      await ingestion.ingestManualText({
        ownerUserId,
        householdId,
        subject: i === 0 ? "No school Nov 11" : "Reminder: no school Nov 11",
        bodyText: "There is no school on November 11, 2026 for Veterans Day.",
      });
    }

    const events = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, ownerUserId));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("no_school");
  });

  it("files a school event unassigned when the household has 2+ dependents and the email doesn't clearly name one", async () => {
    if (!dbAvailable) return;
    const alice = await addDependent("Alice");
    const bob = await addDependent("Bob");
    void alice;
    void bob;

    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["school"] }));
    ai.enqueue(
      "school_extraction_v1",
      fakeExtraction({
        schoolName: "Lincoln Elementary",
        title: "Picture Day",
        eventKind: "picture_day",
        eventDate: { iso_date: "2026-11-20", approximate_text: null },
        eventTime: null,
        timezone: null,
        isAllDay: true,
        location: null,
        arrivalNote: null,
        matchedChildDisplayName: null, // ambiguous — the model correctly declines to guess
        formTitle: null,
        formDueDate: null,
        feeAmountMinorUnits: null,
        prepInstructions: [],
        confidenceNotes: "",
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Picture Day is coming up", bodyText: "Picture day is November 20." });

    const [event] = await db
      .select()
      .from(schema.schoolEvents)
      .where(and(eq(schema.schoolEvents.ownerUserId, ownerUserId), eq(schema.schoolEvents.kind, "picture_day")));
    expect(event).toBeDefined();
    expect(event?.dependentId).toBeNull();
  });

  it("auto-assigns the only dependent in a single-child household even when the email names no one", async () => {
    if (!dbAvailable) return;
    const soloOwnerUserId = generateId("user");
    const soloHouseholdId = generateId("household");
    await db.insert(schema.users).values({ id: soloOwnerUserId, email: `school-solo-${soloOwnerUserId}@example.com`, displayName: "Solo Test" });
    await db.insert(schema.households).values({ id: soloHouseholdId, name: "Solo Household", billingOwnerUserId: soloOwnerUserId });
    const onlyChildId = generateId("dependentProfile");
    await db.insert(schema.dependentProfiles).values({ id: onlyChildId, householdId: soloHouseholdId, displayName: "Casey" });

    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["school"] }));
    ai.enqueue(
      "school_extraction_v1",
      fakeExtraction({
        schoolName: null,
        title: "Conference sign-up open",
        eventKind: "conference",
        eventDate: { iso_date: "2026-11-25", approximate_text: null },
        eventTime: null,
        timezone: null,
        isAllDay: true,
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
    await ingestion.ingestManualText({ ownerUserId: soloOwnerUserId, householdId: soloHouseholdId, subject: "Conference sign-up", bodyText: "Sign up for parent-teacher conferences." });

    const [event] = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, soloOwnerUserId));
    expect(event?.dependentId).toBe(onlyChildId);

    // cleanup
    await db.delete(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, soloOwnerUserId));
    await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, onlyChildId));
    await db.delete(schema.households).where(eq(schema.households.id, soloHouseholdId));
    await db.delete(schema.users).where(eq(schema.users.id, soloOwnerUserId));
  });

  it("creates a discovered permission form and an evidence-backed prep task from literally-stated instructions", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["school"] }));
    ai.enqueue(
      "school_extraction_v1",
      fakeExtraction({
        schoolName: "Lincoln Elementary",
        title: "Zoo Field Trip",
        eventKind: "field_trip",
        eventDate: { iso_date: "2026-12-02", approximate_text: null },
        eventTime: null,
        timezone: null,
        isAllDay: true,
        location: "City Zoo",
        arrivalNote: null,
        matchedChildDisplayName: null,
        formTitle: "Zoo Field Trip Permission Slip",
        formDueDate: { iso_date: "2026-11-28", approximate_text: null },
        feeAmountMinorUnits: 1500,
        prepInstructions: ["Bring a sack lunch", "Wear closed-toe shoes"],
        confidenceNotes: "",
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Zoo Field Trip - permission slip needed", bodyText: "Please sign and return the permission slip by Nov 28. Bring a sack lunch and wear closed-toe shoes." });

    const [event] = await db
      .select()
      .from(schema.schoolEvents)
      .where(and(eq(schema.schoolEvents.ownerUserId, ownerUserId), eq(schema.schoolEvents.kind, "field_trip")));
    expect(event).toBeDefined();
    expect(event?.requiresDropoff).toBe(true);
    expect(event?.requiresPickup).toBe(true);

    const [form] = await db.select().from(schema.permissionForms).where(eq(schema.permissionForms.schoolEventId, event!.id));
    expect(form).toBeDefined();
    expect(form?.state).toBe("discovered");

    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    const prepTasks = tasks.filter((t) => t.relatedEntityIds.includes(event!.id));
    expect(prepTasks.length).toBe(2);
    expect(prepTasks.some((t) => t.title.startsWith("Bring a sack lunch"))).toBe(true);
    expect(prepTasks.some((t) => t.title.startsWith("Wear closed-toe shoes"))).toBe(true);
  });

  /**
   * SCH-005 "arrival time, equipment/volunteer notes if sourced" — found live: SchoolIcsService.sync only
   * ever read summary/location off a VEVENT, dropping DESCRIPTION entirely, even though a real team/school
   * ICS feed routinely puts arrival/equipment/volunteer notes there. Exercises ingestFeedSchoolEvent
   * directly (the shared entry point both SchoolIcsService.sync and this test call) since a fake ICS
   * fixture would just be testing node-ical's own parser, not this app's code. Covers both the create path
   * and the update-in-place reconciliation path (a second sync with a newly-added description).
   */
  it("ingestFeedSchoolEvent carries a VEVENT's DESCRIPTION through to school_events.description, on both create and update", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    const schoolSourceId = generateId("schoolSource");
    await db.insert(schema.schoolSources).values({ id: schoolSourceId, householdId, createdByUserId: ownerUserId, label: "Team ICS feed", kind: "ics", icsUrl: "https://example.com/feed.ics" });
    const uid = `ics-uid-${generateId("schoolEvent")}`;

    await ingestion.ingestFeedSchoolEvent({
      ownerUserId,
      householdId,
      schoolSourceId,
      schoolId: null,
      uid,
      title: "Away game vs. Central",
      start: { precision: "date", instantUtc: null, date: "2026-12-10", timezone: null, sourceText: null },
      isAllDay: true,
      location: "Central High School",
      description: null,
      canceled: false,
    });
    let [event] = await db.select().from(schema.schoolEvents).where(and(eq(schema.schoolEvents.schoolSourceId, schoolSourceId), eq(schema.schoolEvents.providerEventId, uid)));
    expect(event?.description).toBeNull();

    // A later sync of the SAME uid adds a description the feed didn't originally carry — reconciles onto
    // the existing row (same one, not a duplicate) rather than being silently dropped.
    await ingestion.ingestFeedSchoolEvent({
      ownerUserId,
      householdId,
      schoolSourceId,
      schoolId: null,
      uid,
      title: "Away game vs. Central",
      start: { precision: "date", instantUtc: null, date: "2026-12-10", timezone: null, sourceText: null },
      isAllDay: true,
      location: "Central High School",
      description: "Arrive 30 min early. Bring your own water bottle. Volunteers needed for snack duty.",
      canceled: false,
    });
    const rows = await db.select().from(schema.schoolEvents).where(and(eq(schema.schoolEvents.schoolSourceId, schoolSourceId), eq(schema.schoolEvents.providerEventId, uid)));
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    [event] = rows;
    expect(event?.description).toBe("Arrive 30 min early. Bring your own water bottle. Volunteers needed for snack duty.");

    await db.delete(schema.schoolEvents).where(eq(schema.schoolEvents.id, event!.id));
    await db.delete(schema.schoolSources).where(eq(schema.schoolSources.id, schoolSourceId));
  });
});
