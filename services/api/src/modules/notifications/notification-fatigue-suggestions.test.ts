import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { NotificationsService } from "./notifications.service";

/** Fatigue-feedback mechanism (§NOT-002 final part) — real DB test proving fatigueSuggestions() is
 * computed from actual acknowledgment data (Part 1's acknowledgedAt/actionTaken), same real-DB/
 * cross-user-isolation style as notifications.service.test.ts. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let notifications: NotificationsService;
const ownerId = generateId("user");
const otherUserId = generateId("user");
const insertedNotificationIds: string[] = [];

function makeNotification(overrides: Partial<typeof schema.notifications.$inferInsert> & { ownerUserId: string; category: string | null }) {
  const id = generateId("notification");
  insertedNotificationIds.push(id);
  return {
    id,
    dedupeKey: `test-fatigue-${id}`,
    priority: "useful" as const,
    channel: "push" as const,
    title: "test",
    body: "test",
    state: "sent" as const,
    scheduledFor: new Date(),
    sentAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  notifications = new NotificationsService(db);
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: otherUserId, displayName: "Other" },
  ]);

  const rows = [
    // "bill" — 5 sent, 4 unwanted (3 dismissed + 1 never acknowledged) = 80% >= 60% threshold
    ...Array.from({ length: 3 }, () => makeNotification({ ownerUserId: ownerId, category: "bill", actionTaken: "dismissed", acknowledgedAt: new Date() })),
    makeNotification({ ownerUserId: ownerId, category: "bill", actionTaken: null, acknowledgedAt: null }),
    makeNotification({ ownerUserId: ownerId, category: "bill", actionTaken: "opened", acknowledgedAt: new Date() }),
    // "shipment" — 5 sent, 2 unwanted = 40% < 60% threshold
    ...Array.from({ length: 3 }, () => makeNotification({ ownerUserId: ownerId, category: "shipment", actionTaken: "opened", acknowledgedAt: new Date() })),
    ...Array.from({ length: 2 }, () => makeNotification({ ownerUserId: ownerId, category: "shipment", actionTaken: "dismissed", acknowledgedAt: new Date() })),
    // "warranty" — only 4 sent, all dismissed — below the minimum sample size
    ...Array.from({ length: 4 }, () => makeNotification({ ownerUserId: ownerId, category: "warranty", actionTaken: "dismissed", acknowledgedAt: new Date() })),
    // "subscription" — 5 sent, all dismissed, but already muted via categoryOverrides
    ...Array.from({ length: 5 }, () => makeNotification({ ownerUserId: ownerId, category: "subscription", actionTaken: "dismissed", acknowledgedAt: new Date() })),
    // otherUserId — 5 sent, all dismissed "bill", must never leak into ownerId's suggestions
    ...Array.from({ length: 5 }, () => makeNotification({ ownerUserId: otherUserId, category: "bill", actionTaken: "dismissed", acknowledgedAt: new Date() })),
  ];
  await db.insert(schema.notifications).values(rows);
  await db.insert(schema.notificationPreferences).values([{ userId: ownerId, categoryOverrides: { subscription: "off" } }]);
});

afterAll(async () => {
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, insertedNotificationIds));
  await db.delete(schema.notificationPreferences).where(inArray(schema.notificationPreferences.userId, [ownerId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, otherUserId]));
});

describe("NotificationsService.fatigueSuggestions", () => {
  it("suggests a category with >=5 sent and >=60% dismissed/unacknowledged, with a correct unwantedRate", async () => {
    const suggestions = await notifications.fatigueSuggestions(ownerId);
    const bill = suggestions.find((s) => s.category === "bill");
    expect(bill).toBeDefined();
    expect(bill!.sentCount).toBe(5);
    expect(bill!.unwantedCount).toBe(4);
    expect(bill!.unwantedRate).toBeCloseTo(0.8);
  });

  it("does not suggest a category below the 60% unwanted threshold", async () => {
    const suggestions = await notifications.fatigueSuggestions(ownerId);
    expect(suggestions.find((s) => s.category === "shipment")).toBeUndefined();
  });

  it("does not suggest a category with fewer than 5 sent notifications, even at 100% dismissed", async () => {
    const suggestions = await notifications.fatigueSuggestions(ownerId);
    expect(suggestions.find((s) => s.category === "warranty")).toBeUndefined();
  });

  it("does not suggest a category already muted via categoryOverrides", async () => {
    const suggestions = await notifications.fatigueSuggestions(ownerId);
    expect(suggestions.find((s) => s.category === "subscription")).toBeUndefined();
  });

  it("scopes results to the calling user only", async () => {
    const ownerSuggestions = await notifications.fatigueSuggestions(ownerId);
    expect(ownerSuggestions.find((s) => s.category === "bill")!.sentCount).toBe(5);

    const otherSuggestions = await notifications.fatigueSuggestions(otherUserId);
    const otherBill = otherSuggestions.find((s) => s.category === "bill");
    expect(otherBill).toBeDefined();
    expect(otherBill!.sentCount).toBe(5);
    expect(otherBill!.unwantedCount).toBe(5);
  });
});
