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
 * HOME-001 "Attention engine scores candidates using urgency, severity, certainty, ... money at risk"
 * — found live via a fresh audit: `AttentionService.home()` previously returned the queue ordered purely
 * by `dueAtSort` ascending, with neither the web nor mobile Home screen re-sorting it client-side, so two
 * items with different urgency/confidence/money-at-stake but interleaved due dates came back in a plainly
 * wrong order (a low-value "useful" item due sooner ranked above a much higher-stakes "critical" item due
 * a bit later). This proves the composite ranking (urgency tier first, then confidence, then money at
 * stake, then due date) actually holds on real inserted rows read back through `home()`.
 */
describe("AttentionService.home — priority ranking", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;
  const itemIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `priority-rank-${ownerUserId}@example.com`, displayName: "Priority Rank Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService.home priority-ranking tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of itemIds) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, id));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeItem(params: {
    reasonCode: string;
    urgency: "critical" | "important" | "useful";
    confidenceBand: string;
    moneyAtStakeMinorUnits: number | null;
    daysFromNow: number;
  }): Promise<string> {
    const id = generateId("attentionItem");
    const dueAtSort = new Date(Date.now() + params.daysFromNow * 86_400_000);
    await db.insert(schema.attentionItems).values({
      id,
      ownerUserId,
      reasonCode: params.reasonCode,
      reasonText: params.reasonCode,
      urgency: params.urgency,
      dueAt: { precision: "date", instantUtc: null, date: dueAtSort.toISOString().slice(0, 10), timezone: null, sourceText: null },
      dueAtSort,
      moneyAtStakeMinorUnits: params.moneyAtStakeMinorUnits,
      moneyAtStakeCurrency: params.moneyAtStakeMinorUnits != null ? "USD" : null,
      confidenceBand: params.confidenceBand,
      linkedResourceType: "bill",
      linkedResourceId: id,
      primaryActions: [],
    });
    itemIds.push(id);
    return id;
  }

  it("ranks by urgency tier first, ahead of a sooner-but-lower-urgency item's due date", async () => {
    if (!dbAvailable) return;
    // Due sooner (2 days) but only "useful"/low value; the critical item is due a bit later (4 days) but
    // matters far more. A pure dueAtSort-ascending order would put the warranty first — that's the bug.
    const usefulSoon = await makeItem({ reasonCode: "warranty_expiring", urgency: "useful", confidenceBand: "verified", moneyAtStakeMinorUnits: 1000, daysFromNow: 2 });
    const criticalLater = await makeItem({ reasonCode: "bill_overdue", urgency: "critical", confidenceBand: "verified", moneyAtStakeMinorUnits: 60000, daysFromNow: 4 });

    const { items } = await attention.home(ownerUserId);
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(criticalLater)).toBeLessThan(ids.indexOf(usefulSoon));
  });

  it("within the same urgency tier, ranks higher money-at-stake first", async () => {
    if (!dbAvailable) return;
    const lowStake = await makeItem({ reasonCode: "return_window_closing", urgency: "important", confidenceBand: "verified", moneyAtStakeMinorUnits: 500, daysFromNow: 5 });
    const highStake = await makeItem({ reasonCode: "return_window_closing", urgency: "important", confidenceBand: "verified", moneyAtStakeMinorUnits: 50000, daysFromNow: 5 });

    const { items } = await attention.home(ownerUserId);
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(highStake)).toBeLessThan(ids.indexOf(lowStake));
  });

  it("within the same urgency tier and money, ranks verified confidence ahead of needs_review", async () => {
    if (!dbAvailable) return;
    const needsReview = await makeItem({ reasonCode: "vehicle_recall", urgency: "important", confidenceBand: "needs_review", moneyAtStakeMinorUnits: null, daysFromNow: 6 });
    const verified = await makeItem({ reasonCode: "vehicle_recall", urgency: "important", confidenceBand: "verified", moneyAtStakeMinorUnits: null, daysFromNow: 6 });

    const { items } = await attention.home(ownerUserId);
    const ids = items.map((i) => i.id);
    expect(ids.indexOf(verified)).toBeLessThan(ids.indexOf(needsReview));
  });
});
