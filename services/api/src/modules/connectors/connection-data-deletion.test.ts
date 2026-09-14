import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { deleteConnectionData } from "./connection-data-deletion";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * "Disconnect & delete data" hard-deletes the purchases, bills, warranties, calendar events and shipments a
 * connection produced, and clears the attention items pointing at them so Needs You never shows a card for
 * data that no longer exists. It never touched search_documents.
 *
 * That matters more than a stale row usually would, because search_documents.title and body_text are
 * deliberately PLAINTEXT - the source columns are encrypted at rest and cannot be searched, which is the
 * entire reason the index exists. So a user who disconnected a mailbox and asked for its data to be deleted
 * kept a readable copy of those purchases and bills in the database indefinitely.
 *
 * Six of the twelve indexed resource types have no markDeleted caller anywhere in the app (purchase, bill,
 * warranty, subscription, shipment, return_case) precisely because they are hard-deleted rather than
 * soft-deleted, and this worker is where that happens - so this was the only place the cleanup could live.
 *
 * The shipment case is separate on purpose: shipments reach deletion two different ways, directly by
 * inbox_item link and indirectly by cascade from purchases, and only the first has an id still available
 * after the delete.
 */
describe("deleteConnectionData", () => {
  let db: Database;
  let dbAvailable = true;
  let setupError: Error | null = null;

  const userId = generateId("user");
  const connectionId = generateId("connection");
  const sourceEventId = generateId("sourceEvent");
  const purchaseId = generateId("purchase");
  const billId = generateId("bill");
  const linkedShipmentId = generateId("shipment");
  const cascadedShipmentId = generateId("shipment");
  const searchId = (type: string, id: string) => `${type}:${id}`;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.insert(schema.users).values({ id: userId, email: `conn-del-${userId}@example.com`, displayName: "Connection Deletion" });
    } catch {
      dbAvailable = false;
      return;
    }
    try {
      await db.insert(schema.connections).values({ id: connectionId, ownerUserId: userId, provider: "gmail", feasibilityClass: "full" });
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId: userId,
        connectionId,
        kind: "email",
        contentHash: `hash-${sourceEventId}`,
        occurredAt: new Date(),
        idempotencyKey: `idem-${sourceEventId}`,
      });

      const purchaseDate = { date: "2026-01-05", timezone: null, precision: "date", instantUtc: null, sourceText: null } as const;
      await db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId: userId,
        sourceEventId,
        purchaseDate,
        confidenceBand: "high",
      });
      await db.insert(schema.bills).values({
        id: billId,
        ownerUserId: userId,
        billerLabel: "Deleted Utility",
        dueDate: purchaseDate,
      });
      // Found by inbox_item link, like bills and warranties.
      await db.insert(schema.shipments).values({
        id: linkedShipmentId,
        ownerUserId: userId,
        carrier: "ups",
        trackingNumber: "1Z-LINKED",
      });
      // Found only by cascade from the purchase - its row is gone before the cleanup could look it up.
      await db.insert(schema.shipments).values({
        id: cascadedShipmentId,
        ownerUserId: userId,
        purchaseId,
        carrier: "ups",
        trackingNumber: "1Z-CASCADED",
      });

      await db.insert(schema.inboxItems).values({
        id: generateId("inboxItem"),
        ownerUserId: userId,
        sourceEventId,
        category: "bill",
        summary: "Deleted Utility bill",
        suggestedActions: [],
        confidenceBand: "high",
        linkedResourceType: "bill",
        linkedResourceId: billId,
      });
      await db.insert(schema.inboxItems).values({
        id: generateId("inboxItem"),
        ownerUserId: userId,
        sourceEventId,
        category: "shipment",
        summary: "Package on the way",
        suggestedActions: [],
        confidenceBand: "high",
        linkedResourceType: "shipment",
        linkedResourceId: linkedShipmentId,
      });

      // The plaintext copies. Body text is what a stranded row would leave readable.
      await db.insert(schema.searchDocuments).values([
        {
          id: searchId("purchase", purchaseId),
          ownerUserId: userId,
          resourceType: "purchase",
          resourceId: purchaseId,
          sensitivity: "sensitive",
          title: "Deleted Purchase",
          bodyText: "plaintext purchase body",
        },
        {
          id: searchId("bill", billId),
          ownerUserId: userId,
          resourceType: "bill",
          resourceId: billId,
          sensitivity: "sensitive",
          title: "Deleted Utility",
          bodyText: "plaintext bill body",
        },
        {
          id: searchId("shipment", linkedShipmentId),
          ownerUserId: userId,
          resourceType: "shipment",
          resourceId: linkedShipmentId,
          sensitivity: "sensitive",
          title: "Linked Shipment",
          bodyText: "plaintext shipment body",
        },
        {
          id: searchId("shipment", cascadedShipmentId),
          ownerUserId: userId,
          resourceType: "shipment",
          resourceId: cascadedShipmentId,
          sensitivity: "sensitive",
          title: "Cascaded Shipment",
          bodyText: "plaintext cascaded shipment body",
        },
      ]);
    } catch (error) {
      setupError = error as Error;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("set the fixture up", () => {
    if (!dbAvailable) return;
    expect(setupError, setupError?.message).toBeNull();
  });

  it("deletes the derived rows and their plaintext search index together", async () => {
    if (!dbAvailable || setupError) return;

    // Present first, or "gone afterwards" proves nothing.
    const indexBefore = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, userId));
    expect(indexBefore).toHaveLength(4);
    expect(await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId))).toHaveLength(1);

    await deleteConnectionData(db, { connectionId, ownerUserId: userId });

    // The source rows, which already worked.
    expect(await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId))).toHaveLength(0);
    expect(await db.select().from(schema.bills).where(eq(schema.bills.id, billId))).toHaveLength(0);
    expect(
      await db.select().from(schema.shipments).where(inArray(schema.shipments.id, [linkedShipmentId, cascadedShipmentId])),
      "both shipments, one deleted directly and one by cascade",
    ).toHaveLength(0);

    // The index, which did not.
    const indexAfter = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, userId));
    expect(indexAfter.map((r) => r.id), "a plaintext copy of deleted data must not survive the deletion").toEqual([]);
  });

  it("leaves no index row whose source row is gone", async () => {
    if (!dbAvailable || setupError) return;
    // Stated as the property rather than as four ids, because a seventh indexed type added later should
    // fail this too rather than pass by not being listed.
    const stranded = await db
      .select({ id: schema.searchDocuments.id, resourceType: schema.searchDocuments.resourceType, resourceId: schema.searchDocuments.resourceId })
      .from(schema.searchDocuments)
      .where(eq(schema.searchDocuments.ownerUserId, userId));
    expect(stranded).toEqual([]);
  });

  it("still writes the audit event", async () => {
    if (!dbAvailable || setupError) return;
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.actorId, userId), eq(schema.auditEvents.action, "connection.delete_derived_data")));
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe("success");
  });
});
