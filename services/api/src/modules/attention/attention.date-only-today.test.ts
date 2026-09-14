import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import { localDateIso } from "../../common/local-day";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubNotifications = {} as unknown as NotificationDeliveryService;

/**
 * An all-day event, a date-only bill and a dated task appear on Today for a user who is not on UTC.
 *
 * The unit test beside this one proves the comparison rule; this proves the QUERY uses it. They are not
 * the same claim: the rule lived in a helper for some minutes while the SQL still compared a date-only
 * row's UTC-midnight sort key against a Chicago day window, which is the actual defect — an all-day event
 * dated today sorted five hours before the user's day began and was served with YESTERDAY.
 *
 * Dates are derived from `now` rather than hardcoded, so this cannot become one of the date-pinned tests
 * that quietly stop testing their subject when the calendar moves past them.
 */
describe("AttentionService.today — date-only values land on the user's day", () => {
  let db: Database;
  let attention: AttentionService;
  let userId: string;
  let dbAvailable = true;

  // Chicago is five hours behind UTC in summer, which is exactly the gap that hid the defect: an event
  // dated today sorts at 00:00Z, and the user's day does not start until 05:00Z.
  const ZONE = "America/Chicago";
  const todayLocal = () => localDateIso(new Date(), ZONE);

  const dateOnly = (date: string) => ({
    precision: "date" as const,
    instantUtc: null,
    date,
    timezone: null,
    sourceText: null,
  });

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({
        id: userId,
        email: `date-only-${userId}@example.com`,
        displayName: "Date Only",
        timezone: ZONE,
      });

      const today = todayLocal();
      await db.insert(schema.calendarEvents).values({
        id: generateId("calendarEvent"),
        ownerUserId: userId,
        title: "All-day school closure",
        start: dateOnly(today),
        // UTC midnight, exactly as every writer stores it — the value the query used to compare.
        startSort: new Date(`${today}T00:00:00Z`),
        isAllDay: true,
        source: "user_entered",
        visibility: "private",
      } as never);

      await db.insert(schema.bills).values({
        id: generateId("bill"),
        ownerUserId: userId,
        billerLabel: "Water",
        amountDueMinorUnits: 4200,
        amountDueCurrency: "USD",
        dueDate: dateOnly(today),
        dueDateSort: new Date(`${today}T00:00:00Z`),
        autopayBelieved: false,
      } as never);

      await db.insert(schema.tasks).values({
        id: generateId("task"),
        ownerUserId: userId,
        title: "Renew the permit",
        dueCondition: dateOnly(today),
        dueSort: new Date(`${today}T00:00:00Z`),
        state: "open",
      } as never);
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "AttentionService date-only Today tests");
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId));
    await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, userId));
    await db.delete(schema.tasks).where(eq(schema.tasks.ownerUserId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("serves an all-day event dated today", async () => {
    if (!dbAvailable) return;
    const today = await attention.personalToday(userId);
    expect(today.events.map((e) => e.title)).toContain("All-day school closure");
  });

  it("serves a bill due today with a date and no time", async () => {
    if (!dbAvailable) return;
    const today = await attention.personalToday(userId);
    expect(today.bills).toHaveLength(1);
  });

  it("serves a task due today with a date and no time", async () => {
    if (!dbAvailable) return;
    const today = await attention.personalToday(userId);
    expect(today.tasks.map((t) => t.title)).toContain("Renew the permit");
  });

  it("does not serve an all-day event dated tomorrow", async () => {
    if (!dbAvailable) return;
    // The other half of the rule: fixing "a day early" by widening the window would have pulled tomorrow
    // in, trading one wrong answer for another.
    const tomorrow = localDateIso(new Date(Date.now() + 36 * 60 * 60 * 1000), ZONE);
    const id = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId: userId,
      title: "Tomorrow's closure",
      start: dateOnly(tomorrow),
      startSort: new Date(`${tomorrow}T00:00:00Z`),
      isAllDay: true,
      source: "user_entered",
      visibility: "private",
    } as never);

    const today = await attention.personalToday(userId);
    expect(today.events.map((e) => e.title)).not.toContain("Tomorrow's closure");

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
  });
});
