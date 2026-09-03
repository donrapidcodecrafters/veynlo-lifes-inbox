import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import type { CredentialVault } from "../../common/credential-vault";
import type { IngestionService } from "../ingestion/ingestion.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * Google/Microsoft Calendar event ids are commonly shared across attendees of the same invite — two
 * different Veynlo users (e.g. two household members both syncing their own Google Calendar connection)
 * can each hold a `calendar_events` row with the identical `providerEventId` for one shared meeting.
 * `ingestEvent`'s cancel-handling delete used to be scoped only by `providerEventId`, with no owner
 * check, so when either attendee's sync saw the event get cancelled, it deleted BOTH users' rows — real
 * cross-tenant data loss found live during the backend audit. This proves the fix: the delete is now
 * scoped by `ownerUserId` too, so cancelling from one user's sync only ever removes that user's own row.
 */
describe("GoogleCalendarAdapter — cancel-on-sync delete is owner-scoped", () => {
  let db: Database;
  let adapter: GoogleCalendarAdapter;
  let ownerAUserId: string;
  let ownerBUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    adapter = new GoogleCalendarAdapter(
      db,
      {} as CredentialVault,
      {} as IngestionService,
      { enqueueConnectorSync: async () => {} } as unknown as QueueProducer,
      {} as EntitlementsService,
    );
    try {
      ownerAUserId = generateId("user");
      ownerBUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerAUserId, email: `gcal-owner-a-${ownerAUserId}@example.com`, displayName: "Owner A" },
        { id: ownerBUserId, email: `gcal-owner-b-${ownerBUserId}@example.com`, displayName: "Owner B" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping GoogleCalendarAdapter tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerAUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerBUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerAUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("only deletes the syncing user's own row when a shared event is cancelled", async () => {
    if (!dbAvailable) return;
    const sharedProviderEventId = `gcal_${generateId("calendarEvent")}`; // stands in for a real Google event id shared by both attendees
    const eventAId = generateId("calendarEvent");
    const eventBId = generateId("calendarEvent");
    const start = { precision: "instant" as const, instantUtc: new Date().toISOString(), date: null, timezone: null, sourceText: null };

    await db.insert(schema.calendarEvents).values([
      {
        id: eventAId,
        ownerUserId: ownerAUserId,
        title: "Shared meeting (owner A's copy)",
        start,
        source: "google_calendar",
        providerEventId: sharedProviderEventId,
      },
      {
        id: eventBId,
        ownerUserId: ownerBUserId,
        title: "Shared meeting (owner B's copy)",
        start,
        source: "google_calendar",
        providerEventId: sharedProviderEventId,
      },
    ]);

    const connectionForA = { ownerUserId: ownerAUserId } as typeof schema.connections.$inferSelect;
    // ingestEvent is private — this is the exact code path GoogleCalendarAdapter's own sync loop calls.
    const ingestEvent = (adapter as unknown as { ingestEvent: (c: typeof schema.connections.$inferSelect, id: string, e: { id: string; status: string }) => Promise<boolean> }).ingestEvent.bind(adapter);
    await ingestEvent(connectionForA, "conn_test", { id: sharedProviderEventId, status: "cancelled" });

    const remaining = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.providerEventId, sharedProviderEventId));
    expect(remaining.map((r) => r.id)).toEqual([eventBId]); // A's row is gone; B's survives untouched

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventBId));
  });
});
