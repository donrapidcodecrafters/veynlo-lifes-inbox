import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CalendarWriteBackService } from "./calendar-write-back.service";
import { ConnectorsService } from "./connectors.service";
import type { IdentityService } from "../identity/identity.service";
import type { PlaidAdapter } from "./plaid.adapter";
import type { GoogleCalendarAdapter } from "./google-calendar.adapter";
import type { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import type { CredentialVault } from "../../common/credential-vault";

/**
 * DEF-103 — what actually reaches the provider when an event has no time.
 *
 * Both adapters choose their branch on `isAllDay` rather than on what is available:
 *
 *   Google     start: isAllDay ? { date: startDate } : { dateTime: startInstantUtc ?? undefined }
 *   Microsoft  start: isAllDay ? { dateTime: `${startDate}T00:00:00` } : { dateTime: (startInstantUtc ?? "").replace(...) }
 *
 * So an event marked timed that carries only a DATE — exactly the shape every email-discovered
 * appointment had until DEF-102 — was pushed as `start: {}` to Google and `dateTime: ""` to Outlook. The
 * provider rejects it, `pushEvent` swallows the error by design, and the user is told "couldn't sync yet"
 * forever with nothing to indicate it never could.
 *
 * These assert what the ADAPTER RECEIVES, not that the push returned true. A push that "succeeds" against
 * a fake adapter while handing it an empty start is precisely the failure being fixed, so asserting on the
 * return value would pass against the bug.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubQueue = { add: async () => {} } as never;

type Captured = { input: { isAllDay: boolean; startInstantUtc: string | null; startDate: string | null } };

function fakeAdapter() {
  const calls: Captured[] = [];
  return {
    calls,
    adapter: {
      createEvent: async (_connectionId: string, input: Captured["input"]) => {
        calls.push({ input });
        return { providerEventId: `prov_${calls.length}` };
      },
      updateEvent: async (_c: string, _p: string, input: Captured["input"]) => {
        calls.push({ input });
      },
    } as unknown as GoogleCalendarAdapter,
  };
}

describe("DEF-103 — write-back never hands a provider an empty start", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `wb103-${ownerUserId}@example.com`, displayName: "WB 103" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DEF-103 tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeEvent(start: Record<string, unknown>, isAllDay: boolean): Promise<string> {
    const eventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId,
      title: "Riverside Dental Cleaning",
      start: start as never,
      isAllDay,
      source: "discovered_from_evidence",
      status: "confirmed",
    });
    return eventId;
  }

  async function makeConnection(): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "google_calendar",
      feasibilityClass: "direct_api",
      scopes: ["https://www.googleapis.com/auth/calendar"],
      writeBackEnabled: true,
    });
    return connectionId;
  }

  function service(google: GoogleCalendarAdapter) {
    return new CalendarWriteBackService(
      db,
      new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault),
      google,
      {} as MicrosoftCalendarAdapter,
    );
  }

  it("a timed event carrying only a date is pushed as ALL-DAY, never as a timed event with no time", async () => {
    if (!dbAvailable) return;
    const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const eventId = await makeEvent(
      { precision: "date", instantUtc: null, date, timezone: "America/Los_Angeles", sourceText: null },
      false, // marked timed, but there is no time — the pre-DEF-102 shape
    );
    const connectionId = await makeConnection();
    const { calls, adapter } = fakeAdapter();

    await service(adapter).pushEvent({ eventId, ownerUserId, connectionId });

    expect(calls).toHaveLength(1);
    const input = calls[0]!.input;
    // The truthful representation of "we know the day and not the time".
    expect(input.isAllDay).toBe(true);
    expect(input.startDate).toBe(date);
    // And emphatically NOT a timed event whose time is missing, which is what the provider was being sent.
    expect(input.startInstantUtc).toBeNull();
  });

  it("an event with a real instant is still pushed as timed, with that instant", async () => {
    if (!dbAvailable) return;
    const instant = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const eventId = await makeEvent({ precision: "instant", instantUtc: instant, date: null, timezone: null, sourceText: null }, false);
    const connectionId = await makeConnection();
    const { calls, adapter } = fakeAdapter();

    await service(adapter).pushEvent({ eventId, ownerUserId, connectionId });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.isAllDay).toBe(false);
    expect(calls[0]!.input.startInstantUtc).toBe(instant);
  });

  it("an event with no usable date at all is refused, rather than sent as \"undefined T00:00:00\"", async () => {
    if (!dbAvailable) return;
    const eventId = await makeEvent({ precision: "approximate", instantUtc: null, date: null, timezone: null, sourceText: "early next month" }, false);
    const connectionId = await makeConnection();
    const { calls, adapter } = fakeAdapter();

    await expect(service(adapter).pushEvent({ eventId, ownerUserId, connectionId })).rejects.toMatchObject({
      response: { code: "EVENT_HAS_NO_USABLE_START" },
    });
    expect(calls).toHaveLength(0);
  });
});
