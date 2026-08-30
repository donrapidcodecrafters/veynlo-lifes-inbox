import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { NotificationDeliveryService } from "./notification-delivery.service";

/** Lock-screen privacy levels (notificationPreferences.privacyLevel) must actually reach the outbound
 * push payload — deliver() should redact per the stored level before calling PushService.send(). Real DB
 * for the notification/device/preferences rows; PushService, MailerService, and QueueProducerService are
 * faked, same convention as notification-delivery-push-category.test.ts. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
const fullUserId = generateId("user");
const hideAmountsUserId = generateId("user");
const hideTitlesUserId = generateId("user");
const genericUserId = generateId("user");
const userIds = [fullUserId, hideAmountsUserId, hideTitlesUserId, genericUserId];
const deviceIds = userIds.map(() => generateId("device"));
const notificationIds = userIds.map(() => generateId("notification"));

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  await db.insert(schema.users).values(userIds.map((id) => ({ id, displayName: "Privacy Test User" })));
  await db.insert(schema.devices).values(
    userIds.map((userId, i) => ({
      id: deviceIds[i]!,
      userId,
      platform: "ios" as const,
      pushToken: `ExponentPushToken[privacy${i}xxxxxxxxxxxxxxx]`,
    })),
  );
  await db.insert(schema.notificationPreferences).values([
    { userId: fullUserId, privacyLevel: "full" },
    { userId: hideAmountsUserId, privacyLevel: "hide_amounts" },
    { userId: hideTitlesUserId, privacyLevel: "hide_titles" },
    { userId: genericUserId, privacyLevel: "generic" },
  ]);
  await db.insert(schema.notifications).values(
    userIds.map((userId, i) => ({
      id: notificationIds[i]!,
      ownerUserId: userId,
      dedupeKey: `test-privacy-${userId}`,
      priority: "useful" as const,
      channel: "push" as const,
      category: "bill",
      title: "Comcast bill due",
      body: "Your bill of 45.00 USD is due in 3 days.",
      state: "queued" as const,
      scheduledFor: new Date(),
    })),
  );
});

afterAll(async () => {
  await db.delete(schema.notifications).where(inArray(schema.notifications.id, notificationIds));
  await db.delete(schema.notificationPreferences).where(inArray(schema.notificationPreferences.userId, userIds));
  await db.delete(schema.devices).where(inArray(schema.devices.id, deviceIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
});

function makeService() {
  const push = { send: vi.fn(async () => true) };
  const queue = { enqueueNotificationDelivery: vi.fn() };
  const mailer = { send: vi.fn() };
  const service = new NotificationDeliveryService(db, queue as never, mailer as never, push as never);
  return { service, push };
}

describe("NotificationDeliveryService.deliver — applies the caller's stored privacy level", () => {
  it("full — sends the real title and body unchanged", async () => {
    const { service, push } = makeService();
    await service.deliver(notificationIds[0]!);
    expect(push.send).toHaveBeenCalledWith(expect.any(String), "Comcast bill due", "Your bill of 45.00 USD is due in 3 days.", undefined);
  });

  it("hide_amounts — redacts the amount, leaves the title alone", async () => {
    const { service, push } = makeService();
    await service.deliver(notificationIds[1]!);
    expect(push.send).toHaveBeenCalledWith(expect.any(String), "Comcast bill due", "Your bill of [amount hidden] is due in 3 days.", undefined);
  });

  it("hide_titles — redacts the amount AND replaces the title with a category label", async () => {
    const { service, push } = makeService();
    await service.deliver(notificationIds[2]!);
    expect(push.send).toHaveBeenCalledWith(expect.any(String), "Bill reminder", "Your bill of [amount hidden] is due in 3 days.", undefined);
  });

  it("generic — replaces both title and body with fixed, non-identifying strings", async () => {
    const { service, push } = makeService();
    await service.deliver(notificationIds[3]!);
    expect(push.send).toHaveBeenCalledWith(
      expect.any(String),
      "Veynlo",
      "You have a new notification. Open the app for details.",
      undefined,
    );
  });
});
