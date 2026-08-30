import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchService } from "./search.service";

/**
 * §54.2 launch criteria — a real authorization test against the actual local Postgres, not a mock,
 * proving `structuredSearch` never returns another owner's rows. Runs against real `search_documents` +
 * `documents` rows (the same two-stage shape `structuredSearch` itself queries: an owner-scoped
 * `search_documents` match, then a second fetch of the real domain rows by id — see that method's own
 * comment on why the second fetch relies on the first stage's scoping rather than re-checking ownership
 * itself).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let search: SearchService;
const ownerAId = generateId("user");
const ownerBId = generateId("user");
const documentAId = generateId("document");
const documentBId = generateId("document");
const SHARED_KEYWORD = "quarterlyfrobnicationreport";

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  search = new SearchService(db, {} as never, {} as never); // structuredSearch never touches ai/billing
  await db.insert(schema.users).values([
    { id: ownerAId, displayName: "Owner A" },
    { id: ownerBId, displayName: "Owner B" },
  ]);
  await db.insert(schema.documents).values([
    { id: documentAId, ownerUserId: ownerAId, documentType: "receipt", title: "Owner A's private document", tags: [] },
    { id: documentBId, ownerUserId: ownerBId, documentType: "receipt", title: "Owner B's private document", tags: [] },
  ]);
  await db.insert(schema.searchDocuments).values([
    {
      id: generateId("searchDocument"),
      ownerUserId: ownerAId,
      resourceType: "document",
      resourceId: documentAId,
      sensitivity: "sensitive",
      title: `Owner A ${SHARED_KEYWORD}`,
      bodyText: "",
    },
    {
      id: generateId("searchDocument"),
      ownerUserId: ownerBId,
      resourceType: "document",
      resourceId: documentBId,
      sensitivity: "sensitive",
      title: `Owner B ${SHARED_KEYWORD}`,
      bodyText: "",
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.searchDocuments).where(inArray(schema.searchDocuments.ownerUserId, [ownerAId, ownerBId]));
  await db.delete(schema.documents).where(inArray(schema.documents.id, [documentAId, documentBId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerAId, ownerBId]));
});

describe("SearchService.structuredSearch — cross-user isolation", () => {
  it("returns only the requesting user's own matching document, never another owner's", async () => {
    const resultA = await search.structuredSearch(ownerAId, SHARED_KEYWORD);
    expect(resultA.documents.map((d) => d.id)).toEqual([documentAId]);

    const resultB = await search.structuredSearch(ownerBId, SHARED_KEYWORD);
    expect(resultB.documents.map((d) => d.id)).toEqual([documentBId]);
  });

  it("returns nothing for a user with no matching search_documents rows at all", async () => {
    const stranger = generateId("user");
    await db.insert(schema.users).values({ id: stranger, displayName: "Stranger" });
    try {
      const result = await search.structuredSearch(stranger, SHARED_KEYWORD);
      expect(result.documents).toEqual([]);
      expect(result.purchases).toEqual([]);
      expect(result.bills).toEqual([]);
      expect(result.events).toEqual([]);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, stranger));
    }
  });
});
