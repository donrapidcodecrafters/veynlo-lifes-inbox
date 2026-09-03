import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * CAL-002 "reminder defaults" — the actual notification-producing counterpart to
 * `calendarEvents.reminderMinutesBefore`. Before this, `scanAndFileDeadlines` never looked at calendar
 * events at all, so an upcoming appointment/reservation never surfaced on the Home "Needs You" queue no
 * matter how close it was. Proves: an event within its own reminder lead time files an `event_reminder`
 * attention item; one further out doesn't (yet); a cancelled event never does; and re-running the scan
 * doesn't file a duplicate for the same event (`fileIfNew`'s existing per-resource dedup).
 */
describe("AttentionService.scanAndFileDeadlines — calendar event reminders", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `event-reminder-${ownerUserId}@example.com`, displayName: "Reminder Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService event-reminder tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeEvent(params: { minutesFromNow: number; reminderMinutesBefore: number | null; status?: string; title?: string }): Promise<string> {
    const eventId = generateId("calendarEvent");
    const startSort = new Date(Date.now() + params.minutesFromNow * 60_000);
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title: params.title ?? "Dentist appointment",
      start: { precision: "instant", instantUtc: startSort.toISOString(), date: null, timezone: null, sourceText: null },
      startSort,
      isAllDay: false,
      source: "manual",
      status: params.status ?? "confirmed",
      reminderMinutesBefore: params.reminderMinutesBefore,
    });
    return eventId;
  }

  async function attentionItemFor(eventId: string) {
    const [row] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "calendar_event"), eq(schema.attentionItems.linkedResourceId, eventId)));
    return row ?? null;
  }

  it("files a reminder for an event starting within its lead time", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ minutesFromNow: 30, reminderMinutesBefore: 60 }); // due in 30 min, remind 60 min before -> already due
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(eventId);
    expect(item).not.toBeNull();
    expect(item!.reasonCode).toBe("event_reminder");
    expect(item!.reasonText).toContain("Dentist appointment");
  });

  it("does not file a reminder yet for an event further out than its lead time", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ minutesFromNow: 300, reminderMinutesBefore: 60 }); // 5 hours out, 60-minute lead — not due yet
    await attention.scanAndFileDeadlines();
    expect(await attentionItemFor(eventId)).toBeNull();
  });

  it("falls back to the default lead time (60 minutes for a timed event) when reminderMinutesBefore is null", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ minutesFromNow: 10, reminderMinutesBefore: null });
    await attention.scanAndFileDeadlines();
    expect(await attentionItemFor(eventId)).not.toBeNull();
  });

  it("never files a reminder for a cancelled event", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ minutesFromNow: 5, reminderMinutesBefore: 60, status: "cancelled" });
    await attention.scanAndFileDeadlines();
    expect(await attentionItemFor(eventId)).toBeNull();
  });

  it("re-running the scan doesn't duplicate an already-filed reminder", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ minutesFromNow: 15, reminderMinutesBefore: 60 });
    await attention.scanAndFileDeadlines();
    await attention.scanAndFileDeadlines();
    const rows = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "calendar_event"), eq(schema.attentionItems.linkedResourceId, eventId)));
    expect(rows).toHaveLength(1);
  });
});
