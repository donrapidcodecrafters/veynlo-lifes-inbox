import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { InboxService } from "./inbox.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
import type { ConflictService } from "../schedule/conflict.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
// None of these tests exercise a reschedule/conflict path — addToCalendar never calls ConflictService —
// so an unused stub is enough to satisfy InboxService's constructor.
const stubConflicts = {} as ConflictService;

/**
 * CAL-002 "offers Add to calendar with chosen destination and reminder defaults" — proves
 * InboxService.addToCalendar's actual contract: `destinationConnectionId: null` ("Life Inbox only") never
 * calls the write-back pusher; a real destination does; a reminder lead time is recorded either way; and
 * the inbox item ends up confirmed regardless of whether the push itself succeeded (matching
 * CalendarWriteBackService.pushEvent's own "a provider failure never loses/blocks the local action" stance).
 */
describe("InboxService.addToCalendar", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `add-to-cal-${ownerUserId}@example.com`, displayName: "Add To Calendar Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping InboxService.addToCalendar tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeDiscoveredEvent(): Promise<{ eventId: string; inboxItemId: string }> {
    const eventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title: "Flight to Denver",
      start: { precision: "instant", instantUtc: new Date(Date.now() + 86_400_000).toISOString(), date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "discovered_from_evidence",
      status: "confirmed",
      reminderMinutesBefore: 60,
    });
    const inboxItemId = generateId("inboxItem");
    await db.insert(schema.inboxItems).values({
      id: inboxItemId,
      ownerUserId,
      category: "appointment",
      summary: "Flight to Denver discovered",
      linkedResourceType: "calendar_event",
      linkedResourceId: eventId,
      sourceEventId: generateId("sourceEvent"),
      suggestedActions: ["confirm", "add_to_calendar", "dismiss"],
      confidenceBand: "high",
    });
    return { eventId, inboxItemId };
  }

  it("'Life Inbox only' (destinationConnectionId: null) never calls the write-back pusher, still confirms the item", async () => {
    if (!dbAvailable) return;
    const { eventId, inboxItemId } = await makeDiscoveredEvent();
    let pushCalled = false;
    const stubWriteBack = { pushEvent: async () => { pushCalled = true; return { pushed: true }; } } as unknown as CalendarWriteBackService;
    const inbox = new InboxService(db, stubWriteBack, stubConflicts);

    const result = await inbox.addToCalendar(inboxItemId, ownerUserId, { destinationConnectionId: null, reminderMinutesBefore: 30 });

    expect(result).toEqual({ pushed: false });
    expect(pushCalled).toBe(false);
    const [item] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, inboxItemId));
    expect(item?.reviewState).toBe("confirmed");
    const [event] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect(event?.reminderMinutesBefore).toBe(30); // the chosen reminder lead time was applied
  });

  it("a real destination calls the write-back pusher with the right event/connection", async () => {
    if (!dbAvailable) return;
    const { eventId, inboxItemId } = await makeDiscoveredEvent();
    const connectionId = generateId("connection");
    let pushArgs: unknown;
    const stubWriteBack = {
      pushEvent: async (params: unknown) => {
        pushArgs = params;
        return { pushed: true };
      },
    } as unknown as CalendarWriteBackService;
    const inbox = new InboxService(db, stubWriteBack, stubConflicts);

    const result = await inbox.addToCalendar(inboxItemId, ownerUserId, { destinationConnectionId: connectionId });

    expect(result).toEqual({ pushed: true });
    expect(pushArgs).toEqual({ eventId, ownerUserId, connectionId });
    const [item] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, inboxItemId));
    expect(item?.reviewState).toBe("confirmed");
  });

  it("confirms the item even when the push itself fails (pushEvent returns pushed: false, never throws)", async () => {
    if (!dbAvailable) return;
    const { inboxItemId } = await makeDiscoveredEvent();
    const stubWriteBack = { pushEvent: async () => ({ pushed: false }) } as unknown as CalendarWriteBackService;
    const inbox = new InboxService(db, stubWriteBack, stubConflicts);

    const result = await inbox.addToCalendar(inboxItemId, ownerUserId, { destinationConnectionId: generateId("connection") });

    expect(result).toEqual({ pushed: false });
    const [item] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, inboxItemId));
    expect(item?.reviewState).toBe("confirmed");
  });

  it("rejects add-to-calendar on an inbox item that isn't a calendar event", async () => {
    if (!dbAvailable) return;
    const inboxItemId = generateId("inboxItem");
    await db.insert(schema.inboxItems).values({
      id: inboxItemId,
      ownerUserId,
      category: "purchase",
      summary: "Some receipt",
      linkedResourceType: "purchase",
      linkedResourceId: generateId("purchase"),
      sourceEventId: generateId("sourceEvent"),
      suggestedActions: ["confirm", "dismiss"],
      confidenceBand: "high",
    });
    const inbox = new InboxService(db, {} as CalendarWriteBackService, stubConflicts);
    await expect(inbox.addToCalendar(inboxItemId, ownerUserId, { destinationConnectionId: null })).rejects.toMatchObject({ response: { code: "NOT_A_CALENDAR_EVENT" } });
  });
});
