import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SearchIndexService } from "../search/search-index.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { DocumentsService } from "./documents.service";

/**
 * The upload MIME check was previously just the client-supplied Content-Type header — fully
 * attacker-controlled, so an HTML/script payload (or anything else) mislabeled as "application/pdf" would
 * sail straight through the allowlist and get stored/served back under that claimed type. Proves the new
 * magic-byte sniff (file-type, real library, no mocking) genuinely rejects content that doesn't match its
 * claimed type, and doesn't false-positive-reject genuine files.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

// A real, valid 1x1 transparent PNG (well-known minimal test image).
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// A real, minimal valid PDF.
const REAL_PDF = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF", "latin1");
const HTML_PAYLOAD = Buffer.from("<html><body><script>alert(1)</script></body></html>", "utf8");
const PLAIN_TEXT = Buffer.from("Just a normal receipt note, nothing binary here.", "utf8");

function makeService() {
  const storage = { putObject: vi.fn(async () => undefined) };
  const ai = { isConfigured: () => false };
  const malwareScanner = { isConfigured: () => false };
  const billing = { getCapability: vi.fn(async () => null) };
  const searchIndex = new SearchIndexService(db);
  return new DocumentsService(db, storage as never, ai as never, malwareScanner as never, {} as never, {} as never, searchIndex, billing as never, new RiskPolicyService(db));
}

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

describe("DocumentsService.upload — magic-byte content verification", () => {
  it("rejects an HTML/script payload mislabeled as application/pdf", async () => {
    const documents = makeService();
    await expect(
      documents.upload({ ownerUserId: ownerId, householdId: null, title: "fake.pdf", documentType: "other", mimeType: "application/pdf", buffer: HTML_PAYLOAD }),
    ).rejects.toMatchObject({ response: { code: "FILE_CONTENT_MISMATCH" } });
  });

  it("rejects a real PNG mislabeled as application/pdf", async () => {
    const documents = makeService();
    await expect(
      documents.upload({ ownerUserId: ownerId, householdId: null, title: "fake2.pdf", documentType: "other", mimeType: "application/pdf", buffer: REAL_PNG }),
    ).rejects.toMatchObject({ response: { code: "FILE_CONTENT_MISMATCH" } });
  });

  it("rejects real binary (PDF) content mislabeled as text/plain", async () => {
    const documents = makeService();
    await expect(
      documents.upload({ ownerUserId: ownerId, householdId: null, title: "fake.txt", documentType: "other", mimeType: "text/plain", buffer: REAL_PDF }),
    ).rejects.toMatchObject({ response: { code: "FILE_CONTENT_MISMATCH" } });
  });

  it("accepts a genuine PDF correctly claimed as application/pdf", async () => {
    const documents = makeService();
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "real.pdf",
      documentType: "other",
      mimeType: "application/pdf",
      buffer: REAL_PDF,
    });
    createdDocumentIds.push(result.documentId);
    expect(result.duplicate).toBeUndefined();
  });

  it("accepts genuine plain text correctly claimed as text/plain", async () => {
    const documents = makeService();
    const result = await documents.upload({
      ownerUserId: ownerId,
      householdId: null,
      title: "real.txt",
      documentType: "other",
      mimeType: "text/plain",
      buffer: PLAIN_TEXT,
    });
    createdDocumentIds.push(result.documentId);
    expect(result.duplicate).toBeUndefined();
    const [version] = await db.select({ ocrText: schema.documentVersions.ocrText }).from(schema.documentVersions).where(eq(schema.documentVersions.documentId, result.documentId));
    expect(version?.ocrText).toBe(PLAIN_TEXT.toString("utf8"));
  });
});
