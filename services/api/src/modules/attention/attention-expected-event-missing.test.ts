import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { and, eq, like } from "drizzle-orm";
import { AttentionService } from "./attention.service";

/**
 * Notifications backlog "expected-event monitor" (part 4 — absent paycheck/missing bill detection).
 * recurringStreams.nextExpectedDate is only ever moved forward by real evidence (a new subscription email
 * — see IngestionService.extractSubscription), so a stream that's essential and stuck more than the grace
 * window in the past is treated as a missed cycle. Real DB-backed proof: a genuinely late essential stream
 * gets filed, the same missed cycle doesn't get refiled on a second tick, and a stream that's barely late
 * or not essential is left alone.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const attention = new AttentionService(db, {} as never);

const ownerId = generateId("user");
const lateEssentialStreamId = generateId("recurringStream");
const withinGraceStreamId = generateId("recurringStream");
const nonEssentialStreamId = generateId("recurringStream");

function dateOnly(d: Date) {
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Expected Event Test User" });

  const wellPastGrace = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days late — past the 3-day grace window
  const barelyLate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day late — inside the grace window

  await db.insert(schema.recurringStreams).values([
    {
      id: lateEssentialStreamId,
      ownerUserId: ownerId,
      serviceLabel: "Essential Gym Membership",
      cadence: "monthly",
      typicalAmountMinorUnits: 5000,
      typicalAmountCurrency: "USD",
      nextExpectedDate: { precision: "date", instantUtc: null, date: dateOnly(wellPastGrace), timezone: null, sourceText: null },
      essential: true,
    },
    {
      id: withinGraceStreamId,
      ownerUserId: ownerId,
      serviceLabel: "Essential Streaming Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 1500,
      typicalAmountCurrency: "USD",
      nextExpectedDate: { precision: "date", instantUtc: null, date: dateOnly(barelyLate), timezone: null, sourceText: null },
      essential: true,
    },
    {
      id: nonEssentialStreamId,
      ownerUserId: ownerId,
      serviceLabel: "Non-Essential Hobby Subscription",
      cadence: "monthly",
      typicalAmountMinorUnits: 999,
      typicalAmountCurrency: "USD",
      nextExpectedDate: { precision: "date", instantUtc: null, date: dateOnly(wellPastGrace), timezone: null, sourceText: null },
      essential: false,
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.attentionItems).where(like(schema.attentionItems.linkedResourceId, `${lateEssentialStreamId}:%`));
  await db.delete(schema.recurringStreams).where(eq(schema.recurringStreams.id, lateEssentialStreamId));
  await db.delete(schema.recurringStreams).where(eq(schema.recurringStreams.id, withinGraceStreamId));
  await db.delete(schema.recurringStreams).where(eq(schema.recurringStreams.id, nonEssentialStreamId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("AttentionService.scanForMissingExpectedEvents", () => {
  it("files a real attention item for an essential stream well past its grace window", async () => {
    await attention.scanForMissingExpectedEvents();

    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(
        and(
          eq(schema.attentionItems.linkedResourceType, "recurring_stream"),
          like(schema.attentionItems.linkedResourceId, `${lateEssentialStreamId}:%`),
        ),
      );

    expect(items.length).toBe(1);
    const [item] = items;
    expect(item?.reasonCode).toBe("expected_event_missing");
    expect(item?.reasonText).toContain("Essential Gym Membership");
    expect(item?.reasonText).toContain("hasn't arrived");
    expect(item?.confidenceBand).toBe("needs_review");
    expect(item?.ownerUserId).toBe(ownerId);
    expect(item?.moneyAtStakeMinorUnits).toBe(5000);
  });

  it("does not file a duplicate for the same missed cycle on a second scan", async () => {
    await attention.scanForMissingExpectedEvents();

    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(
        and(
          eq(schema.attentionItems.linkedResourceType, "recurring_stream"),
          like(schema.attentionItems.linkedResourceId, `${lateEssentialStreamId}:%`),
        ),
      );
    expect(items.length).toBe(1);
  });

  it("does not flag a stream still within its grace window", async () => {
    await attention.scanForMissingExpectedEvents();

    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(
        and(
          eq(schema.attentionItems.linkedResourceType, "recurring_stream"),
          like(schema.attentionItems.linkedResourceId, `${withinGraceStreamId}:%`),
        ),
      );
    expect(items.length).toBe(0);
  });

  it("does not flag a non-essential stream even when well past its grace window", async () => {
    await attention.scanForMissingExpectedEvents();

    const items = await db
      .select()
      .from(schema.attentionItems)
      .where(
        and(
          eq(schema.attentionItems.linkedResourceType, "recurring_stream"),
          like(schema.attentionItems.linkedResourceId, `${nonEssentialStreamId}:%`),
        ),
      );
    expect(items.length).toBe(0);
  });
});
