import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CalendarWriteBackService } from "./calendar-write-back.service";
import { ConnectorsService } from "./connectors.service";
import type { GoogleCalendarAdapter, WriteBackEventInput } from "./google-calendar.adapter";
import type { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { IdentityService } from "../identity/identity.service";
import type { PlaidAdapter } from "./plaid.adapter";
import type { CredentialVault } from "../../common/credential-vault";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = { enqueueConnectorSync: async () => {}, enqueueConnectionDataDeletion: async () => {} } as unknown as QueueProducer;

/** A fake adapter that never touches the network — createEvent/updateEvent behavior is configured per test
 * via `behavior`, standing in for "the real Google/Microsoft API call succeeded" or "...failed" without
 * needing to mock the `googleapis` package or make a real HTTP request (this dev environment has no real
 * Google/Microsoft OAuth credentials configured anyway — see docs/PHASE2_PENDING_CREDENTIALS.md). What's
 * under test here is CalendarWriteBackService's own logic: does it call the adapter only when write-back
 * is enabled, and does an adapter failure ever corrupt the local event row — not the real provider call
 * itself, which google-calendar.adapter.ts/microsoft-calendar.adapter.ts already build on the same
 * `client(connectionId)`/`graphRequest` machinery `initialSync` uses (proven by the OAuth-callback flow
 * itself, which real credentials would exercise end to end).
 */
function fakeAdapter(behavior: "succeed" | "fail") {
  const calls: { kind: "create" | "update" | "delete"; connectionId: string; providerEventId?: string; event?: WriteBackEventInput }[] = [];
  return {
    calls,
    createEvent: async (connectionId: string, event: WriteBackEventInput) => {
      calls.push({ kind: "create", connectionId, event });
      if (behavior === "fail") throw new Error("simulated provider failure");
      return { providerEventId: `provider_${generateId("calendarEvent")}` };
    },
    updateEvent: async (connectionId: string, providerEventId: string, event: WriteBackEventInput) => {
      calls.push({ kind: "update", connectionId, providerEventId, event });
      if (behavior === "fail") throw new Error("simulated provider failure");
    },
    // AUTO-006/CAL-001 deleteEvent — see CalendarWriteBackService.deleteEvent's own describe block below.
    deleteEvent: async (connectionId: string, providerEventId: string) => {
      calls.push({ kind: "delete", connectionId, providerEventId });
      if (behavior === "fail") throw new Error("simulated provider failure");
    },
  };
}

describe("CalendarWriteBackService — CAL-001 write-back push", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `writeback-${ownerUserId}@example.com`, displayName: "Write-back Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CalendarWriteBackService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeEvent(): Promise<string> {
    const eventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title: "Dentist appointment",
      start: { precision: "instant", instantUtc: new Date(Date.now() + 86_400_000).toISOString(), date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
    });
    return eventId;
  }

  async function makeConnection(provider: string, writeBackEnabled: boolean): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider,
      feasibilityClass: "direct_api",
      scopes: writeBackEnabled ? ["https://www.googleapis.com/auth/calendar"] : ["https://www.googleapis.com/auth/calendar.readonly"],
      writeBackEnabled,
    });
    return connectionId;
  }

  it("never calls the adapter when write-back is disabled, and leaves the local event untouched", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent();
    const connectionId = await makeConnection("google_calendar", false);
    const google = fakeAdapter("succeed");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    await expect(service.pushEvent({ eventId, ownerUserId, connectionId })).rejects.toMatchObject({ response: { code: "WRITE_BACK_DISABLED" } });
    expect(google.calls).toHaveLength(0);

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect(row?.writeBackStatus).toBeNull();
    expect(row?.providerEventId).toBeNull();
  });

  it("a provider-side failure is logged/flagged, never thrown, and never corrupts the local event", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent();
    const connectionId = await makeConnection("google_calendar", true);
    const google = fakeAdapter("fail");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    const result = await service.pushEvent({ eventId, ownerUserId, connectionId });
    expect(result).toEqual({ pushed: false });

    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect(row?.title).toBe("Dentist appointment"); // the local event survives completely intact
    expect(row?.writeBackStatus).toBe("failed");
    expect(row?.providerEventId).toBeNull(); // never set on a failed create
  });

  it("a successful push creates once, then updates in place on a second push to the same connection", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent();
    const connectionId = await makeConnection("google_calendar", true);
    const google = fakeAdapter("succeed");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    const first = await service.pushEvent({ eventId, ownerUserId, connectionId });
    expect(first).toEqual({ pushed: true });
    expect(google.calls).toEqual([expect.objectContaining({ kind: "create" })]);

    const [afterCreate] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
    expect(afterCreate?.writeBackStatus).toBe("pushed");
    expect(afterCreate?.writeBackConnectionId).toBe(connectionId);
    expect(afterCreate?.providerEventId).toBeTruthy();

    const second = await service.pushEvent({ eventId, ownerUserId, connectionId });
    expect(second).toEqual({ pushed: true });
    expect(google.calls).toEqual([expect.objectContaining({ kind: "create" }), expect.objectContaining({ kind: "update", providerEventId: afterCreate!.providerEventId })]);
  });

  it("refuses to push to a connection that isn't a calendar provider", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent();
    const connectionId = await makeConnection("gmail", false);
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), {} as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    await expect(service.pushEvent({ eventId, ownerUserId, connectionId })).rejects.toMatchObject({ response: { code: "UNSUPPORTED_PROVIDER" } });
  });
});

/**
 * AUTO-006/CAL-001 "an event pushed to a connected calendar must not be silently orphaned there once its
 * local row is deleted" — `deleteEvent` is the delete counterpart to `pushEvent` above, and the single
 * place both the generic `DELETE /v1/calendar-events/:id` endpoint and `AutomationService.undoRun` go to
 * delete a `calendar_events` row. Same "never touch the network in this dev environment" fake-adapter
 * stance as the push describe block above.
 */
describe("CalendarWriteBackService.deleteEvent", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `writeback-delete-${ownerUserId}@example.com`, displayName: "Write-back Delete Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CalendarWriteBackService.deleteEvent tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeEvent(pushed: { connectionId: string; providerEventId: string } | null): Promise<string> {
    const eventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title: "Dentist appointment",
      start: { precision: "instant", instantUtc: new Date(Date.now() + 86_400_000).toISOString(), date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      writeBackConnectionId: pushed?.connectionId ?? null,
      providerEventId: pushed?.providerEventId ?? null,
      writeBackStatus: pushed ? "pushed" : null,
    });
    return eventId;
  }

  async function makeConnection(provider: string): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider, feasibilityClass: "direct_api", writeBackEnabled: true });
    return connectionId;
  }

  it("throws EVENT_NOT_FOUND for an event that doesn't exist or isn't owned by this user", async () => {
    if (!dbAvailable) return;
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), {} as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);
    await expect(service.deleteEvent({ eventId: generateId("calendarEvent"), ownerUserId })).rejects.toMatchObject({ response: { code: "EVENT_NOT_FOUND" } });
  });

  it("never calls the adapter for an event that was never pushed, and deletes the local row", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent(null);
    const google = fakeAdapter("succeed");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    const result = await service.deleteEvent({ eventId, ownerUserId });

    expect(result).toEqual({ deleted: true });
    expect(google.calls).toHaveLength(0);
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);
  });

  it("best-effort deletes the provider-side copy FIRST, then the local row, for a previously pushed event", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection("google_calendar");
    const eventId = await makeEvent({ connectionId, providerEventId: "google_evt_789" });
    const google = fakeAdapter("succeed");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    const result = await service.deleteEvent({ eventId, ownerUserId });

    expect(result).toEqual({ deleted: true });
    expect(google.calls).toEqual([{ kind: "delete", connectionId, providerEventId: "google_evt_789" }]);
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);
  });

  it("a provider-side delete failure is logged and swallowed — the local row is still deleted", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection("google_calendar");
    const eventId = await makeEvent({ connectionId, providerEventId: "google_evt_fail" });
    const google = fakeAdapter("fail");
    const service = new CalendarWriteBackService(db, new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault), google as unknown as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);

    await expect(service.deleteEvent({ eventId, ownerUserId })).resolves.toEqual({ deleted: true });
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);
  });

  it("routes to the Microsoft adapter for a microsoft_calendar connection, not Google's", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection("microsoft_calendar");
    const eventId = await makeEvent({ connectionId, providerEventId: "ms_evt_123" });
    const google = fakeAdapter("succeed");
    const microsoft = fakeAdapter("succeed");
    const service = new CalendarWriteBackService(
      db,
      new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault),
      google as unknown as GoogleCalendarAdapter,
      microsoft as unknown as MicrosoftCalendarAdapter,
    );

    await service.deleteEvent({ eventId, ownerUserId });

    expect(google.calls).toHaveLength(0);
    expect(microsoft.calls).toEqual([{ kind: "delete", connectionId, providerEventId: "ms_evt_123" }]);
  });
});
