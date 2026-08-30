import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { NotificationDeliveryService } from "./notification-delivery.service";

/** OS-level notification action buttons only appear when the push payload carries
 * `categoryId: "attention_actionable"` + `data`. deliver() should pass those through to PushService.send()
 * exactly when the notification has a `linkedAttentionItemId`, and omit both otherwise (e.g. a daily brief,
 * which has no single linked resource to act on). Real DB for the notification/device rows; PushService,
 * MailerService, and QueueProducerService are faked since this test is only about what deliver() passes to
 * the push send call. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
const userId = generateId("user");
const deviceId = generateId("device");
const linkedNotificationId = generateId("notification");
const unlinkedNotificationId = generateId("notification");
const attentionItemId = generateId("attentionItem");

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  await db.insert(schema.users).values({ id: userId, displayName: "Push User" });
  await db.insert(schema.devices).values({ id: deviceId, userId, platform: "ios", pushToken: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" });
  await db.insert(schema.notifications).values([
    {
      id: linkedNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-linked",
      priority: "useful",
      channel: "push",
      title: "A bill is due",
      body: "body",
      linkedAttentionItemId: attentionItemId,
      state: "queued",
      scheduledFor: new Date(),
    },
    {
      id: unlinkedNotificationId,
      ownerUserId: userId,
      dedupeKey: "test-unlinked",
      priority: "useful",
      channel: "push",
      title: "Your daily brief",
      body: "body",
      state: "queued",
      scheduledFor: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, [linkedNotificationId, unlinkedNotificationId]));
  await db.delete(schema.devices).where(inArray(schema.devices.id, [deviceId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
});

describe("NotificationDeliveryService.deliver — push category/data for actionable notifications", () => {
  it("passes categoryId + data when the notification has a linkedAttentionItemId", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.deliver(linkedNotificationId);

    expect(push.send).toHaveBeenCalledWith(
      "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
      "A bill is due",
      "body",
      { categoryId: "attention_actionable", data: { notificationId: linkedNotificationId, linkedAttentionItemId: attentionItemId } },
    );
  });

  it("omits categoryId and data when the notification has no linkedAttentionItemId", async () => {
    const push = { send: vi.fn(async () => true) };
    const queue = { enqueueNotificationDelivery: vi.fn() };
    const mailer = { send: vi.fn() };
    const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);

    await service.deliver(unlinkedNotificationId);

    expect(push.send).toHaveBeenCalledWith("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "Your daily brief", "body", undefined);
  });
});
