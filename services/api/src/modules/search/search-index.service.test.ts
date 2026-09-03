import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SearchIndexService, searchDocumentId } from "./search-index.service";
import { SearchService } from "./search.service";
import { PetsService } from "../pets/pets.service";
import { MemoriesService } from "../memories/memories.service";
import { SharingService } from "../sharing/sharing.service";
import { GraphService } from "../graph/graph.service";
import type { HouseholdService } from "../household/household.service";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { DocumentsService } from "../documents/documents.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

// PetsService.create/update/remove never touch households/sharing for an owner-only (no householdId) pet —
// see PetsService.assertOwnedOrManagedPet's own early `pet.ownerUserId === userId` return — so these stubs
// are only ever reachable if a test accidentally exercises the household/sharing branches, in which case
// they'll throw loudly rather than silently doing the wrong thing.
const stubHouseholds = {} as unknown as HouseholdService;
const stubPetsSharing = {} as unknown as SharingService;
const stubAi = {} as unknown as ModelProvider;
const stubEntitlements = {} as unknown as EntitlementsService;
const stubDocuments = {} as unknown as DocumentsService;
const stubQueue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
const stubPreferences = { getAskResponseStyle: async () => "balanced" as const } as unknown as PreferencesService;

/**
 * §44.4 "Search architecture" — proves the actual end-to-end wiring this phase adds, not just the SQL
 * mechanics `search.domain-coverage.test.ts` exercises against hand-seeded `search_documents` rows:
 *
 * 1. Calling a real domain service's create/update path (PetsService, chosen as the lightest-weight wired
 *    service — no household/sharing calls for an owner-only pet) produces a matching `search_documents`
 *    row, with no direct `SearchIndexService` call in the test itself.
 * 2. That row is genuinely findable through `SearchService.structuredSearch`'s real Postgres full-text
 *    query (`ts_rank`/`plainto_tsquery` against the generated `search_vector` column).
 * 3. Ranking behaves sensibly: a title-weighted ("A") exact multi-word match outranks a body-weighted ("B")
 *    match of the same words — real `ts_rank`, not app-code word-overlap.
 * 4. Access-control scoping is preserved exactly as it works today (owner-scoped, unchanged by this
 *    phase) — a search never finds another user's pet.
 */
describe("SearchIndexService — end-to-end wiring through PetsService and SearchService", () => {
  let db: Database;
  let pets: PetsService;
  let search: SearchService;
  let searchIndex: SearchIndexService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  const cleanup: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    searchIndex = new SearchIndexService(db);
    pets = new PetsService(db, stubHouseholds, stubPetsSharing, searchIndex);
    const sharing = new SharingService(db);
    const memories = new MemoriesService(db, stubAi, stubQueue, stubDocuments, stubHouseholds, sharing);
    search = new SearchService(db, stubAi, stubEntitlements, memories, stubPreferences, new GraphService(db));
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `search-index-${ownerUserId}@example.com`, displayName: "Search Index Test Owner" },
        { id: otherUserId, email: `search-index-other-${otherUserId}@example.com`, displayName: "Search Index Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping SearchIndexService wiring tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const fn of cleanup.reverse()) await fn();
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it("PetsService.create writes a matching search_documents row with no direct SearchIndexService call in the test", async () => {
    if (!dbAvailable) return;
    const { id: petId } = await pets.create(ownerUserId, { label: "Fluffy Whiskers", species: "cat", breed: "Siamese" });
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId)));
    });

    const [doc] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId))).limit(1);
    expect(doc).toBeTruthy();
    expect(doc!.ownerUserId).toBe(ownerUserId);
    expect(doc!.resourceType).toBe("pet");
    expect(doc!.resourceId).toBe(petId);
    expect(doc!.sensitivity).toBe("sensitive");
    expect(doc!.title).toBe("Fluffy Whiskers");
    expect(doc!.bodyText).toBe("cat Siamese");
    expect(doc!.deletedAt).toBeNull();
  });

  it("is genuinely findable via SearchService.structuredSearch's real full-text query", async () => {
    if (!dbAvailable) return;
    const { id: petId } = await pets.create(ownerUserId, { label: "Marmalade Biscuit", species: "cat" });
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId)));
    });

    const noMatch = await search.structuredSearch(ownerUserId, "golden retriever");
    expect(noMatch.pets.map((p) => p.id)).not.toContain(petId);

    const result = await search.structuredSearch(ownerUserId, "marmalade biscuit");
    expect(result.pets).toHaveLength(1);
    expect(result.pets[0]!.id).toBe(petId);
  });

  it("PetsService.update rewrites the search_documents row, so a search for the OLD title stops matching and the NEW one starts", async () => {
    if (!dbAvailable) return;
    const { id: petId } = await pets.create(ownerUserId, { label: "Sir Barksalot", species: "dog" });
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId)));
    });

    expect((await search.structuredSearch(ownerUserId, "barksalot")).pets).toHaveLength(1);

    await pets.update(petId, ownerUserId, { label: "Duke Woofington" });

    const [doc] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId))).limit(1);
    expect(doc!.title).toBe("Duke Woofington");

    expect((await search.structuredSearch(ownerUserId, "barksalot")).pets).toHaveLength(0);
    const renamed = await search.structuredSearch(ownerUserId, "woofington");
    expect(renamed.pets).toHaveLength(1);
    expect(renamed.pets[0]!.id).toBe(petId);
  });

  it("PetsService.remove soft-deletes the search_documents row, so it stops surfacing in search", async () => {
    if (!dbAvailable) return;
    const { id: petId } = await pets.create(ownerUserId, { label: "Captain Meowmix", species: "cat" });
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId)));
    });

    expect((await search.structuredSearch(ownerUserId, "meowmix")).pets).toHaveLength(1);

    await pets.remove(petId, ownerUserId);

    const [doc] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", petId))).limit(1);
    expect(doc!.deletedAt).not.toBeNull();
    expect((await search.structuredSearch(ownerUserId, "meowmix")).pets).toHaveLength(0);
  });

  it("ranking behaves sensibly: an exact multi-word TITLE match outranks the same words only appearing in the body", async () => {
    if (!dbAvailable) return;
    // Both documents satisfy the AND-query "golden retriever" (plainto_tsquery requires every term present
    // somewhere), so this isolates ranking, not filtering. `search_vector`'s generated-column definition
    // (schema/search.ts) weights title matches 'A' and body matches 'B' — 'A' always outranks 'B' in
    // ts_rank, so the title-match document must sort first.
    const titleMatchId = generateId("pet");
    const bodyOnlyMatchId = generateId("pet");
    await searchIndex.upsert({
      resourceType: "pet",
      resourceId: titleMatchId,
      ownerUserId,
      sensitivity: "sensitive",
      title: "Golden Retriever Rex",
      bodyText: "a very good boy",
    });
    await searchIndex.upsert({
      resourceType: "pet",
      resourceId: bodyOnlyMatchId,
      ownerUserId,
      sensitivity: "sensitive",
      title: "Rex",
      bodyText: "people say he looks like a golden retriever even though he's a mutt",
    });
    // Real petProfiles rows are required too — structuredSearch hydrates full entities from the real
    // table once search_documents has told it which ids matched (see SearchService.structuredSearch's own
    // doc comment); an id with no real row is silently dropped by keepFtsOrder.
    await db.insert(schema.petProfiles).values([
      { id: titleMatchId, ownerUserId, label: "Golden Retriever Rex" },
      { id: bodyOnlyMatchId, ownerUserId, label: "Rex" },
    ]);
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, titleMatchId));
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, bodyOnlyMatchId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", titleMatchId)));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", bodyOnlyMatchId)));
    });

    const result = await search.structuredSearch(ownerUserId, "golden retriever");
    expect(result.pets.map((p) => p.id)).toEqual([titleMatchId, bodyOnlyMatchId]);
  });

  it("access control: a user can never find another user's pet via search (unchanged owner-scoping)", async () => {
    if (!dbAvailable) return;
    const { id: otherPetId } = await pets.create(otherUserId, { label: "Confidential Corgi", species: "dog" });
    cleanup.push(async () => {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, otherPetId));
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", otherPetId)));
    });

    // The owning user finds their own pet...
    expect((await search.structuredSearch(otherUserId, "confidential corgi")).pets).toHaveLength(1);
    // ...but a different, unrelated user searching the exact same words finds nothing, even though the
    // matching search_documents row genuinely exists in the table.
    const leaked = await search.structuredSearch(ownerUserId, "confidential corgi");
    expect(leaked.pets).toHaveLength(0);
  });

  it("SearchIndexService.upsert is a true upsert keyed by resourceType:resourceId — calling it twice never creates a second row", async () => {
    if (!dbAvailable) return;
    const resourceId = generateId("pet");
    await searchIndex.upsert({ resourceType: "pet", resourceId, ownerUserId, sensitivity: "sensitive", title: "First Title" });
    await searchIndex.upsert({ resourceType: "pet", resourceId, ownerUserId, sensitivity: "sensitive", title: "Second Title" });
    cleanup.push(async () => db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("pet", resourceId))));

    const rows = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.resourceId, resourceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Second Title");
  });
});
