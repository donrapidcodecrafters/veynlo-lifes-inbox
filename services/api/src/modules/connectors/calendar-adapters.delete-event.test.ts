import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import type { CredentialVault } from "../../common/credential-vault";
import type { IngestionService } from "../ingestion/ingestion.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

/**
 * AUTO-006/CAL-001 "an event pushed to a connected calendar must not be silently orphaned there once its
 * local row is deleted" — before this pass, neither `GoogleCalendarAdapter` nor `MicrosoftCalendarAdapter`
 * had a `deleteEvent` method at all (confirmed via grep). This dev environment has no real Google/Microsoft
 * OAuth credentials (see docs/PHASE2_PENDING_CREDENTIALS.md), so — matching
 * `calendar-write-back.service.test.ts`'s own established "fake adapter, never touch the network" stance
 * for this exact reason — these tests stub each adapter's own private transport method (Google's
 * `client()`, Microsoft's `graphRequest()`) rather than making a real HTTP call, while still exercising the
 * real `deleteEvent` method's own logic: the request it issues, and its 404/410-swallowing behavior.
 */
describe("GoogleCalendarAdapter.deleteEvent", () => {
  function buildAdapter(): GoogleCalendarAdapter {
    return new GoogleCalendarAdapter({} as Database, {} as CredentialVault, {} as IngestionService, stubQueue, {} as EntitlementsService);
  }

  it("calls calendar.events.delete with the right calendarId/eventId", async () => {
    const adapter = buildAdapter();
    const deleteCalls: Array<{ calendarId: string; eventId: string }> = [];
    (adapter as unknown as { client: (connectionId: string) => Promise<unknown> }).client = async () => ({
      calendar: { events: { delete: async (params: { calendarId: string; eventId: string }) => deleteCalls.push(params) } },
    });

    await adapter.deleteEvent("conn_123", "google_evt_abc");

    expect(deleteCalls).toEqual([{ calendarId: "primary", eventId: "google_evt_abc" }]);
  });

  it("treats a 404/410 (already gone on Google's side) as success, not an error", async () => {
    const adapter = buildAdapter();
    for (const status of [404, 410]) {
      (adapter as unknown as { client: (connectionId: string) => Promise<unknown> }).client = async () => ({
        calendar: {
          events: {
            delete: async () => {
              const err = new Error("Not Found") as Error & { code: number };
              err.code = status;
              throw err;
            },
          },
        },
      });
      await expect(adapter.deleteEvent("conn_123", "google_evt_abc")).resolves.toBeUndefined();
    }
  });

  it("propagates a real failure (e.g. a revoked token) rather than swallowing it", async () => {
    const adapter = buildAdapter();
    (adapter as unknown as { client: (connectionId: string) => Promise<unknown> }).client = async () => ({
      calendar: {
        events: {
          delete: async () => {
            const err = new Error("invalid_grant") as Error & { code: number };
            err.code = 401;
            throw err;
          },
        },
      },
    });

    await expect(adapter.deleteEvent("conn_123", "google_evt_abc")).rejects.toThrow("invalid_grant");
  });
});

describe("MicrosoftCalendarAdapter.deleteEvent", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ms-cal-delete-${ownerUserId}@example.com`, displayName: "MS Calendar Delete Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping MicrosoftCalendarAdapter.deleteEvent tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeConnection(): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "microsoft_calendar",
      feasibilityClass: "direct_api",
      credentialRef: "cred_test_stub",
      writeBackEnabled: true,
    });
    return connectionId;
  }

  function buildAdapter(): MicrosoftCalendarAdapter {
    return new MicrosoftCalendarAdapter(db, {} as CredentialVault, {} as IngestionService, stubQueue, {} as EntitlementsService);
  }

  it("issues a DELETE against /me/events/{id}", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    const adapter = buildAdapter();
    const requests: Array<{ url: string; method: string }> = [];
    (adapter as unknown as { graphRequest: (connection: unknown, url: string, method: string) => Promise<unknown> }).graphRequest = async (_connection, url, method) => {
      requests.push({ url, method });
      return undefined;
    };

    await adapter.deleteEvent(connectionId, "ms_evt_abc");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toContain("/me/events/ms_evt_abc");
  });

  it("treats a 404 (already gone on Microsoft's side) as success, not an error", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    const adapter = buildAdapter();
    (adapter as unknown as { graphRequest: (connection: unknown, url: string, method: string) => Promise<unknown> }).graphRequest = async () => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    };

    await expect(adapter.deleteEvent(connectionId, "ms_evt_abc")).resolves.toBeUndefined();
  });

  it("propagates a real failure rather than swallowing it", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    const adapter = buildAdapter();
    (adapter as unknown as { graphRequest: (connection: unknown, url: string, method: string) => Promise<unknown> }).graphRequest = async () => {
      const err = new Error("invalid_token") as Error & { status: number };
      err.status = 401;
      throw err;
    };

    await expect(adapter.deleteEvent(connectionId, "ms_evt_abc")).rejects.toThrow("invalid_token");
  });
});
