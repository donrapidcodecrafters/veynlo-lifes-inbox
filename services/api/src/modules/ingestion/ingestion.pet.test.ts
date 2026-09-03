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
 * Real-DB coverage for Chapter 28 "Pets" ingestion (PET-002 vet/grooming appointments, PET-004 vaccination/
 * license discovery) — same harness as ingestion.dedup.test.ts, focused on the two properties that matter
 * most for this feature: (1) conservative, "don't guess" pet-identity matching in a multi-pet household
 * (mirroring extractSchool's child-matching discipline), and (2) PET-004's "deadline must be
 * sourced/user-confirmed" — a discovered vaccination never lands as an already-confirmed row.
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

describe("IngestionService pet extraction", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `pet-ingest-test-${ownerUserId}@example.com`, displayName: "Pet Ingest Test" });
      await db.insert(schema.households).values({ id: householdId, name: "Pet Ingest Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping pet ingestion tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("resolves the pet automatically when the household has exactly one, with no name mentioned", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    const { id: petId } = await db
      .insert(schema.petProfiles)
      .values({ id: generateId("pet"), ownerUserId, householdId, label: "Rex" })
      .returning({ id: schema.petProfiles.id })
      .then((rows) => rows[0]!);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["pet"] }));
    ai.enqueue(
      "pet_event_extraction_v1",
      fakeExtraction({
        petNameHint: null,
        title: "Vet checkup",
        eventType: "vet checkup",
        providerName: "Maple Street Vet",
        startDate: { iso_date: "2026-10-05", approximate_text: null },
        startTime: "10:00",
        timezone: "America/Los_Angeles",
        location: "Maple Street Vet Clinic",
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Your vet appointment is confirmed", bodyText: "Vet checkup on Oct 5 at 10am." });

    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const petEvents = events.filter((e) => e.source === "pet");
    expect(petEvents).toHaveLength(1);
    expect(petEvents[0]?.relatedEntityIds).toEqual([petId]);

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, petEvents[0]!.id));
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
  });

  it("in a multi-pet household, files the event UNASSIGNED (never guesses) when no pet name is stated", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    const petRows = await db
      .insert(schema.petProfiles)
      .values([
        { id: generateId("pet"), ownerUserId, householdId, label: "Rex" },
        { id: generateId("pet"), ownerUserId, householdId, label: "Whiskers" },
      ])
      .returning({ id: schema.petProfiles.id });

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["pet"] }));
    ai.enqueue(
      "pet_event_extraction_v1",
      fakeExtraction({
        petNameHint: null, // model correctly declined to guess
        title: "Grooming appointment",
        eventType: "grooming",
        providerName: "Pawsh Grooming",
        startDate: { iso_date: "2026-10-06", approximate_text: null },
        startTime: null,
        timezone: null,
        location: null,
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Grooming confirmed", bodyText: "Grooming on Oct 6." });

    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const petEvent = events.find((e) => e.source === "pet" && e.title === "Grooming appointment");
    expect(petEvent?.relatedEntityIds).toEqual([]); // unassigned, not a guess

    const [inboxItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.linkedResourceId, petEvent!.id));
    expect(inboxItem?.suggestedActions).toContain("assign_pet");

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, petEvent!.id));
    await db.delete(schema.petProfiles).where(
      eq(schema.petProfiles.id, petRows[0]!.id),
    );
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petRows[1]!.id));
  });

  it("in a multi-pet household, resolves the pet when the source text names it exactly", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    const petRows = await db
      .insert(schema.petProfiles)
      .values([
        { id: generateId("pet"), ownerUserId, householdId, label: "Rex" },
        { id: generateId("pet"), ownerUserId, householdId, label: "Whiskers" },
      ])
      .returning({ id: schema.petProfiles.id, label: schema.petProfiles.label });
    const whiskersId = petRows.find((p) => p.label === "Whiskers")!.id;

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["pet"] }));
    ai.enqueue(
      "pet_event_extraction_v1",
      fakeExtraction({
        petNameHint: "Whiskers",
        title: "Annual checkup",
        eventType: "vet checkup",
        providerName: "Maple Street Vet",
        startDate: { iso_date: "2026-11-01", approximate_text: null },
        startTime: null,
        timezone: null,
        location: null,
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Whiskers' checkup confirmed", bodyText: "Whiskers' annual checkup on Nov 1." });

    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const petEvent = events.find((e) => e.source === "pet" && e.title === "Annual checkup");
    expect(petEvent?.relatedEntityIds).toEqual([whiskersId]);

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, petEvent!.id));
    for (const p of petRows) await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, p.id));
  });

  it("PET-004: files a discovered vaccination as evidence_sourced, never a confirmed deadline, until InboxService.confirm promotes it", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    const { id: petId } = await db
      .insert(schema.petProfiles)
      .values({ id: generateId("pet"), ownerUserId, householdId, label: "Rex" })
      .returning({ id: schema.petProfiles.id })
      .then((rows) => rows[0]!);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["pet"] }));
    ai.enqueue(
      "pet_vaccination_extraction_v1",
      fakeExtraction({ petNameHint: null, label: "Rabies", expirationDate: { iso_date: "2027-02-01", approximate_text: null } }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId, subject: "Rabies vaccination reminder", bodyText: "Rex's rabies vaccine expires Feb 1, 2027." });

    const [vaccination] = await db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.ownerUserId, ownerUserId));
    expect(vaccination?.source).toBe("evidence_sourced");
    expect(vaccination?.petProfileId).toBe(petId); // only one pet — unambiguous even with no name stated

    await db.delete(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccination!.id));
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
  });
});
