import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { SearchService } from "./search.service";
import { SearchIndexService } from "./search-index.service";
import { MemoriesService } from "../memories/memories.service";
import { SharingService } from "../sharing/sharing.service";
import { GraphService } from "../graph/graph.service";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { DocumentsService } from "../documents/documents.service";
import type { HouseholdService } from "../household/household.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { PreferencesService } from "../preferences/preferences.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

function dateTemporal(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: null };
}

// structuredSearch never calls the AI provider or entitlements service, so these are unused stubs — only
// present because SearchService's constructor requires them.
const stubAi = {} as unknown as ModelProvider;
const stubEntitlements = {} as unknown as EntitlementsService;
const stubDocuments = {} as unknown as DocumentsService;
const stubHouseholds = {} as unknown as HouseholdService;
const stubQueue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
const stubPreferences = { getAskResponseStyle: async () => "balanced" as const } as unknown as PreferencesService;

/**
 * §ASK-002 "Search offers instant suggestions across people, objects, documents, dates, merchants,
 * places, tags, and exact identifiers" — found live via a fresh audit: `structuredSearch` only ever
 * covered the four domains present when it was first written (purchases/bills/documents/events).
 * `ask()` had separately been extended to also ground warranties/subscriptions/shipments/return_cases,
 * but structured search was never brought up to parity, and NONE of the Phase 3 domains (trips, saved
 * memories, pets, health appointments) were ever added to either endpoint — a search for a trip
 * destination, a saved product idea, a pet's name, or a doctor's name silently returned nothing even
 * though the exact matching row genuinely exists and is owned by the searching user. This proves both the
 * newly added Phase 3 domains AND the warranty/subscription/shipment/return-case parity fix actually work
 * against real inserted rows, and that a search scoped to one owner never leaks another owner's row.
 *
 * §44.4 "Search architecture" update — `structuredSearch` now queries `search_documents` (real Postgres
 * full-text search) instead of substring-matching a bulk fetch of each domain's own table, so every fixture
 * below also gets a `SearchIndexService.upsert(...)` call right after its raw domain-table insert — the
 * exact same call every real wired domain service (TripsService.createManualTrip, PetsService.create, etc.
 * — see search-index.service.ts's own doc comment) makes from its own create path. The raw domain-table
 * rows are still inserted too: `structuredSearch` hydrates full entity objects (merchant names, joined
 * subscription/return-case fields, etc.) from the real tables once `search_documents` has told it which
 * ids matched.
 */
describe("SearchService.structuredSearch — domain coverage", () => {
  let db: Database;
  let search: SearchService;
  let searchIndex: SearchIndexService;
  let ownerUserId: string;
  let otherUserId: string;
  let memoryId: string;
  let relatedMemoryId: string;
  let dbAvailable = true;

  const cleanup: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    const memories = new MemoriesService(db, stubAi, stubQueue, stubDocuments, stubHouseholds, sharing);
    search = new SearchService(db, stubAi, stubEntitlements, memories, stubPreferences, new GraphService(db));
    searchIndex = new SearchIndexService(db);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `search-cov-${ownerUserId}@example.com`, displayName: "Search Coverage Test User" },
        { id: otherUserId, email: `search-cov-other-${otherUserId}@example.com`, displayName: "Other User" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping SearchService domain-coverage tests — no reachable dev Postgres:", (err as Error).message);
      return;
    }

    // Trip — owned by the searching user, findable by destination.
    const tripId = generateId("trip");
    await db.insert(schema.trips).values({ id: tripId, ownerUserId, label: "Anniversary getaway", destinationLabel: "Lisbon, Portugal", status: "upcoming" });
    await searchIndex.upsert({ resourceType: "trip", resourceId: tripId, ownerUserId, sensitivity: "sensitive", title: "Anniversary getaway", bodyText: "Lisbon, Portugal" });
    cleanup.push(async () => db.delete(schema.trips).where(eq(schema.trips.id, tripId)));

    // Saved memory — findable by title and by notes.
    memoryId = generateId("savedMemory");
    await db.insert(schema.savedMemories).values({
      id: memoryId,
      ownerUserId,
      sourceKind: "product",
      title: "Weber Genesis grill",
      userNotes: "Dad mentioned wanting this for Father's Day",
      classificationState: "classified",
      extractedFields: {},
      tags: [],
      highlights: [],
    });
    await searchIndex.upsert({
      resourceType: "saved_memory",
      resourceId: memoryId,
      ownerUserId,
      sensitivity: "standard",
      title: "Weber Genesis grill",
      bodyText: "Dad mentioned wanting this for Father's Day",
    });
    cleanup.push(async () => db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId)));

    // A second saved memory, related-but-not-a-direct-hit to the "weber genesis grill" query below — it
    // shares the word "grill" (in its notes) but not "weber"/"genesis", so a direct title/notes substring
    // search for "weber genesis" won't match it, while the SAVE-004 query-based related-items pass (lexical
    // overlap, not substring) should still surface it as "you might also want to revisit."
    relatedMemoryId = generateId("savedMemory");
    await db.insert(schema.savedMemories).values({
      id: relatedMemoryId,
      ownerUserId,
      sourceKind: "note",
      title: "Backyard grill accessories",
      userNotes: "Tongs and a cover for the grill",
      classificationState: "classified",
      extractedFields: {},
      tags: [],
      highlights: [],
    });
    await searchIndex.upsert({
      resourceType: "saved_memory",
      resourceId: relatedMemoryId,
      ownerUserId,
      sensitivity: "standard",
      title: "Backyard grill accessories",
      bodyText: "Tongs and a cover for the grill",
    });
    cleanup.push(async () => db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, relatedMemoryId)));

    // Pet — findable by name.
    const petId = generateId("pet");
    await db.insert(schema.petProfiles).values({ id: petId, ownerUserId, label: "Rex", species: "dog", breed: "Labrador" });
    await searchIndex.upsert({ resourceType: "pet", resourceId: petId, ownerUserId, sensitivity: "sensitive", title: "Rex", bodyText: "dog Labrador" });
    cleanup.push(async () => db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId)));

    // Health appointment — findable by provider name.
    const apptId = generateId("healthAppointment");
    await db.insert(schema.healthAppointments).values({
      id: apptId,
      ownerUserId,
      providerName: "Dr. Alvarez Dental",
      appointmentType: "dental",
      dateTime: dateTemporal("2026-10-01"),
    });
    await searchIndex.upsert({
      resourceType: "health_appointment",
      resourceId: apptId,
      ownerUserId,
      sensitivity: "highly_sensitive",
      title: "Dr. Alvarez Dental",
      bodyText: "dental",
    });
    cleanup.push(async () => db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.id, apptId)));

    // Warranty — findable by product label.
    const warrantyId = generateId("warranty");
    await db.insert(schema.warranties).values({ id: warrantyId, ownerUserId, productLabel: "Dyson V15 vacuum", expirationDate: dateTemporal("2027-01-01") });
    await searchIndex.upsert({ resourceType: "warranty", resourceId: warrantyId, ownerUserId, sensitivity: "standard", title: "Dyson V15 vacuum" });
    cleanup.push(async () => db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId)));

    // Subscription — findable by service label (lives on the recurring stream).
    const streamId = generateId("recurringStream");
    const subscriptionId = generateId("subscription");
    await db.insert(schema.recurringStreams).values({ id: streamId, ownerUserId, serviceLabel: "Netflix Premium", cadence: "monthly" });
    await db.insert(schema.subscriptions).values({ id: subscriptionId, recurringStreamId: streamId, state: "active" });
    await searchIndex.upsert({ resourceType: "subscription", resourceId: subscriptionId, ownerUserId, sensitivity: "sensitive", title: "Netflix Premium" });
    cleanup.push(async () => {
      await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
      await db.delete(schema.recurringStreams).where(eq(schema.recurringStreams.id, streamId));
    });

    // Shipment — findable by carrier.
    const shipmentId = generateId("shipment");
    await db.insert(schema.shipments).values({ id: shipmentId, ownerUserId, carrier: "UPS Freight Express", trackingNumber: "1Z999AA10123456784" });
    await searchIndex.upsert({ resourceType: "shipment", resourceId: shipmentId, ownerUserId, sensitivity: "standard", title: "UPS Freight Express — 1Z999AA10123456784" });
    cleanup.push(async () => db.delete(schema.shipments).where(eq(schema.shipments.id, shipmentId)));

    // Return case — findable via its parent purchase's order number.
    const purchaseId = generateId("purchase");
    const returnCaseId = generateId("returnCase");
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      orderNumber: "ORD-SEARCHCOV-777",
      purchaseDate: dateTemporal("2026-08-01"),
      confidenceBand: "verified",
      state: "confirmed",
    });
    await db.insert(schema.returnCases).values({ id: returnCaseId, purchaseId, deadline: dateTemporal("2026-09-15"), state: "eligible" });
    await searchIndex.upsert({
      resourceType: "return_case",
      resourceId: returnCaseId,
      ownerUserId,
      sensitivity: "sensitive",
      title: "Return case — Unknown merchant order ORD-SEARCHCOV-777",
    });
    cleanup.push(async () => {
      await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
      await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    });

    // Another owner's trip, sharing no keywords with the above — used to prove owner-scoping.
    const otherTripId = generateId("trip");
    await db.insert(schema.trips).values({ id: otherTripId, ownerUserId: otherUserId, label: "Other person's trip", destinationLabel: "Tokyo, Japan", status: "upcoming" });
    await searchIndex.upsert({ resourceType: "trip", resourceId: otherTripId, ownerUserId: otherUserId, sensitivity: "sensitive", title: "Other person's trip", bodyText: "Tokyo, Japan" });
    cleanup.push(async () => db.delete(schema.trips).where(eq(schema.trips.id, otherTripId)));
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const fn of cleanup.reverse()) await fn();
    // search_documents has no FK to any domain table (see schema/search.ts's own doc comment on why it's
    // deliberately its own thing) — nothing cascades these away, so they're cleaned up explicitly.
    await db.delete(schema.searchDocuments).where(inArray(schema.searchDocuments.ownerUserId, [ownerUserId, otherUserId]));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it("finds a trip by destination", async () => {
    if (!dbAvailable) return;
    const result = await search.structuredSearch(ownerUserId, "lisbon");
    expect(result.trips).toHaveLength(1);
    expect(result.trips[0]!.destinationLabel).toBe("Lisbon, Portugal");
  });

  it("finds a saved memory by title and separately by notes", async () => {
    if (!dbAvailable) return;
    const byTitle = await search.structuredSearch(ownerUserId, "weber genesis");
    expect(byTitle.savedMemories).toHaveLength(1);
    const byNotes = await search.structuredSearch(ownerUserId, "father's day");
    expect(byNotes.savedMemories).toHaveLength(1);
  });

  it("SAVE-004 query-based resurfacing: surfaces a lexically-related saved memory that wasn't itself a direct hit", async () => {
    if (!dbAvailable) return;
    // Neither saved memory's title/notes literally contains the phrase "grill thermometer" verbatim, so
    // neither is a direct substring hit — but both share the word "grill" with the query, so the
    // secondary relatedForQuery pass should surface them as "you might also want to revisit" suggestions.
    const result = await search.structuredSearch(ownerUserId, "grill thermometer");
    expect(result.savedMemories).toHaveLength(0);
    expect(result.relatedSavedMemories.length).toBeGreaterThan(0);
    expect(result.relatedSavedMemories.map((m) => m.id)).toContain(relatedMemoryId);

    // A direct hit is never ALSO suggested as "related" for the same query.
    const directHitQuery = await search.structuredSearch(ownerUserId, "weber genesis");
    expect(directHitQuery.relatedSavedMemories.map((m) => m.id)).not.toContain(memoryId);
  });

  it("finds a pet by name", async () => {
    if (!dbAvailable) return;
    const result = await search.structuredSearch(ownerUserId, "rex");
    expect(result.pets).toHaveLength(1);
    expect(result.pets[0]!.breed).toBe("Labrador");
  });

  it("finds a health appointment by provider name", async () => {
    if (!dbAvailable) return;
    const result = await search.structuredSearch(ownerUserId, "alvarez");
    expect(result.healthAppointments).toHaveLength(1);
  });

  it("finds a warranty, subscription, shipment, and return case (structuredSearch/ask parity fix)", async () => {
    if (!dbAvailable) return;
    expect((await search.structuredSearch(ownerUserId, "dyson v15")).warranties).toHaveLength(1);
    expect((await search.structuredSearch(ownerUserId, "netflix")).subscriptions).toHaveLength(1);
    expect((await search.structuredSearch(ownerUserId, "ups freight")).shipments).toHaveLength(1);
    expect((await search.structuredSearch(ownerUserId, "ORD-SEARCHCOV-777")).returnCases).toHaveLength(1);
  });

  it("never returns another owner's row", async () => {
    if (!dbAvailable) return;
    const result = await search.structuredSearch(ownerUserId, "tokyo");
    expect(result.trips).toHaveLength(0);
  });

  it("returns every category as an empty array for a blank query, never undefined", async () => {
    if (!dbAvailable) return;
    const result = await search.structuredSearch(ownerUserId, "   ");
    expect(result).toEqual({
      purchases: [],
      bills: [],
      documents: [],
      events: [],
      warranties: [],
      subscriptions: [],
      shipments: [],
      returnCases: [],
      trips: [],
      savedMemories: [],
      pets: [],
      healthAppointments: [],
      relatedSavedMemories: [],
    });
  });
});
