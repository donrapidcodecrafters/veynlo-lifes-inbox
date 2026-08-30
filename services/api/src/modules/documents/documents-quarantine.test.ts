import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchIndexService } from "../search/search-index.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { DocumentsService } from "./documents.service";

/**
 * A malware-infected upload used to be a hard pre-record rejection -- no lasting trace at all, just an
 * error toast. Real DB-backed proof a real, visible, deletable "quarantined" document row is created
 * instead, with no version/blob ever stored for the infected bytes.
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

function makeService(infected: boolean) {
  const storage = { putObject: vi.fn(async () => undefined) };
  const ai = { isConfigured: () => false, extractStructured: vi.fn(async () => null) };
  const malwareScanner = {
    isConfigured: () => true,
    scan: vi.fn(async () => (infected ? { infected: true, signature: "EICAR-Test-File" } : { infected: false })),
  };
  const billing = { getCapability: vi.fn(async () => null) };
  const searchIndex = new SearchIndexService(db);
  const riskPolicy = new RiskPolicyService(db);
  return new DocumentsService(db, storage as never, ai as never, malwareScanner as never, {} as never, {} as never, searchIndex, billing as never, riskPolicy);
}

describe("DocumentsService.upload — malware quarantine", () => {
  it("creates a real, visible quarantined document row instead of just throwing", async () => {
    const documents = makeService(true);
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "definitely-not-malware.pdf",
      documentType: "other",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nfake-but-infected"),
    });
    createdDocumentIds.push(result.documentId);
    expect(result.quarantined).toBe(true);

    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, result.documentId));
    expect(row?.processingState).toBe("quarantined");
    expect(row?.processingError).toContain("EICAR-Test-File");
    expect(row?.currentVersionId).toBeNull();

    // Never stores a version/blob for the infected bytes.
    const versions = await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.documentId, result.documentId));
    expect(versions.length).toBe(0);

    // Real, deletable record — the same generic delete path works on it.
    await documents.deleteDocument(result.documentId, ownerId);
    const [afterDelete] = await db.select().from(schema.documents).where(eq(schema.documents.id, result.documentId));
    expect(afterDelete).toBeUndefined();
    createdDocumentIds.splice(createdDocumentIds.indexOf(result.documentId), 1);
  });

  it("a clean file still uploads normally (no quarantine false-positive)", async () => {
    const documents = makeService(false);
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "clean.txt",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("This is a perfectly ordinary, harmless text file."),
    });
    createdDocumentIds.push(result.documentId);
    expect(result.quarantined).toBeUndefined();

    const [row] = await db.select({ processingState: schema.documents.processingState }).from(schema.documents).where(eq(schema.documents.id, result.documentId));
    expect(row?.processingState).not.toBe("quarantined");
  });
});
