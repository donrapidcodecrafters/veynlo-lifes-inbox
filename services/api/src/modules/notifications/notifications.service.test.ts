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
    expect(listA.map((n) => n.id)).toEqual([notificationAId]);

    const listB = await notifications.list(userBId);
    expect(listB.map((n) => n.id)).toEqual([notificationBId]);
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
});
