import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { NotificationDeliveryService } from "./notification-delivery.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { EmailProvider, PushProvider } from "./notification-provider.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * §NOT-002 "Respect user quiet hours/time zone and OS notification settings; critical override only when
 * user opted in and event qualifies" — found live via a fresh audit: `deliver()` previously bypassed quiet
 * hours for ANY "critical"-priority notification unconditionally, with no preference anywhere a user could
 * opt out of that override — contradicting the spec's explicit "only when user opted in" half of the rule.
 * Proves the fix: a critical notification during quiet hours is delivered when
 * `criticalOverridesQuietHours` is true/unset (the default, preserving prior behavior) and delayed like
 * any other notification once the user explicitly opts out by setting it false — while an "important"
 * notification (not critical — the "event qualifies" half of the rule) is delayed either way.
 */
describe("NotificationDeliveryService.deliver — critical quiet-hours override opt-in", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;
  const notificationIds: string[] = [];

  // Always report as inside quiet hours right now — the test's local wall-clock time shouldn't determine
  // whether this passes, only whether the override preference/priority combination is respected.
  const ALWAYS_QUIET_PREFS = { quietHoursStart: "00:00", quietHoursEnd: "23:59" };

  function makeService() {
    const sentEmails: Array<{ to: string; subject: string }> = [];
    const rescheduled: Array<{ notificationId: string; delayMs?: number }> = [];
    const queue = {
      enqueueNotificationDelivery: async (data: { notificationId: string }, delayMs?: number) => {
        rescheduled.push({ notificationId: data.notificationId, delayMs });
      },
    } as unknown as QueueProducer;
    const mailer = {
      send: async (params: { to: string; subject: string }) => {
        sentEmails.push({ to: params.to, subject: params.subject });
      },
    } as unknown as EmailProvider;
    const push = { send: async () => false } as unknown as PushProvider; // no push token in this test, so delivery falls through to email
    const service = new NotificationDeliveryService(db, queue, mailer, push);
    return { service, sentEmails, rescheduled };
  }

  async function seedPrefs(criticalOverridesQuietHours: boolean) {
    await db
      .insert(schema.notificationPreferences)
      .values({ userId: ownerUserId, ...ALWAYS_QUIET_PREFS, criticalOverridesQuietHours })
      .onConflictDoUpdate({
        target: schema.notificationPreferences.userId,
        set: { ...ALWAYS_QUIET_PREFS, criticalOverridesQuietHours },
      });
  }

  async function makeNotification(priority: "critical" | "important"): Promise<string> {
    const id = generateId("notification");
    await db.insert(schema.notifications).values({
      id,
      ownerUserId,
      dedupeKey: `test-critical-override:${id}`,
      priority,
      channel: "email",
      title: "Test notification",
      body: "Test body",
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
      await db.insert(schema.users).values({ id: ownerUserId, email: `critical-override-${ownerUserId}@example.com`, displayName: "Critical Override Test User", timezone: "UTC" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping NotificationDeliveryService critical-override tests — no reachable dev Postgres:", (err as Error).message);
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
    await db.delete(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("delivers a critical notification during quiet hours when the user hasn't opted out (default true)", async () => {
    if (!dbAvailable) return;
    await seedPrefs(true);
    const id = await makeNotification("critical");
    const { service, sentEmails, rescheduled } = makeService();
    await service.deliver(id);
    expect(sentEmails).toHaveLength(1);
    expect(rescheduled).toHaveLength(0);
    const [row] = await db.select({ state: schema.notifications.state }).from(schema.notifications).where(eq(schema.notifications.id, id));
    expect(row!.state).toBe("sent");
  });

  it("delays a critical notification during quiet hours once the user opts out", async () => {
    if (!dbAvailable) return;
    await seedPrefs(false);
    const id = await makeNotification("critical");
    const { service, sentEmails, rescheduled } = makeService();
    await service.deliver(id);
    expect(sentEmails).toHaveLength(0);
    expect(rescheduled).toHaveLength(1);
    const [row] = await db.select({ state: schema.notifications.state }).from(schema.notifications).where(eq(schema.notifications.id, id));
    expect(row!.state).toBe("queued"); // untouched — deliver() reschedules rather than marking it sent/suppressed
  });

  it("delays a non-critical (important) notification during quiet hours regardless of the override preference", async () => {
    if (!dbAvailable) return;
    await seedPrefs(true); // even with the override ON, it only ever applies to critical priority
    const id = await makeNotification("important");
    const { service, sentEmails, rescheduled } = makeService();
    await service.deliver(id);
    expect(sentEmails).toHaveLength(0);
    expect(rescheduled).toHaveLength(1);
  });
});
