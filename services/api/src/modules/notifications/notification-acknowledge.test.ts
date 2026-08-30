import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { NotificationsService } from "./notifications.service";

/** OS-level notification action buttons (Resolve/Snooze 1h/Dismiss) and plain taps both funnel into
 * NotificationsService.acknowledge() — the acknowledgment-tracking substrate a later escalation
 * ladder/fatigue-feedback mechanism builds on. Real DB, same ownership-check style as
 * notifications.service.test.ts. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let notifications: NotificationsService;
const ownerId = generateId("user");
const otherUserId = generateId("user");
const notificationId = generateId("notification");

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  notifications = new NotificationsService(db);
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: otherUserId, displayName: "Other" },
  ]);
  await db.insert(schema.notifications).values({
    id: notificationId,
    ownerUserId: ownerId,
    dedupeKey: "test-ack",
    priority: "useful",
    channel: "push",
    title: "A bill is due",
    body: "body",
    linkedAttentionItemId: generateId("attentionItem"),
    state: "sent",
    scheduledFor: new Date(),
  });
});

afterAll(async () => {
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, [notificationId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, otherUserId]));
});

describe("NotificationsService.acknowledge", () => {
  it("sets acknowledgedAt and actionTaken for a notification the caller owns", async () => {
    await notifications.acknowledge(notificationId, ownerId, "opened");
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, notificationId)).limit(1);
    expect(row!.actionTaken).toBe("opened");
    expect(row!.acknowledgedAt).not.toBeNull();
  });

  it("throws NotFoundException when the notification isn't owned by the caller", async () => {
    await expect(notifications.acknowledge(notificationId, otherUserId, "opened")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException for a notification id that doesn't exist", async () => {
    await expect(notifications.acknowledge(generateId("notification"), ownerId, "opened")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("overwrites cleanly on repeat acknowledgment (e.g. an action button tapped after an earlier one)", async () => {
    const [before] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, notificationId)).limit(1);

    await notifications.acknowledge(notificationId, ownerId, "resolved");

    const [after] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, notificationId)).limit(1);
    expect(after!.actionTaken).toBe("resolved");
    expect(after!.acknowledgedAt!.getTime()).toBeGreaterThanOrEqual(before!.acknowledgedAt!.getTime());
  });
});
