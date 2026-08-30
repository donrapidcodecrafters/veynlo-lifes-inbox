import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchService } from "./search.service";
import type { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";

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

describe("SearchService.ask — warranties/subscriptions/shipments/return cases/people reach the grounding context", () => {
  const warrantyOwnerId = generateId("user");
  const warrantyId = generateId("warranty");

  beforeAll(async () => {
    await db.insert(schema.users).values({ id: warrantyOwnerId, displayName: "Warranty Test User" });
    await db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId: warrantyOwnerId,
      productLabel: "Refrigerator",
      warrantyLengthMonths: 24,
      expirationDate: { date: "2027-03-01", precision: "date", instantUtc: null, timezone: null, sourceText: null },
    });
  });

  afterAll(async () => {
    await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    await db.delete(schema.askQueryLog).where(eq(schema.askQueryLog.ownerUserId, warrantyOwnerId));
    await db.delete(schema.users).where(eq(schema.users.id, warrantyOwnerId));
  });

  it("answers the spec's own canonical example — a warranty is genuinely present in Ask's grounding context, not silently excluded", async () => {
    let capturedUserContent = "";
    const fakeAi = {
      isConfigured: () => true,
      extractStructured: vi.fn(async (request: { userContent: string }) => {
        capturedUserContent = request.userContent;
        return { data: { answer: "Your refrigerator warranty expires 2027-03-01.", evidenceResourceIds: [warrantyId], insufficientEvidence: false }, confidenceScore: 1, modelUsed: "test", inputTokens: 0, outputTokens: 0 };
      }),
    } as unknown as AnthropicExtractionService;
    const fakeBilling = { getCapability: vi.fn(async () => null) };
    const askSearch = new SearchService(db, fakeAi, fakeBilling as never);

    const result = await askSearch.ask(warrantyOwnerId, "When does my fridge warranty expire?");

    expect(capturedUserContent).toContain("Refrigerator");
    expect(capturedUserContent).toContain("warranty");
    expect(result.evidence.some((e) => e.resourceId === warrantyId)).toBe(true);
  });
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
