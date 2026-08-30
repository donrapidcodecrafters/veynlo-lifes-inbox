import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { NotificationDeliveryService } from "./notification-delivery.service";

/** §NOT-002 escalation ladder — NotificationDeliveryService.escalateUnacknowledged() re-sends critical
 * notifications no one has acknowledged 30+ minutes after they were sent, exactly once each. Real DB for
 * the notification/device rows; PushService, MailerService, and QueueProducerService are faked, same
 * convention as notification-delivery-push-category.test.ts. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
const userId = generateId("user");
const deviceId = generateId("device");
const dueNotificationId = generateId("notification");
const acknowledgedNotificationId = generateId("notification");
const alreadyEscalatedNotificationId = generateId("notification");
const nonCriticalNotificationId = generateId("notification");
const tooRecentNotificationId = generateId("notification");

const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  await db.insert(schema.users).values({ id: userId, displayName: "Escalation User" });
  await db.insert(schema.devices).values({ id: deviceId, userId, platform: "ios", pushToken: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" });
  await db.insert(schema.notifications).values([
    {
      id: dueNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-escalation-due",
      priority: "critical",
      channel: "push",
      title: "Payment failed",
      body: "body",
      state: "sent",
      sentAt: thirtyOneMinutesAgo,
      scheduledFor: thirtyOneMinutesAgo,
    },
    {
      id: acknowledgedNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-escalation-acked",
      priority: "critical",
      channel: "push",
      title: "Payment failed",
      body: "body",
      state: "sent",
      sentAt: thirtyOneMinutesAgo,
      acknowledgedAt: new Date(),
      scheduledFor: thirtyOneMinutesAgo,
    },
    {
      id: alreadyEscalatedNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-escalation-already",
      priority: "critical",
      channel: "push",
      title: "Payment failed",
      body: "body",
      state: "sent",
      sentAt: thirtyOneMinutesAgo,
      escalatedAt: thirtyOneMinutesAgo,
      scheduledFor: thirtyOneMinutesAgo,
    },
    {
      id: nonCriticalNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-escalation-non-critical",
      priority: "useful",
      channel: "push",
      title: "A bill is due",
      body: "body",
      state: "sent",
      sentAt: thirtyOneMinutesAgo,
      scheduledFor: thirtyOneMinutesAgo,
    },
    {
      id: tooRecentNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-escalation-too-recent",
      priority: "critical",
      channel: "push",
      title: "Payment failed",
      body: "body",
      state: "sent",
      sentAt: fiveMinutesAgo,
      scheduledFor: fiveMinutesAgo,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(schema.notifications)
    .where(
      inArray(schema.notifications.id, [
        dueNotificationId,
        acknowledgedNotificationId,
        alreadyEscalatedNotificationId,
        nonCriticalNotificationId,
        tooRecentNotificationId,
      ]),
    );
  await db.delete(schema.devices).where(inArray(schema.devices.id, [deviceId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
});

describe("NotificationDeliveryService.escalateUnacknowledged", () => {
  it("escalates a critical, sent, unacknowledged notification older than 30 minutes", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.escalateUnacknowledged();

    expect(push.send).toHaveBeenCalledWith("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "⚠️ Still needs you: Payment failed", "body", undefined);

    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, dueNotificationId)).limit(1);
    expect(row!.escalatedAt).not.toBeNull();
  });

  it("does not escalate a notification that was already acknowledged", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.escalateUnacknowledged();

    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, acknowledgedNotificationId)).limit(1);
    expect(row!.escalatedAt).toBeNull();
  });

  it("does not escalate a notification already escalated once", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.escalateUnacknowledged();

    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, alreadyEscalatedNotificationId)).limit(1);
    expect(row!.escalatedAt!.getTime()).toBe(thirtyOneMinutesAgo.getTime());
  });

  it("does not escalate a non-critical notification even if old and unacknowledged", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.escalateUnacknowledged();

    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, nonCriticalNotificationId)).limit(1);
    expect(row!.escalatedAt).toBeNull();
  });

  it("does not escalate a critical notification sent less than 30 minutes ago", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.escalateUnacknowledged();

    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, tooRecentNotificationId)).limit(1);
    expect(row!.escalatedAt).toBeNull();
  });
});
