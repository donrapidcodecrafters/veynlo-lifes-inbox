import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { AttentionService } from "./attention.service";

/**
 * §52.1 screen inventory items 018/019 — Home previously only had "Today" and "Needs You" (see
 * AttentionService.home/today); "Coming Up" (the next N days) and "Money at Risk" (unresolved items with
 * real money on the line) didn't exist at all. Real DB-backed proof both surface real data and respect
 * their intended boundaries (today's own items excluded from Coming Up; items with no money excluded from
 * Money at Risk).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const attention = new AttentionService(db, {} as never);

const ownerId = generateId("user");
const billTodayId = generateId("bill");
const billNextWeekId = generateId("bill");
const billFarFutureId = generateId("bill");
const attentionMoneyId = generateId("attentionItem");
const attentionNoMoneyId = generateId("attentionItem");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Coming Up / Money At Risk Test User" });

  const today = new Date();
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(schema.bills).values([
    {
      id: billTodayId,
      ownerUserId: ownerId,
      billerLabel: "Due today — should NOT appear in Coming Up",
      dueDate: { precision: "date", date: today.toISOString().slice(0, 10), instantUtc: null, timezone: null, sourceText: null },
      dueDateSort: today,
    },
    {
      id: billNextWeekId,
      ownerUserId: ownerId,
      billerLabel: "Due in 3 days — should appear in Coming Up",
      dueDate: { precision: "date", date: in3Days.toISOString().slice(0, 10), instantUtc: null, timezone: null, sourceText: null },
      dueDateSort: in3Days,
    },
    {
      id: billFarFutureId,
      ownerUserId: ownerId,
      billerLabel: "Due in 30 days — outside the default 7-day window",
      dueDate: { precision: "date", date: in30Days.toISOString().slice(0, 10), instantUtc: null, timezone: null, sourceText: null },
      dueDateSort: in30Days,
    },
  ]);

  await db.insert(schema.attentionItems).values([
    {
      id: attentionMoneyId,
      ownerUserId: ownerId,
      reasonCode: "bill_due_soon",
      reasonText: "Electric bill — real money at stake",
      urgency: "important",
      moneyAtStakeMinorUnits: 4599,
      moneyAtStakeCurrency: "USD",
      confidenceBand: "verified",
      resolved: false,
    },
    {
      id: attentionNoMoneyId,
      ownerUserId: ownerId,
      reasonCode: "connector_reauth_needed",
      reasonText: "Reconnect Gmail — no money involved",
      urgency: "important",
      moneyAtStakeMinorUnits: null,
      confidenceBand: "verified",
      resolved: false,
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.attentionItems).where(inArray(schema.attentionItems.id, [attentionMoneyId, attentionNoMoneyId]));
  await db.delete(schema.bills).where(inArray(schema.bills.id, [billTodayId, billNextWeekId, billFarFutureId]));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("AttentionService.comingUp", () => {
  it("includes items within the window but excludes today's own items and items beyond the window", async () => {
    const result = await attention.comingUp(ownerId, 7);
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(billNextWeekId);
    expect(ids).not.toContain(billTodayId);
    expect(ids).not.toContain(billFarFutureId);
  });

  it("a wider window picks up the far-future item too", async () => {
    const result = await attention.comingUp(ownerId, 45);
    expect(result.items.map((i) => i.id)).toContain(billFarFutureId);
  });
});

describe("AttentionService.moneyAtRisk", () => {
  it("includes only unresolved items with real money at stake, summed correctly", async () => {
    const result = await attention.moneyAtRisk(ownerId);
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(attentionMoneyId);
    expect(ids).not.toContain(attentionNoMoneyId);
    expect(result.totalMinorUnits).toBeGreaterThanOrEqual(4599);
    expect(result.currency).toBe("USD");
  });
});
