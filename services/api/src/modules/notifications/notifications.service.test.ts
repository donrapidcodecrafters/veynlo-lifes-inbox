import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { NotificationsService } from "./notifications.service";

/** §54.2 launch criteria — real authorization test against local Postgres: a user's notification
 * history/preferences must never surface another user's rows. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let notifications: NotificationsService;
const userAId = generateId("user");
const userBId = generateId("user");
const notificationAId = generateId("notification");
const notificationBId = generateId("notification");

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  notifications = new NotificationsService(db);
  await db.insert(schema.users).values([
    { id: userAId, displayName: "User A" },
    { id: userBId, displayName: "User B" },
  ]);
  await db.insert(schema.notifications).values([
    {
      id: notificationAId,
      ownerUserId: userAId,
      dedupeKey: "test-a",
      priority: "useful",
      channel: "email",
      title: "User A's notification",
      body: "private to A",
      state: "queued",
      scheduledFor: new Date(),
    },
    {
      id: notificationBId,
      ownerUserId: userBId,
      dedupeKey: "test-b",
      priority: "useful",
      channel: "email",
      title: "User B's notification",
      body: "private to B",
      state: "queued",
      scheduledFor: new Date(),
    },
  ]);
  await db.insert(schema.notificationPreferences).values([
    { userId: userAId, intensity: "quiet", categoryOverrides: { bill: "off" } },
    { userId: userBId, intensity: "proactive", categoryOverrides: {} },
  ]);
});

afterAll(async () => {
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, [notificationAId, notificationBId]));
  await db.delete(schema.notificationPreferences).where(inArray(schema.notificationPreferences.userId, [userAId, userBId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [userAId, userBId]));
});

describe("NotificationsService — cross-user isolation", () => {
  it("list() returns only the requesting user's own notifications", async () => {
    const listA = await notifications.list(userAId);
    expect(listA.items.map((n) => n.id)).toEqual([notificationAId]);
    expect(listA.nextCursor).toBeNull();

    const listB = await notifications.list(userBId);
    expect(listB.items.map((n) => n.id)).toEqual([notificationBId]);
  });

  it("list()'s before cursor excludes items at or after the given timestamp", async () => {
    const middleId = generateId("notification");
    const oldestId = generateId("notification");
    const now = new Date();
    await db.insert(schema.notifications).values([
      {
        id: middleId,
        ownerUserId: userAId,
        dedupeKey: "test-middle",
        priority: "useful",
        channel: "email",
        title: "Middle",
        body: "middle",
        state: "queued",
        scheduledFor: new Date(now.getTime() - 60_000),
      },
      {
        id: oldestId,
        ownerUserId: userAId,
        dedupeKey: "test-oldest",
        priority: "useful",
        channel: "email",
        title: "Oldest",
        body: "oldest",
        state: "queued",
        scheduledFor: new Date(now.getTime() - 120_000),
      },
    ]);
    try {
      const middleRow = (await db.select({ scheduledFor: schema.notifications.scheduledFor }).from(schema.notifications).where(inArray(schema.notifications.id, [middleId])))[0];
      const page = await notifications.list(userAId, middleRow!.scheduledFor.toISOString());
      const ids = page.items.map((n) => n.id);
      expect(ids).toContain(oldestId);
      expect(ids).not.toContain(middleId);
      expect(ids).not.toContain(notificationAId);
    } finally {
      await db.delete(schema.notifications).where(inArray(schema.notifications.id, [middleId, oldestId]));
    }
  });

  it("getPreferences() returns only the requesting user's own preferences, never another user's", async () => {
    const prefsA = await notifications.getPreferences(userAId);
    expect(prefsA.intensity).toBe("quiet");
    expect(prefsA.categoryOverrides).toEqual({ bill: "off" });

    const prefsB = await notifications.getPreferences(userBId);
    expect(prefsB.intensity).toBe("proactive");
    expect(prefsB.categoryOverrides).toEqual({});
  });

  it("updatePreferences() for one user never mutates another user's row", async () => {
    await notifications.updatePreferences(userAId, { categoryOverrides: { bill: "off", shipment: "off" } });
    const prefsB = await notifications.getPreferences(userBId);
    expect(prefsB.categoryOverrides).toEqual({});
  });

  it("updatePreferences() persists privacyLevel", async () => {
    await notifications.updatePreferences(userAId, { privacyLevel: "hide_titles" });
    const prefsA = await notifications.getPreferences(userAId);
    expect(prefsA.privacyLevel).toBe("hide_titles");

    const prefsB = await notifications.getPreferences(userBId);
    expect(prefsB.privacyLevel).toBe("full");
  });
});
