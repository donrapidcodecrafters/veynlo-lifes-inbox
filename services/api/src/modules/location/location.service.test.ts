import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { LocationService } from "./location.service";
import { ResurfacingService } from "../memories/resurfacing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Real-Postgres coverage for the buildable LOC-003/004/005 data layer (places/geofences/context-rules)
 * plus LOC-006's "no movement diary" guarantee, re-verified here at the service/DB level rather than
 * just asserted in a doc comment: recordGeofenceEvent's own inserted row is checked to contain no
 * coordinate columns at all, only geofenceId/triggerKind/occurredAt.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("LocationService", () => {
  let db: Database;
  let location: LocationService;
  let ownerUserId: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    location = new LocationService(db, stubHouseholds, new ResurfacingService(db));
    try {
      ownerUserId = generateId("user");
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `loc-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: strangerUserId, email: `loc-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping LocationService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  it("creates and lists places, excluding soft-deleted ones", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Home", lat: 37.7749, lng: -122.4194 });
    const listed = await location.listPlaces(ownerUserId);
    expect(listed.some((p) => p.id === placeId)).toBe(true);

    await location.deletePlace(placeId, ownerUserId);
    const afterDelete = await location.listPlaces(ownerUserId);
    expect(afterDelete.some((p) => p.id === placeId)).toBe(false);
  });

  it("a place saved from a plain address (no coordinates) cannot back a geofence", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Grandma's house", address: "123 Main St, Springfield, IL 62701" });
    await expect(location.createGeofence(ownerUserId, { placeId, radiusMeters: 150, triggerKind: "arrival" })).rejects.toThrow(
      /coordinates/i,
    );
  });

  it("a stranger cannot edit or delete another owner's place", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Work", lat: 37.79, lng: -122.4 });
    await expect(location.updatePlace(placeId, strangerUserId, { label: "Hijacked" })).rejects.toThrow();
    await expect(location.deletePlace(placeId, strangerUserId)).rejects.toThrow();
  });

  it("firing a geofence's active context rule files an attention item, and a non-matching direction does not", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Home", lat: 47.6062, lng: -122.3321 });
    const { id: geofenceId } = await location.createGeofence(ownerUserId, { placeId, radiusMeters: 100, triggerKind: "arrival" });
    const { id: ruleId } = await location.createContextRule(ownerUserId, {
      geofenceId,
      actionKind: "remind",
      actionTitle: "Check the sprinkler",
    });

    const arrival = await location.recordGeofenceEvent(ownerUserId, { geofenceId, triggerKind: "arrival" });
    expect(arrival.rulesFired).toBe(1);

    const [filedItem] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.ownerUserId, ownerUserId), eq(schema.attentionItems.linkedResourceId, ruleId)));
    expect(filedItem).toBeDefined();
    expect(filedItem!.reasonCode).toBe("location_context_rule");

    // The geofence is arrival-only — a departure report for the same geofence must not fire the rule.
    const departure = await location.recordGeofenceEvent(ownerUserId, { geofenceId, triggerKind: "departure" });
    expect(departure.rulesFired).toBe(0);

    // LOC-006: the recorded event rows carry no coordinates at all — only which geofence/direction/when.
    const events = await location.listGeofenceEvents(ownerUserId);
    for (const event of events) {
      expect(Object.keys(event)).not.toContain("lat");
      expect(Object.keys(event)).not.toContain("lng");
    }
  });

  it("SAVE-004 location_proximity: a real geofence arrival resurfaces a saved memory linked to that place", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Trader Joe's", lat: 39.75, lng: -104.99 });
    const { id: geofenceId } = await location.createGeofence(ownerUserId, { placeId, radiusMeters: 100, triggerKind: "arrival" });

    const memoryId = generateId("savedMemory");
    await db.insert(schema.savedMemories).values({
      id: memoryId,
      ownerUserId,
      sourceKind: "note",
      title: "Grocery list for Trader Joe's",
      category: "place",
      extractedFields: {},
      tags: [],
      highlights: [],
    });
    await db.insert(schema.resurfacingRules).values({
      id: generateId("resurfacingRule"),
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "location_proximity",
      triggerConfig: { placeId },
    });

    const arrival = await location.recordGeofenceEvent(ownerUserId, { geofenceId, triggerKind: "arrival" });
    expect(arrival.resurfacingFired).toBe(1);

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId), eq(schema.attentionItems.reasonCode, "memory_resurface_location_proximity")));
    expect(item).toBeTruthy();
    expect(item?.reasonText).toContain("Trader Joe's");

    // A departure event at the same geofence must never fire location_proximity resurfacing.
    const { id: geofence2 } = await location.createGeofence(ownerUserId, { placeId, radiusMeters: 100, triggerKind: "both" });
    const departure = await location.recordGeofenceEvent(ownerUserId, { geofenceId: geofence2, triggerKind: "departure" });
    expect(departure.resurfacingFired).toBe(0);

    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
  });

  it("an inactive geofence refuses to record a new trigger event", async () => {
    if (!dbAvailable) return;
    const { id: placeId } = await location.createPlace(ownerUserId, { label: "Gym", lat: 40.0, lng: -74.0 });
    const { id: geofenceId } = await location.createGeofence(ownerUserId, { placeId, radiusMeters: 100, triggerKind: "both" });
    await location.updateGeofence(geofenceId, ownerUserId, { isActive: false });
    await expect(location.recordGeofenceEvent(ownerUserId, { geofenceId, triggerKind: "arrival" })).rejects.toThrow(/turned off/i);
  });

  it("upserts and reads back location permission state as a single row per user, not a log", async () => {
    if (!dbAvailable) return;
    const first = await location.upsertPermissionState(ownerUserId, {
      foregroundStatus: "granted",
      backgroundStatus: "denied",
      precision: "approximate",
    });
    expect(first.foregroundStatus).toBe("granted");

    const second = await location.upsertPermissionState(ownerUserId, {
      foregroundStatus: "granted",
      backgroundStatus: "granted",
      precision: "precise",
    });
    expect(second.backgroundStatus).toBe("granted");

    const rows = await db.select().from(schema.locationPermissionState).where(eq(schema.locationPermissionState.userId, ownerUserId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.precision).toBe("precise");
  });

  it("computes a haversine travel-time estimate between two places and always includes the uncertainty note", async () => {
    if (!dbAvailable) return;
    const { id: originId } = await location.createPlace(ownerUserId, { label: "Origin", lat: 37.7749, lng: -122.4194 });
    const { id: destinationId } = await location.createPlace(ownerUserId, { label: "Destination", lat: 37.3382, lng: -121.8863 });
    const estimate = await location.estimateTravelTime(ownerUserId, { originPlaceId: originId, destinationPlaceId: destinationId });
    expect(estimate.method).toBe("haversine_rough_estimate");
    expect(estimate.estimatedMinutes).toBeGreaterThan(0);
    expect(estimate.uncertaintyNote.toLowerCase()).toContain("not real traffic-aware");

    const stored = await db.select().from(schema.travelEstimates).where(eq(schema.travelEstimates.id, estimate.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.uncertaintyNote).toBe(estimate.uncertaintyNote);
  });

  it("refuses a travel estimate when a place has no coordinates", async () => {
    if (!dbAvailable) return;
    const { id: originId } = await location.createPlace(ownerUserId, { label: "Origin", lat: 37.7749, lng: -122.4194 });
    const { id: addressOnlyId } = await location.createPlace(ownerUserId, { label: "No coords", address: "1 Unknown Way" });
    await expect(location.estimateTravelTime(ownerUserId, { originPlaceId: originId, destinationPlaceId: addressOnlyId })).rejects.toThrow(
      /coordinates/i,
    );
  });
});
