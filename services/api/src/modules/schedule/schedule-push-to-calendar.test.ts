import { describe, expect, it, afterAll, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../shared/sharing.service";
import { ScheduleService } from "./schedule.service";

/**
 * CAL-002 — pushEventToCalendar previously always silently preferred Google over Microsoft when both were
 * connected (no way to choose otherwise) and never set a reminder on the pushed event at all. Real proof
 * both gaps are closed: an explicit destinationProvider is honored even when the other provider is also
 * connected, and reminderMinutesBefore reaches the adapter's pushEvent call.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const households = new HouseholdService(db, {} as never, {} as never);
const sharing = new SharingService(db);

const createdUserIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdEventIds: string[] = [];

afterAll(async () => {
  await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, createdEventIds));
  await db.delete(schema.connections).where(inArray(schema.connections.id, createdConnectionIds));
  await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
});

/** A fresh user per test — each test's "which providers are connected" state must be isolated from every
 * other test's, since a leftover connection from an earlier test would silently change what "not
 * connected" means for a later one. */
async function makeUser(): Promise<string> {
  const id = generateId("user");
  createdUserIds.push(id);
  await db.insert(schema.users).values({ id, displayName: "Push-to-calendar Test User" });
  return id;
}

async function makeConnection(ownerId: string, provider: "google_calendar" | "microsoft_calendar"): Promise<string> {
  const id = generateId("connection");
  createdConnectionIds.push(id);
  await db.insert(schema.connections).values({ id, ownerUserId: ownerId, provider, feasibilityClass: "direct_api", health: "healthy" });
  return id;
}

async function makeEvent(ownerId: string): Promise<string> {
  const id = generateId("calendarEvent");
  createdEventIds.push(id);
  await db.insert(schema.calendarEvents).values({
    id,
    ownerUserId: ownerId,
    title: "Return window closes",
    start: { precision: "date", date: "2026-09-15", instantUtc: null, timezone: null, sourceText: null },
    isAllDay: true,
    source: "manual",
  });
  return id;
}

function makeService() {
  const googleCalendar = { pushEvent: vi.fn(async () => ({ providerEventId: "google_evt_1" })) };
  const microsoftCalendar = { pushEvent: vi.fn(async () => ({ providerEventId: "ms_evt_1" })) };
  const schedule = new ScheduleService(db, households, googleCalendar as never, microsoftCalendar as never, sharing);
  return { schedule, googleCalendar, microsoftCalendar };
}

describe("ScheduleService.pushEventToCalendar — destination selection", () => {
  it("defaults to Google when both are connected and no destination is specified (backward-compatible default)", async () => {
    const { schedule, googleCalendar, microsoftCalendar } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_calendar");
    await makeConnection(ownerId, "microsoft_calendar");
    const eventId = await makeEvent(ownerId);

    const result = await schedule.pushEventToCalendar(eventId, ownerId);
    expect(result.provider).toBe("google_calendar");
    expect(googleCalendar.pushEvent).toHaveBeenCalledTimes(1);
    expect(microsoftCalendar.pushEvent).not.toHaveBeenCalled();
  });

  it("honors an explicit destinationProvider even when the other provider is also connected", async () => {
    const { schedule, googleCalendar, microsoftCalendar } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_calendar");
    await makeConnection(ownerId, "microsoft_calendar");
    const eventId = await makeEvent(ownerId);

    const result = await schedule.pushEventToCalendar(eventId, ownerId, { destinationProvider: "microsoft_calendar" });
    expect(result.provider).toBe("microsoft_calendar");
    expect(microsoftCalendar.pushEvent).toHaveBeenCalledTimes(1);
    expect(googleCalendar.pushEvent).not.toHaveBeenCalled();
  });

  it("rejects an explicit destinationProvider that isn't actually connected", async () => {
    const { schedule } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_calendar");
    const eventId = await makeEvent(ownerId);

    await expect(schedule.pushEventToCalendar(eventId, ownerId, { destinationProvider: "microsoft_calendar" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ScheduleService.pushEventToCalendar — reminder", () => {
  it("threads a real reminderMinutesBefore through to the adapter", async () => {
    const { schedule, googleCalendar } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_calendar");
    const eventId = await makeEvent(ownerId);

    await schedule.pushEventToCalendar(eventId, ownerId, { reminderMinutesBefore: 60 });
    expect(googleCalendar.pushEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reminderMinutesBefore: 60 }));
  });

  it("passes null (defer to the destination calendar's own default) when omitted, never a fabricated value", async () => {
    const { schedule, googleCalendar } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_calendar");
    const eventId = await makeEvent(ownerId);

    await schedule.pushEventToCalendar(eventId, ownerId);
    expect(googleCalendar.pushEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reminderMinutesBefore: null }));
  });
});
