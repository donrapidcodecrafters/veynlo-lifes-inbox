import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type DomainEvent } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import { EventBusService } from "../../events/event-bus.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;

/**
 * Real integration test against a real Postgres, mirroring attention.notify-urgent.test.ts's own shape.
 * Proves §42.3/42.4's event-bus infrastructure is genuinely wired into `AttentionService.insertAttentionItem`
 * (reached by `fileIfNew` via `scanAndFileDeadlines`) — a real `EventBusService` is passed in as the
 * (optional, trailing) constructor dependency, and the actual `AttentionCandidateCreated.v1` emission is
 * asserted against a listener registered directly on that bus, not a stub/mock standing in for the bus.
 */
describe("AttentionService — real event-bus emission", () => {
  let db: Database;
  let events: EventBusService;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;
  const billIds: string[] = [];
  let captured: Extract<DomainEvent, { type: "AttentionCandidateCreated.v1" }>[];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    events = new EventBusService();
    captured = [];
    events.on("AttentionCandidateCreated.v1", (event) => {
      captured.push(event);
    });
    attention = new AttentionService(db, stubHouseholds, stubNotifications, events);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-events-${ownerUserId}@example.com`, displayName: "Attention Events Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService event-bus tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of billIds) await db.delete(schema.bills).where(eq(schema.bills.id, id));
    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeBill(params: { daysFromNow: number; label: string }): Promise<string> {
    const billId = generateId("bill");
    billIds.push(billId);
    const dueDateSort = new Date(Date.now() + params.daysFromNow * 86_400_000);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: params.label,
      amountDueMinorUnits: 5_000,
      amountDueCurrency: "USD",
      dueDate: { precision: "date", instantUtc: null, date: dueDateSort.toISOString().slice(0, 10), timezone: null, sourceText: null },
      dueDateSort,
    });
    return billId;
  }

  it("fires AttentionCandidateCreated.v1 with the real attention_item id when a new item is filed", async () => {
    if (!dbAvailable) return;
    captured.length = 0;
    const billId = await makeBill({ daysFromNow: 5, label: "Events Test Electric Co" });
    await attention.scanAndFileDeadlines();

    const event = captured.find((e) => e.payload.linkedResourceId === billId);
    expect(event).toBeDefined();
    expect(event!.payload.reasonCode).toBe("bill_due");
    expect(event!.payload.urgency).toBe("important"); // urgencyFor(5) === "important"
    expect(event!.payload.linkedResourceType).toBe("bill");
    expect(event!.ownerUserId).toBe(ownerUserId);
    expect(event!.aggregateType).toBe("attention_item");

    // The event's aggregateId/payload.attentionItemId must be the real row's own id, not a placeholder.
    const [item] = await db.select().from(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, billId));
    expect(item).toBeDefined();
    expect(event!.aggregateId).toBe(item!.id);
    expect(event!.payload.attentionItemId).toBe(item!.id);
  });

  it("does not re-fire AttentionCandidateCreated.v1 for an item that was already filed (fileIfNew's own dedup)", async () => {
    if (!dbAvailable) return;
    captured.length = 0;
    const billId = await makeBill({ daysFromNow: 6, label: "Events Test Repeat Water Co" });
    await attention.scanAndFileDeadlines();
    expect(captured.filter((e) => e.payload.linkedResourceId === billId)).toHaveLength(1);

    captured.length = 0;
    await attention.scanAndFileDeadlines();
    expect(captured.filter((e) => e.payload.linkedResourceId === billId)).toHaveLength(0);
  });
});
