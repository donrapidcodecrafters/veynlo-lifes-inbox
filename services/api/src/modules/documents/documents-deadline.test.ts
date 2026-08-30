import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchIndexService } from "../search/search-index.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { DocumentsService } from "./documents.service";

/**
 * DOC-005 "deadline/obligation extraction" — OCR was previously verbatim-only, nothing ever looked for a
 * real date to remind the user about (a contract renewal, a permit expiration, a policy end date). Real
 * DB-backed proof a found deadline is persisted with a real confidence band (not a hardcoded "verified" —
 * this is a genuine free-text AI guess, unlike the other domains AttentionService's scan already trusts).
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

function makeService(deadlineResult: { hasDeadline: boolean; label: string | null; iso_date: string | null; approximate_text: string | null } | null) {
  const storage = { putObject: vi.fn(async () => undefined) };
  const ai = {
    isConfigured: () => true,
    extractStructured: vi.fn(async (request: { extractorName: string }) => {
      if (request.extractorName === "document_classification_v1") return null;
      if (request.extractorName === "document_deadline_v1" && deadlineResult) {
        return { data: deadlineResult, confidenceScore: 0.7, modelUsed: "fake", inputTokens: 1, outputTokens: 1 };
      }
      return null;
    }),
  };
  const malwareScanner = { isConfigured: () => false };
  const billing = { getCapability: vi.fn(async () => null) };
  const searchIndex = new SearchIndexService(db);
  const riskPolicy = new RiskPolicyService(db);
  return new DocumentsService(db, storage as never, ai as never, malwareScanner as never, {} as never, {} as never, searchIndex, billing as never, riskPolicy);
}

describe("DocumentsService.upload — deadline extraction (DOC-005)", () => {
  it("persists a found deadline with a real (non-hardcoded) confidence band", async () => {
    const documents = makeService({ hasDeadline: true, label: "Insurance renewal", iso_date: "2027-03-01", approximate_text: null });
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "policy.txt",
      documentType: "insurance_policy",
      mimeType: "text/plain",
      buffer: Buffer.from("This homeowner's insurance policy must be renewed by March 1, 2027 to remain in effect."),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db
      .select({
        extractedDeadline: schema.documents.extractedDeadline,
        extractedDeadlineSort: schema.documents.extractedDeadlineSort,
        extractedDeadlineLabel: schema.documents.extractedDeadlineLabel,
        extractedDeadlineConfidenceBand: schema.documents.extractedDeadlineConfidenceBand,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, result.documentId));

    expect(row?.extractedDeadlineLabel).toBe("Insurance renewal");
    expect(row?.extractedDeadline).toEqual({ precision: "date", instantUtc: null, date: "2027-03-01", timezone: null, sourceText: null });
    expect(row?.extractedDeadlineSort?.toISOString().slice(0, 10)).toBe("2027-03-01");
    // 0.7 confidence with real thresholds (no risk_policies row configured -> defaults reviewThreshold=0.55,
    // highThreshold=0.85) lands as "needs_review", NOT the hardcoded "verified" other domains use.
    expect(row?.extractedDeadlineConfidenceBand).toBe("needs_review");
  });

  it("leaves the deadline fields null when no real deadline is found", async () => {
    const documents = makeService({ hasDeadline: false, label: null, iso_date: null, approximate_text: null });
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "note.txt",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("Just a note with no dates or obligations in it at all."),
    });
    createdDocumentIds.push(result.documentId);

    const [row] = await db
      .select({ extractedDeadline: schema.documents.extractedDeadline, extractedDeadlineLabel: schema.documents.extractedDeadlineLabel })
      .from(schema.documents)
      .where(eq(schema.documents.id, result.documentId));
    expect(row?.extractedDeadline).toBeNull();
    expect(row?.extractedDeadlineLabel).toBeNull();
  });
});
