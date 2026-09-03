import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { DataIntegrityService } from "./data-integrity.service";

/**
 * §Operations "data-integrity/orphan-check job" — attention_items.linked_resource_id,
 * notifications.linked_attention_item_id, and the JSONB *_entity_ids arrays have no real DB foreign-key
 * constraint (see DataIntegrityService's own doc comment), so nothing ever prevents them from dangling
 * after their target row is deleted. Real DB-backed proof: each of the three checks flags a genuinely
 * dangling link it's seeded, and leaves a genuinely valid one (whose target row still exists) alone.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const dataIntegrity = new DataIntegrityService(db);

const ownerId = generateId("user");

const validBillId = generateId("bill");
const orphanAttentionItemId = generateId("attentionItem");
const validAttentionItemId = generateId("attentionItem");

const validNotificationTargetId = generateId("attentionItem");
const orphanNotificationId = generateId("notification");
const validNotificationId = generateId("notification");

const validPersonId = generateId("entity");
const orphanPurchaseId = generateId("purchase");
const validPurchaseId = generateId("purchase");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Data Integrity Test User" });

  await db.insert(schema.bills).values({
    id: validBillId,
    ownerUserId: ownerId,
    billerLabel: "Real bill — valid attention_items target",
    dueDate: { precision: "date", date: "2030-01-01", instantUtc: null, timezone: null, sourceText: null },
  });

  await db.insert(schema.attentionItems).values([
    {
      id: orphanAttentionItemId,
      ownerUserId: ownerId,
      reasonCode: "test_orphan",
      reasonText: "Points at a document that was never inserted",
      urgency: "useful",
      confidenceBand: "verified",
      linkedResourceType: "document",
      linkedResourceId: generateId("document"),
    },
    {
      id: validAttentionItemId,
      ownerUserId: ownerId,
      reasonCode: "test_valid",
      reasonText: "Points at a real bill",
      urgency: "useful",
      confidenceBand: "verified",
      linkedResourceType: "bill",
      linkedResourceId: validBillId,
    },
    {
      id: validNotificationTargetId,
      ownerUserId: ownerId,
      reasonCode: "test_notification_target",
      reasonText: "Real attention_items row a notification links to",
      urgency: "useful",
      confidenceBand: "verified",
    },
  ]);

  await db.insert(schema.notifications).values([
    {
      id: orphanNotificationId,
      ownerUserId: ownerId,
      dedupeKey: `test-orphan-${orphanNotificationId}`,
      priority: "low",
      channel: "in_app",
      title: "Orphan notification",
      body: "Points at an attention_items row that was never inserted",
      linkedAttentionItemId: generateId("attentionItem"),
      scheduledFor: new Date(),
    },
    {
      id: validNotificationId,
      ownerUserId: ownerId,
      dedupeKey: `test-valid-${validNotificationId}`,
      priority: "low",
      channel: "in_app",
      title: "Valid notification",
      body: "Points at a real attention_items row",
      linkedAttentionItemId: validNotificationTargetId,
      scheduledFor: new Date(),
    },
  ]);

  await db.insert(schema.canonicalEntities).values({
    id: validPersonId,
    type: "person",
    ownerUserId: ownerId,
    displayLabel: "Real person — valid linkedEntityIds target",
    aliases: [],
    lifecycleState: "active",
  });

  // Exercises the JSONB entity-array check against `people.relatedEntityIds`. The original fixture used
  // `purchases.linkedEntityIds`, which that table no longer has on the current schema (see
  // scanJsonbArrayLinks' own doc comment) — `people` is the cheapest surviving array column to insert
  // into, needing only id/ownerUserId/displayName.
  await db.insert(schema.people).values([
    {
      id: orphanPurchaseId,
      ownerUserId: ownerId,
      displayName: "Person with a dangling related-entity link",
      relatedEntityIds: [generateId("entity")],
    },
    {
      id: validPurchaseId,
      ownerUserId: ownerId,
      displayName: "Person with a valid related-entity link",
      relatedEntityIds: [validPersonId],
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.people).where(eq(schema.people.ownerUserId, ownerId));
  await db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.ownerUserId, ownerId));
  await db.delete(schema.notifications).where(eq(schema.notifications.ownerUserId, ownerId));
  await db.delete(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, ownerId));
  await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("DataIntegrityService.scanForOrphans", () => {
  it("flags an attention_item pointing at a document that no longer exists, and leaves a valid one alone", async () => {
    const result = await dataIntegrity.scanForOrphans();
    expect(result.attentionItemLinkOrphans.orphanIds).toContain(orphanAttentionItemId);
    expect(result.attentionItemLinkOrphans.orphanIds).not.toContain(validAttentionItemId);
  });

  it("flags a notification pointing at an attention_item that no longer exists, and leaves a valid one alone", async () => {
    const result = await dataIntegrity.scanForOrphans();
    expect(result.notificationAttentionItemOrphans.orphanIds).toContain(orphanNotificationId);
    expect(result.notificationAttentionItemOrphans.orphanIds).not.toContain(validNotificationId);
  });

  it("flags a people row whose relatedEntityIds contains an id that resolves to nothing, and leaves a valid link alone", async () => {
    const result = await dataIntegrity.scanForOrphans();
    const purchaseFinding = result.jsonbArrayOrphans["people.relatedEntityIds"]!;
    expect(purchaseFinding.orphanIds).toContain(orphanPurchaseId);
    expect(purchaseFinding.orphanIds).not.toContain(validPurchaseId);
  });
});
