import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { and, eq } from "drizzle-orm";
import { AttentionService } from "./attention.service";

/**
 * DOC-005 "deadline/obligation extraction" — the other half of the feature: a document's AI-extracted
 * deadline (documents.service.ts) must actually surface as a real attention item as it approaches, the
 * same way bills/warranties/return deadlines already do. Real DB-backed proof, including that the
 * document's own real confidence band (not a hardcoded "verified") carries through onto the filed item.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const attention = new AttentionService(db, {} as never);

const ownerId = generateId("user");
const documentId = generateId("document");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Owner" });
  const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days out — inside the 14-day lookahead
  await db.insert(schema.documents).values({
    id: documentId,
    ownerUserId: ownerId,
    documentType: "insurance_policy",
    title: "Homeowners policy",
    tags: [],
    extractedDeadline: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null },
    extractedDeadlineSort: soon,
    extractedDeadlineLabel: "Insurance renewal",
    extractedDeadlineConfidenceBand: "needs_review",
  });
});

afterAll(async () => {
  await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, documentId));
  await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("AttentionService.scanAndFileDeadlines — document deadlines (DOC-005)", () => {
  it("files a real attention item for an approaching document deadline, carrying through its real confidence band", async () => {
    await attention.scanAndFileDeadlines();

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "document"), eq(schema.attentionItems.linkedResourceId, documentId)));

    expect(item).toBeDefined();
    expect(item?.reasonCode).toBe("document_deadline");
    expect(item?.reasonText).toContain("Insurance renewal");
    expect(item?.reasonText).toContain("Homeowners policy");
    expect(item?.confidenceBand).toBe("needs_review"); // the document's own real band, not hardcoded "verified"
    expect(item?.ownerUserId).toBe(ownerId);
  });

  it("does not file a duplicate on a second scan", async () => {
    await attention.scanAndFileDeadlines();
    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "document"), eq(schema.attentionItems.linkedResourceId, documentId)));
    expect(items.length).toBe(1);
  });
});
