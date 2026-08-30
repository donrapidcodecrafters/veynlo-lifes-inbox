import { describe, expect, it, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { TimelineService } from "./timeline.service";

/**
 * TIME-001 "search box" — the timeline union query returns encrypted ciphertext for several kinds
 * (calendar_event/bill/warranty/document titles), so a text search can only ever work against
 * search_documents (built from real plaintext at write time), never against the union's own columns.
 * Real proof the join-based filter actually narrows results, using genuinely separate search terms so a
 * false match (matching everything, or matching nothing) would fail these assertions.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const timeline = new TimelineService(db);

const ownerId = generateId("user");
const purchaseId = generateId("purchase");
const billId = generateId("bill");
const searchDocIds: string[] = [];

afterAll(async () => {
  await db.delete(schema.searchDocuments).where(inArray(schema.searchDocuments.id, searchDocIds));
  await db.delete(schema.bills).where(eq(schema.bills.id, billId));
  await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("TimelineService.getTimeline — search", () => {
  it("filters to only items whose search_documents entry matches the search term", async () => {
    await db.insert(schema.users).values({ id: ownerId, displayName: "Timeline Search Test User" });
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId: ownerId,
      purchaseDate: { precision: "date", date: "2026-08-01", instantUtc: null, timezone: null, sourceText: null },
      purchaseDateSort: new Date("2026-08-01"),
      state: "kept",
      confidenceBand: "verified",
    });
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId: ownerId,
      billerLabel: "Totally Different Biller",
      dueDate: { precision: "date", date: "2026-08-05", instantUtc: null, timezone: null, sourceText: null },
      dueDateSort: new Date("2026-08-05"),
    });
    const purchaseSearchDocId = generateId("searchDocument");
    const billSearchDocId = generateId("searchDocument");
    searchDocIds.push(purchaseSearchDocId, billSearchDocId);
    await db.insert(schema.searchDocuments).values([
      { id: purchaseSearchDocId, ownerUserId: ownerId, resourceType: "purchase", resourceId: purchaseId, sensitivity: "sensitive", title: "Acme Snowblower Corp", bodyText: "" },
      { id: billSearchDocId, ownerUserId: ownerId, resourceType: "bill", resourceId: billId, sensitivity: "sensitive", title: "Totally Different Biller", bodyText: "" },
    ]);

    const acmeResults = await timeline.getTimeline(ownerId, null, null, "snowblower");
    expect(acmeResults.items.map((i) => i.id)).toEqual([purchaseId]);

    const billerResults = await timeline.getTimeline(ownerId, null, null, "Different Biller");
    expect(billerResults.items.map((i) => i.id)).toEqual([billId]);

    const noMatch = await timeline.getTimeline(ownerId, null, null, "nonexistent-search-term-xyz");
    expect(noMatch.items).toEqual([]);
  });

  it("an empty/whitespace search term behaves exactly like no search at all", async () => {
    const withEmptySearch = await timeline.getTimeline(ownerId, null, null, "   ");
    const withoutSearch = await timeline.getTimeline(ownerId, null, null, null);
    expect(withEmptySearch.items.map((i) => i.id).sort()).toEqual(withoutSearch.items.map((i) => i.id).sort());
    expect(withoutSearch.items.length).toBeGreaterThanOrEqual(2); // both the purchase and bill from setup
  });
});
