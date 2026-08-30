import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchIndexService } from "../search/search-index.service";
import { DocumentsService } from "./documents.service";

/**
 * DOC-001 "AI classification" — documentType was previously purely whatever the client sent at upload
 * time (mobile's picker defaults to "receipt" for everything), never predicted or corrected from the
 * document's actual content. Proves a real classification call overrides a deliberately-wrong client-
 * supplied type, using a fake AI boundary (no real Anthropic call) but a genuine DB write/read.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

const ownerId = generateId("user");
const createdDocumentIds: string[] = [];

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Owner" });
});

afterAll(async () => {
  if (createdDocumentIds.length > 0) {
    await db.delete(schema.documentVersions).where(inArray(schema.documentVersions.documentId, createdDocumentIds));
    await db.delete(schema.documents).where(inArray(schema.documents.id, createdDocumentIds));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

function makeService(classifiedType: string | null) {
  const storage = { putObject: vi.fn(async () => undefined) };
  const ai = {
    isConfigured: () => true,
    extractStructured: vi.fn(async (request: { extractorName: string }) => {
      if (request.extractorName === "document_classification_v1" && classifiedType) {
        return { data: { documentType: classifiedType }, confidenceScore: 0.9, modelUsed: "fake", inputTokens: 1, outputTokens: 1 };
      }
      return null;
    }),
  };
  const malwareScanner = { isConfigured: () => false };
  const billing = { getCapability: vi.fn(async () => null) };
  const searchIndex = new SearchIndexService(db);
  return new DocumentsService(db, storage as never, ai as never, malwareScanner as never, {} as never, {} as never, searchIndex, billing as never);
}

describe("DocumentsService.upload — AI classification (DOC-001)", () => {
  it("overrides a deliberately-wrong client-supplied documentType with the real classification", async () => {
    const documents = makeService("warranty");
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "fridge-warranty.txt",
      documentType: "receipt", // deliberately wrong — a real warranty card, mislabeled at upload
      mimeType: "text/plain",
      buffer: Buffer.from("LIMITED WARRANTY — this refrigerator is warranted against defects for 5 years from purchase."),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db.select({ documentType: schema.documents.documentType }).from(schema.documents).where(eq(schema.documents.id, result.documentId));
    expect(row?.documentType).toBe("warranty");
  });

  it("keeps the client-supplied type when classification is unavailable (AI returns nothing)", async () => {
    const documents = makeService(null);
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "ambiguous.txt",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("Some ambiguous text that the fake AI declines to classify."),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db.select({ documentType: schema.documents.documentType }).from(schema.documents).where(eq(schema.documents.id, result.documentId));
    expect(row?.documentType).toBe("other");
  });
});
