import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ListsService } from "./lists.service";
import { SharingService } from "../sharing/sharing.service";
import { MemoriesService } from "../memories/memories.service";
import type { HouseholdService } from "../household/household.service";
import { FakeModelProvider } from "../intelligence/fake-model-provider";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { DocumentsService } from "../documents/documents.service";

/**
 * §29.1 SAVE-003 "Smart lists" end to end: a real ListsService wired to a real MemoriesService (not the
 * stubs lists.service.test.ts/lists.sharing.test.ts use, which never exercise the smart-list branch at
 * all) — proves `lists.smartListQuery` actually drives `listDetail` to return live-matched saved memories
 * instead of `saved_items` rows, and that a manual list is completely unaffected.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [], isActiveMember: async () => false } as unknown as HouseholdService;
const stubQueue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
const stubDocuments = {} as unknown as DocumentsService;

describe("ListsService smart lists", () => {
  let db: Database;
  let lists: ListsService;
  let memories: MemoriesService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    const ai = new FakeModelProvider();
    ai.configured = false;
    memories = new MemoriesService(db, ai, stubQueue, stubDocuments, stubHouseholds, sharing);
    lists = new ListsService(db, stubHouseholds, sharing, memories);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `smart-list-owner-${ownerUserId}@example.com`, displayName: "Owner" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping smart list tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a smart list's detail view shows live-matched saved memories, not saved_items rows", async () => {
    if (!dbAvailable) return;
    const { id: recipeMemoryId } = await memories.create(ownerUserId, { sourceKind: "recipe", rawText: "Grandma's lasagna" });
    await memories.update(recipeMemoryId, ownerUserId, { category: "recipe", title: "Lasagna" });
    const { id: otherMemoryId } = await memories.create(ownerUserId, { sourceKind: "product", rawText: "a random product" });
    await memories.update(otherMemoryId, ownerUserId, { category: "product" });

    const { id: smartListId } = await lists.createList(ownerUserId, { name: "All recipes", smartListQuery: { category: "recipe" } });
    const detail = await lists.listDetail(smartListId, ownerUserId);
    expect(detail.items).toEqual([]); // no manual membership rows at all for a smart list
    expect(detail.matchedMemories.map((m) => m.id)).toEqual([recipeMemoryId]);

    // A manual list (no smartListQuery) is completely unaffected — still driven by saved_items.
    const { id: manualListId } = await lists.createList(ownerUserId, { name: "Groceries", kind: "grocery" });
    await lists.addItem(manualListId, ownerUserId, { label: "Milk" });
    const manualDetail = await lists.listDetail(manualListId, ownerUserId);
    expect(manualDetail.items.map((i) => i.label)).toEqual(["Milk"]);
    expect(manualDetail.matchedMemories).toEqual([]);

    await memories.delete(recipeMemoryId, ownerUserId);
    await memories.delete(otherMemoryId, ownerUserId);
    await db.delete(schema.lists).where(eq(schema.lists.id, smartListId));
    await db.delete(schema.lists).where(eq(schema.lists.id, manualListId));
  });
});
