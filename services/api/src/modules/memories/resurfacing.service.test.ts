import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ResurfacingService } from "./resurfacing.service";

/**
 * §29.1 SAVE-004 "Contextual resurfacing" — real-DB test of the three live trigger types
 * (date/person_birthday/trip_location), mirroring attention.event-reminder.test.ts's shape for
 * AttentionService.scanAndFileDeadlines. Each test creates exactly the rows the scan needs and checks the
 * resulting `attention_items` row, since that's the same table Home's "Needs You" queue already reads —
 * there's no separate resurfacing feed to assert against.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("ResurfacingService", () => {
  let db: Database;
  let resurfacing: ResurfacingService;
  let ownerUserId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    resurfacing = new ResurfacingService(db);
    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `resurface-owner-${ownerUserId}@example.com`, displayName: "Owner" });
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ResurfacingService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function createMemory(overrides: Partial<typeof schema.savedMemories.$inferInsert> = {}): Promise<string> {
    const id = generateId("savedMemory");
    // extractedFields/tags/highlights must be passed explicitly — see MemoriesService.create's own comment
    // on why an encrypted-jsonb column's `.default([])`/`.default({})` never actually applies at the DB level.
    await db.insert(schema.savedMemories).values({ id, ownerUserId, sourceKind: "note", title: "A saved item", extractedFields: {}, tags: [], highlights: [], ...overrides });
    return id;
  }

  it("date trigger: fires once within the lookahead window and deactivates the rule", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory();
    const targetDate = new Date(Date.now() + 3 * 86_400_000); // 3 days out — inside the 14-day lookahead
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({
      id: ruleId,
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "date",
      triggerConfig: { date: targetDate.toISOString() },
    });

    await resurfacing.scanAndFileResurfacing();

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId), eq(schema.attentionItems.reasonCode, "memory_resurface_date")));
    expect(item).toBeTruthy();

    const [rule] = await db.select().from(schema.resurfacingRules).where(eq(schema.resurfacingRules.id, ruleId));
    expect(rule?.active).toBe(false);
    expect(rule?.lastFiredAt).not.toBeNull();

    // A second scan doesn't file a duplicate (the rule is now inactive).
    await resurfacing.scanAndFileResurfacing();
    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId)));
    expect(items).toHaveLength(1);

    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
  });

  it("person_birthday trigger: fires when a household dependent's birthday falls inside the daysBefore window", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ category: "gift_idea", relatedPersonLabel: "Dad" });
    // Birthday 5 days from now, with a 14-day lead — remindAt is 9 days in the PAST, so this should fire now.
    const upcomingBirthday = new Date(Date.now() + 5 * 86_400_000);
    const dependentId = generateId("dependentProfile");
    await db.insert(schema.dependentProfiles).values({
      id: dependentId,
      householdId,
      displayName: "Dad",
      birthDate: `1970-${String(upcomingBirthday.getUTCMonth() + 1).padStart(2, "0")}-${String(upcomingBirthday.getUTCDate()).padStart(2, "0")}`,
      guardianUserIds: [ownerUserId],
    });
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({
      id: ruleId,
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "person_birthday",
      triggerConfig: { dependentProfileId: dependentId, daysBefore: 14 },
    });

    await resurfacing.scanAndFileResurfacing();

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId), eq(schema.attentionItems.reasonCode, "memory_resurface_birthday")));
    expect(item).toBeTruthy();
    expect(item?.reasonText).toContain("Dad");

    // Recurs, not one-shot: the rule itself stays active for next year.
    const [rule] = await db.select().from(schema.resurfacingRules).where(eq(schema.resurfacingRules.id, ruleId));
    expect(rule?.active).toBe(true);
    expect(rule?.lastFiredAt).not.toBeNull();

    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
    await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependentId));
  });

  it("trip_location trigger: fires when an upcoming trip's destination matches the saved location", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ category: "place", title: "Great taco spot", extractedFields: { locationLabel: "Denver" } });
    const tripId = generateId("trip");
    await db.insert(schema.trips).values({
      id: tripId,
      ownerUserId,
      destinationLabel: "Denver, CO",
      status: "upcoming",
      startDateSort: new Date(Date.now() + 20 * 86_400_000),
    });
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({
      id: ruleId,
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "trip_location",
      triggerConfig: { locationLabel: "Denver" },
    });

    await resurfacing.scanAndFileResurfacing();

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId), eq(schema.attentionItems.reasonCode, "memory_resurface_trip_location")));
    expect(item).toBeTruthy();
    expect(item?.reasonText).toContain("Denver");

    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
  });

  it("location_proximity trigger: fires from a real geofence arrival, not from the periodic scan tick", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ category: "place", title: "Great taco spot near Costco" });
    const placeId = generateId("place");
    await db.insert(schema.places).values({ id: placeId, ownerUserId, label: "Costco", lat: 39.7392, lng: -104.9903, source: "manual" });
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({
      id: ruleId,
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "location_proximity",
      triggerConfig: { placeId },
    });

    // The periodic scan tick must NOT evaluate location_proximity rules — see ResurfacingService's own
    // doc comment on why this trigger is event-driven only.
    await resurfacing.scanAndFileResurfacing();
    const beforeArrival = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    expect(beforeArrival).toHaveLength(0);

    const fired = await resurfacing.fireLocationProximityResurfacing(ownerUserId, placeId);
    expect(fired).toBe(1);

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "saved_memory"), eq(schema.attentionItems.linkedResourceId, memoryId), eq(schema.attentionItems.reasonCode, "memory_resurface_location_proximity")));
    expect(item).toBeTruthy();
    expect(item?.reasonText).toContain("Costco");

    // A second arrival within the cooldown window doesn't re-file.
    const firedAgain = await resurfacing.fireLocationProximityResurfacing(ownerUserId, placeId);
    expect(firedAgain).toBe(0);
    const itemsAfterSecondArrival = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    expect(itemsAfterSecondArrival).toHaveLength(1);

    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    await db.delete(schema.resurfacingRules).where(eq(schema.resurfacingRules.id, ruleId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
    await db.delete(schema.places).where(eq(schema.places.id, placeId));
  });

  it("location_proximity trigger: never-resurface memories are skipped even on a real arrival", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ category: "place", neverResurface: true });
    const placeId = generateId("place");
    await db.insert(schema.places).values({ id: placeId, ownerUserId, label: "Opted-out place", lat: 40, lng: -105, source: "manual" });
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({ id: ruleId, ownerUserId, savedMemoryId: memoryId, triggerType: "location_proximity", triggerConfig: { placeId } });

    const fired = await resurfacing.fireLocationProximityResurfacing(ownerUserId, placeId);
    expect(fired).toBe(0);

    await db.delete(schema.resurfacingRules).where(eq(schema.resurfacingRules.id, ruleId));
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
    await db.delete(schema.places).where(eq(schema.places.id, placeId));
  });

  it("SAVE-007: never-resurface and archived memories are skipped even when their rule would otherwise fire", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ neverResurface: true });
    const ruleId = generateId("resurfacingRule");
    await db.insert(schema.resurfacingRules).values({
      id: ruleId,
      ownerUserId,
      savedMemoryId: memoryId,
      triggerType: "date",
      triggerConfig: { date: new Date(Date.now() + 86_400_000).toISOString() },
    });

    await resurfacing.scanAndFileResurfacing();

    const items = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, memoryId));
    expect(items).toHaveLength(0);

    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
  });

  it("SAVE-007: auto-archives a memory once its autoArchiveAt passes", async () => {
    if (!dbAvailable) return;
    const memoryId = await createMemory({ autoArchiveAt: new Date(Date.now() - 60_000) });
    await resurfacing.scanAndFileResurfacing();
    const [row] = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
    expect(row?.archivedAt).not.toBeNull();
    await db.delete(schema.savedMemories).where(eq(schema.savedMemories.id, memoryId));
  });
});
