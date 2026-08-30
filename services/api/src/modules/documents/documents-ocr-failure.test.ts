import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchIndexService } from "../search/search-index.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { DocumentsService } from "./documents.service";

/**
 * OCR failures (e.g. a password-protected PDF) were previously silently server-log-only -- the document
 * landed with no text and zero explanation or next step visible to the user. Real DB-backed proof a
 * genuine extraction failure now lands as a real, explained "failed_user_action" state.
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

function makeService(throwOnOcr: boolean) {
  const storage = { putObject: vi.fn(async () => undefined) };
  const ai = {
    isConfigured: () => true,
    extractStructured: vi.fn(async (request: { extractorName: string }) => {
      if (request.extractorName === "document_ocr_pdf_v1") {
        if (throwOnOcr) throw new Error("simulated: this PDF is password-protected");
        return { data: { transcribedText: "Real extracted text." }, confidenceScore: 0.9, modelUsed: "fake", inputTokens: 1, outputTokens: 1 };
      }
      return null; // classification/deadline extraction — not under test here
    }),
  };
  const malwareScanner = { isConfigured: () => false };
  const billing = { getCapability: vi.fn(async () => null) };
  const searchIndex = new SearchIndexService(db);
  const riskPolicy = new RiskPolicyService(db);
  return new DocumentsService(db, storage as never, ai as never, malwareScanner as never, {} as never, {} as never, searchIndex, billing as never, riskPolicy);
}

describe("DocumentsService.upload — OCR failure surfaces a real, explained state", () => {
  it("lands as failed_user_action with a real user-facing message when extraction genuinely throws", async () => {
    const documents = makeService(true);
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "locked.pdf",
      documentType: "other",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nfake-encrypted-content"),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db
      .select({ processingState: schema.documents.processingState, processingError: schema.documents.processingError })
      .from(schema.documents)
      .where(eq(schema.documents.id, result.documentId));
    expect(row?.processingState).toBe("failed_user_action");
    expect(row?.processingError).toBeTruthy();
    expect(row?.processingError).toMatch(/password-protected|corrupted|unsupported/);
  });

  it("a successful extraction lands as extracted with no error, unaffected", async () => {
    const documents = makeService(false);
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "readable.pdf",
      documentType: "other",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nfake-readable-content"),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db
      .select({ processingState: schema.documents.processingState, processingError: schema.documents.processingError })
      .from(schema.documents)
      .where(eq(schema.documents.id, result.documentId));
    expect(row?.processingState).toBe("extracted");
    expect(row?.processingError).toBeNull();
  });
});
