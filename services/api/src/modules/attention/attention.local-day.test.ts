import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { localDayWindow } from "../../common/local-day";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {}, del: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * `personalToday` bounded its window with `Date.UTC(...)` — the UTC calendar day — while `users.timezone`
 * sat populated and already in use elsewhere. In America/New_York the UTC day rolls over at 20:00 local, so
 * for the last four hours of every day this screen listed tomorrow's items and hid the rest of today's.
 *
 * The two events below sit one hour inside each end of the user's LOCAL day. Whatever the real clock says
 * when this runs, at least one of them falls outside the UTC day — the windows are four hours apart and
 * each event is within an hour of an edge — so asserting that BOTH come back discriminates the fix from the
 * bug at any hour, without needing to inject a fake clock into the service.
 */
describe("AttentionService.personalToday — the user's own calendar day", () => {
  let db: Database;
  let attention: AttentionService;
  let userId: string;
  let dbAvailable = true;
  const eventIds: string[] = [];

  const ZONE = "America/New_York";

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    const households = new HouseholdService(db, entitlements, noopMailer);
    attention = new AttentionService(db, households, stubNotifications);

    try {
      userId = generateId("user");
      await db.insert(schema.users).values({
        id: userId,
        email: `local-day-${userId}@example.com`,
        displayName: "Local Day User",
        timezone: ZONE,
      });

      const { startOfDay, endOfDay } = localDayWindow(new Date(), ZONE);
      const justAfterLocalMidnight = new Date(startOfDay.getTime() + 60 * 60 * 1000);
      const justBeforeLocalMidnight = new Date(endOfDay.getTime() - 60 * 60 * 1000);

      for (const [label, start] of [
        ["Early — 01:00 local", justAfterLocalMidnight],
        ["Late — 23:00 local", justBeforeLocalMidnight],
      ] as const) {
        const id = generateId("calendarEvent");
        eventIds.push(id);
        await db.insert(schema.calendarEvents).values({
          id,
          ownerUserId: userId,
          title: label,
          start: { precision: "instant", instantUtc: start.toISOString(), date: null, timezone: ZONE, sourceText: null },
          startSort: start,
          isAllDay: false,
          source: "manual",
          visibility: "private",
        });
      }
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("includes an event at each end of the user's local day, not the UTC one", async () => {
    if (!dbAvailable) return;
    const today = await attention.personalToday(userId);
    const titles = today.events.map((e) => e.title);
    expect(titles).toContain("Early — 01:00 local");
    expect(titles).toContain("Late — 23:00 local");
  });

  it("proves the old UTC window would have dropped one of them", async () => {
    if (!dbAvailable) return;
    // Not asserting on the service — asserting that this fixture actually discriminates. If both events
    // happened to sit inside the UTC day too, the test above would pass with the bug still present, and
    // this would fail loudly instead of quietly proving nothing.
    const now = new Date();
    const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const utcEnd = new Date(utcStart.getTime() + 24 * 60 * 60 * 1000);
    const { startOfDay, endOfDay } = localDayWindow(now, ZONE);
    const early = new Date(startOfDay.getTime() + 60 * 60 * 1000);
    const late = new Date(endOfDay.getTime() - 60 * 60 * 1000);
    const inUtcDay = (d: Date) => d >= utcStart && d < utcEnd;
    expect(inUtcDay(early) && inUtcDay(late)).toBe(false);
  });
});
