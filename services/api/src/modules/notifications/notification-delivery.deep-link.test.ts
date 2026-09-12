import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { NotificationDeliveryService } from "./notification-delivery.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { EmailProvider, PushDeepLink, PushProvider } from "./notification-provider.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * §16 "notification destination screens" — tapping a push must open the thing it is about.
 *
 * The defect this covers: `PushService.send` took only `(pushToken, title, body)` and built an
 * ExpoPushMessage with no `data` field at all, so nothing identifying the subject of the notification ever
 * reached the device. Combined with the app having no `addNotificationResponseReceivedListener`, every
 * push — a recall alert, an overdue bill, a shipment update — cold-launched to the same generic Home tab.
 *
 * These tests assert on what is actually handed to the push provider, because that is the boundary the
 * device sees. The routing decision itself lives in apps/mobile/src/lib/push-deep-link.ts and is unit
 * tested separately; what matters here is that the fields it needs are populated and delivered.
 */
describe("NotificationDeliveryService.deliver — push deep-link payload", () => {
  let db: Database;
  let ownerUserId: string;
  let deviceId: string;
  let dbAvailable = true;
  const notificationIds: string[] = [];

  const PUSH_TOKEN = "ExponentPushToken[deep-link-test]";

  function makeService() {
    const pushes: Array<{ token: string; title: string; body: string; data?: PushDeepLink }> = [];
    const sentEmails: Array<{ to: string }> = [];
    const queue = { enqueueNotificationDelivery: async () => {} } as unknown as QueueProducer;
    const mailer = {
      send: async (params: { to: string }) => {
        sentEmails.push({ to: params.to });
      },
    } as unknown as EmailProvider;
    const push = {
      send: async (token: string, title: string, body: string, data?: PushDeepLink) => {
        pushes.push({ token, title, body, data });
        return true;
      },
    } as unknown as PushProvider;
    return { service: new NotificationDeliveryService(db, queue, mailer, push), pushes, sentEmails };
  }

  async function makeNotification(target: { linkedResourceType?: string; linkedResourceId?: string }): Promise<string> {
    const id = generateId("notification");
    await db.insert(schema.notifications).values({
      id,
      ownerUserId,
      dedupeKey: `test-deep-link:${id}`,
      priority: "useful",
      channel: "push",
      title: "Test notification",
      body: "Test body",
      linkedResourceType: target.linkedResourceType ?? null,
      linkedResourceId: target.linkedResourceId ?? null,
      state: "queued",
      scheduledFor: new Date(),
    });
    notificationIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `deep-link-${ownerUserId}@example.com`,
        displayName: "Deep Link Test User",
        timezone: "UTC",
      });
      deviceId = generateId("device");
      await db.insert(schema.devices).values({
        id: deviceId,
        userId: ownerUserId,
        platform: "ios",
        pushToken: PUSH_TOKEN,
        lastActiveAt: new Date(),
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping push deep-link tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    for (const id of notificationIds.splice(0)) {
      await db.delete(schema.notifications).where(eq(schema.notifications.id, id));
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.devices).where(eq(schema.devices.id, deviceId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("sends the target resource to the device so a tap can open it", async () => {
    if (!dbAvailable) return;
    const id = await makeNotification({ linkedResourceType: "bill", linkedResourceId: "bill_abc123" });
    const { service, pushes } = makeService();
    await service.deliver(id);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.token).toBe(PUSH_TOKEN);
    expect(pushes[0]!.data).toEqual({
      notificationId: id,
      resourceType: "bill",
      resourceId: "bill_abc123",
    });
  });

  it("still identifies the notification when there is no target resource, so briefs open normally", async () => {
    if (!dbAvailable) return;
    // The daily and weekly briefs are exactly this: real push notifications with no single subject.
    const id = await makeNotification({});
    const { service, pushes } = makeService();
    await service.deliver(id);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data).toEqual({ notificationId: id });
    expect(pushes[0]!.data).not.toHaveProperty("resourceType");
    expect(pushes[0]!.data).not.toHaveProperty("resourceId");
  });

  it("omits a half-populated target rather than sending a type with no id", async () => {
    if (!dbAvailable) return;
    // A type without an id would route the device to something like "/bill/undefined". Landing on Home is
    // the correct degradation, so the payload must not claim a destination it cannot address.
    const id = await makeNotification({ linkedResourceType: "bill" });
    const { service, pushes } = makeService();
    await service.deliver(id);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data).toEqual({ notificationId: id });
  });

  it("persists the target through createAndEnqueue, not just through a hand-written row", async () => {
    if (!dbAvailable) return;
    const { service } = makeService();
    const result = await service.createAndEnqueue({
      ownerUserId,
      dedupeKey: `test-deep-link-enqueue:${generateId("notification")}`,
      priority: "important",
      channel: "push",
      title: "Recall on your vehicle",
      body: "A new recall matches your Civic.",
      linkedResourceType: "warranty",
      linkedResourceId: "wty_xyz",
    });
    expect(result).toHaveProperty("notificationId");
    const notificationId = (result as { notificationId: string }).notificationId;
    notificationIds.push(notificationId);

    const [row] = await db
      .select({
        linkedResourceType: schema.notifications.linkedResourceType,
        linkedResourceId: schema.notifications.linkedResourceId,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notificationId));
    expect(row!.linkedResourceType).toBe("warranty");
    expect(row!.linkedResourceId).toBe("wty_xyz");
  });
});
