import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SearchIndexService, searchDocumentId } from "./search-index.service";
import { SearchBackfillService } from "./search-backfill.service";

/**
 * §44.3 "search documents ... deleted/reindexed with canonical data".
 *
 * The index is written forward-only, so a record inserted by anything that isn't its own domain service —
 * the seed, an importer, a repair — is permanently unfindable, and a record deleted after being indexed
 * leaves a row behind that keeps occupying one of its domain's ranked result slots. Measured against a
 * seeded database before this service existed: 8 of 10 resource types entirely absent from the index.
 *
 * Real DB-backed proof of both halves: records written directly to their tables (exactly how the seed
 * writes them) become searchable, and a document whose record is gone gets retired.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const backfill = new SearchBackfillService(db, new SearchIndexService(db));

const ownerId = generateId("user");
const merchantId = generateId("merchant");
const warrantyId = generateId("warranty");
const purchaseId = generateId("purchase");
const purchaseLineId = generateId("purchaseLine");
const billId = generateId("bill");
const petId = generateId("pet");
/** A record that exists only in the index — its source row was never inserted, i.e. it was deleted. */
const goneTripId = generateId("trip");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Search Backfill Test User" });
  await db.insert(schema.merchants).values({ id: merchantId, displayName: "Backfill Test Appliances" });

  // Written directly to the tables, with no service call and therefore no indexing — the seed's shape.
  await db.insert(schema.warranties).values({
    id: warrantyId,
    ownerUserId: ownerId,
    productLabel: "Backfill Test Cordless Vacuum",
    expirationDate: { precision: "date", date: "2030-01-01", instantUtc: null, timezone: null, sourceText: null },
  });
  await db.insert(schema.purchases).values({
    id: purchaseId,
    ownerUserId: ownerId,
    merchantId,
    orderNumber: "BF-1001",
    purchaseDate: { precision: "date", date: "2029-12-01", instantUtc: null, timezone: null, sourceText: null },
    confidenceBand: "verified",
  });
  await db.insert(schema.purchaseLines).values({
    id: purchaseLineId,
    purchaseId,
    productLabel: "Backfill Test Replacement Filter",
  });
  await db.insert(schema.bills).values({
    id: billId,
    ownerUserId: ownerId,
    billerLabel: "Backfill Test Water Utility",
    billerCategory: "utilities",
    dueDate: { precision: "date", date: "2030-02-01", instantUtc: null, timezone: null, sourceText: null },
  });
  await db.insert(schema.petProfiles).values({ id: petId, ownerUserId: ownerId, label: "Backfill Test Beagle", species: "dog" });

  // An index row whose trip row does not exist: the state a hard/soft delete used to leave behind.
  await db.insert(schema.searchDocuments).values({
    id: searchDocumentId("trip", goneTripId),
    ownerUserId: ownerId,
    resourceType: "trip",
    resourceId: goneTripId,
    sensitivity: "sensitive",
    title: "Backfill Test Trip That No Longer Exists",
    bodyText: "",
  });
});

afterAll(async () => {
  await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, ownerId));
  await db.delete(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, ownerId));
  await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerId));
  await db.delete(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
  await db.delete(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerId));
  await db.delete(schema.warranties).where(eq(schema.warranties.ownerUserId, ownerId));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

const liveDoc = async (resourceType: string, resourceId: string) => {
  const [row] = await db
    .select()
    .from(schema.searchDocuments)
    .where(and(eq(schema.searchDocuments.id, searchDocumentId(resourceType as never, resourceId)), isNull(schema.searchDocuments.deletedAt)))
    .limit(1);
  return row;
};

describe("SearchBackfillService.run", () => {
  it("indexes records that were written straight to their tables, and retires a document whose record is gone", async () => {
    // Counts in the result are database-wide (this is a reconciliation pass, not a per-user one), so the
    // assertions below check this fixture's own rows rather than those totals.
    const result = await backfill.run();
    expect(result.retired.trip).toBeGreaterThanOrEqual(1);

    for (const [type, id] of [["warranty", warrantyId], ["purchase", purchaseId], ["bill", billId], ["pet", petId]] as const) {
      expect(await liveDoc(type, id), `${type} should be indexed`).toBeDefined();
    }

    // The retired document is soft-deleted, not removed: markDeleted's shape, so it stays auditable.
    expect(await liveDoc("trip", goneTripId)).toBeUndefined();
    const [retiredRow] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.id, searchDocumentId("trip", goneTripId)));
    expect(retiredRow?.deletedAt).toBeInstanceOf(Date);
  });

  it("builds each document in the same shape its own domain service uses", async () => {
    await backfill.run();

    // Purchase: `${merchant} — order ${orderNumber}`, body = line-item labels (IngestionService's shape).
    const purchaseDoc = await liveDoc("purchase", purchaseId);
    expect(purchaseDoc?.title).toBe("Backfill Test Appliances — order BF-1001");
    expect(purchaseDoc?.bodyText).toBe("Backfill Test Replacement Filter");

    // Bill: title is the biller, body the category.
    const billDoc = await liveDoc("bill", billId);
    expect(billDoc?.title).toBe("Backfill Test Water Utility");
    expect(billDoc?.bodyText).toBe("utilities");

    // Pet: sensitivity "sensitive", body = species + breed (PetsService's shape).
    const petDoc = await liveDoc("pet", petId);
    expect(petDoc?.sensitivity).toBe("sensitive");
    expect(petDoc?.bodyText).toBe("dog");
  });

  it("makes a directly-inserted record actually match a full-text query, not merely have a row", async () => {
    await backfill.run();

    // The point of the whole exercise: `search_documents.search_vector` is a generated column, so this is
    // the same match structuredSearch performs — a row that doesn't match the query is not searchable.
    const hits = await db
      .select({ resourceId: schema.searchDocuments.resourceId })
      .from(schema.searchDocuments)
      .where(
        and(
          eq(schema.searchDocuments.ownerUserId, ownerId),
          isNull(schema.searchDocuments.deletedAt),
          eq(schema.searchDocuments.resourceType, "warranty"),
          sql`${schema.searchDocuments.searchVector} @@ plainto_tsquery('english', 'vacuum')`,
        ),
      );
    expect(hits.map((h) => h.resourceId)).toContain(warrantyId);
  });

  it("is idempotent — a second pass rewrites the same documents rather than duplicating them", async () => {
    await backfill.run();
    const before = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, ownerId));
    await backfill.run();
    const after = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, ownerId));
    expect(after.length).toBe(before.length);
  });
});
