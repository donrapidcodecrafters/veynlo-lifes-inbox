import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * UTIL-001 "equipment return obligations ... from source messages where available" — the deadline scan
 * over `bills.equipmentReturnDeadlineSort` (see IngestionService.extractBill and
 * packages/db/src/schema/commerce.ts's own doc comment: explicit-only, never inferred). Proves: a bill with
 * an equipment-return deadline inside the 14-day lookahead files a real "equipment_return_due" attention
 * item; re-running the scan doesn't duplicate it; and — the specific bug this test guards against — a bill
 * that ALSO has its own due date inside the lookahead window still gets both a "bill_due" item AND a
 * separate "equipment_return_due" item, because they're filed under different `linkedResourceType` keys
 * (fileIfNew's dedup is keyed on (linkedResourceType, linkedResourceId) with no reasonCode in that key, so
 * reusing "bill" for both would have silently dropped whichever filed second).
 */
describe("AttentionService.scanAndFileDeadlines — equipment return deadlines (UTIL-001)", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;
  const createdBillIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `equipment-return-${ownerUserId}@example.com`, displayName: "Equipment Return Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService equipment-return tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdBillIds) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, id));
      await db.delete(schema.bills).where(eq(schema.bills.id, id));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  function inDays(days: number): { temporal: { precision: "date"; instantUtc: null; date: string; timezone: null; sourceText: null }; sort: Date } {
    const sort = new Date(Date.now() + days * 86_400_000);
    return { temporal: { precision: "date", instantUtc: null, date: sort.toISOString().slice(0, 10), timezone: null, sourceText: null }, sort };
  }

  it("files an equipment_return_due attention item for a bill with an explicit equipment-return deadline, and doesn't duplicate it on a second scan", async () => {
    if (!dbAvailable) return;
    const equipmentDeadline = inDays(5);
    const dueDate = inDays(20); // outside the 14-day lookahead, so bill_due should NOT also fire here
    const billId = generateId("bill");
    createdBillIds.push(billId);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: "Regional Cable Co",
      dueDate: dueDate.temporal,
      dueDateSort: dueDate.sort,
      equipmentReturnDeadline: equipmentDeadline.temporal,
      equipmentReturnDeadlineSort: equipmentDeadline.sort,
      equipmentReturnInstructions: "Return the cable box and remote to any Regional Cable Co store within 14 days.",
    });

    await attention.scanAndFileDeadlines();
    const itemsAfterFirstScan = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, billId));
    const equipmentItems = itemsAfterFirstScan.filter((i) => i.reasonCode === "equipment_return_due");
    expect(equipmentItems).toHaveLength(1);
    expect(equipmentItems[0]?.linkedResourceType).toBe("bill_equipment_return");
    expect(equipmentItems[0]?.reasonText).toContain("Regional Cable Co");

    await attention.scanAndFileDeadlines();
    const itemsAfterSecondScan = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, billId));
    expect(itemsAfterSecondScan.filter((i) => i.reasonCode === "equipment_return_due")).toHaveLength(1);
  });

  it("files BOTH bill_due and equipment_return_due for the same bill when both deadlines fall in the lookahead window", async () => {
    if (!dbAvailable) return;
    const dueDate = inDays(6);
    const equipmentDeadline = inDays(10);
    const billId = generateId("bill");
    createdBillIds.push(billId);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: "Home Security Monitoring",
      amountDueMinorUnits: 4_999,
      amountDueCurrency: "USD",
      dueDate: dueDate.temporal,
      dueDateSort: dueDate.sort,
      equipmentReturnDeadline: equipmentDeadline.temporal,
      equipmentReturnDeadlineSort: equipmentDeadline.sort,
      equipmentReturnInstructions: "Return the alarm panel within 10 days of cancellation.",
    });

    await attention.scanAndFileDeadlines();
    const items = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, billId));
    expect(items.some((i) => i.reasonCode === "bill_due")).toBe(true);
    expect(items.some((i) => i.reasonCode === "equipment_return_due")).toBe(true);
    // Two distinct attention_items rows, distinguished by linkedResourceType even though both point at the
    // same underlying bill id.
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.linkedResourceType))).toEqual(new Set(["bill", "bill_equipment_return"]));
  });

  it("does not file an equipment_return_due item for a bill with no equipment-return deadline set", async () => {
    if (!dbAvailable) return;
    const dueDate = inDays(6);
    const billId = generateId("bill");
    createdBillIds.push(billId);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: "Ordinary Internet Co",
      dueDate: dueDate.temporal,
      dueDateSort: dueDate.sort,
    });

    await attention.scanAndFileDeadlines();
    const items = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, billId));
    expect(items.some((i) => i.reasonCode === "equipment_return_due")).toBe(false);
  });
});
