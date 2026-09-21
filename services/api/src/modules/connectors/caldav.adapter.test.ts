import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DAVClient } from "tsdav";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CalDavAdapter } from "./caldav.adapter";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { FakeModelProvider } from "../intelligence/fake-model-provider";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * CalDAV against a REAL CalDAV server over REAL TLS.
 *
 * Same reasoning as the IMAP suite: the parts of a DAV connector most likely to be wrong are the ones a
 * mock defines away — whether discovery actually finds the calendars, whether a time-range query returns
 * what was asked for, and whether the iCalendar that comes back parses into the temporal shape the rest of
 * this app expects. A mocked DAV client returns whatever the code already assumes.
 *
 * Radicale in Docker, given the same generated localhost certificate the IMAP suite uses so the adapter's
 * TLS requirement is exercised as it ships rather than relaxed for the test.
 *
 *   docker run -d --name veynlo-radicale -p 5232:5232 \
 *     -v <repo>/.claude/test-certs:/certs:ro \
 *     -v <repo>/.claude/test-certs/radicale-config:/config:ro \
 *     tomsquest/docker-radicale:latest
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem npx vitest run src/modules/connectors/caldav.adapter.test.ts
 *
 * `connect()` is not exercised here and cannot be: it calls `assertHostnameIsPublic`, which correctly
 * refuses localhost. That guard has its own tests. What runs here is the sync path against stored,
 * already-validated credentials — the real runtime path.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const SERVER_URL = "https://localhost:5232";
const DAV_USER = "veynlo-test";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalware = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "t", segmentId: "s", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = {
  assertConnectorQuota: async () => {},
  resolveHistoricalBackfillDays: async () => 365,
  assertStorageQuota: async () => {},
  getCapability: async () => true,
} as unknown as EntitlementsService;
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

function davClient() {
  return new DAVClient({
    serverUrl: SERVER_URL,
    credentials: { username: DAV_USER, password: "any" },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
}

/** An iCalendar VEVENT, written the way a real client writes one. */
function icsEvent(uid: string, summary: string, startUtc: string, endUtc: string, location?: string) {
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veynlo//test//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(startUtc)}`,
    `DTEND:${stamp(endUtc)}`,
    `SUMMARY:${summary}`,
    ...(location ? [`LOCATION:${location}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("CalDavAdapter against a real CalDAV server", () => {
  let db: Database;
  let adapter: CalDavAdapter;
  let ownerUserId: string;
  let connectionId: string;
  let available = true;
  let calendarUrl: string | null = null;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `caldav-test-${ownerUserId}@example.com`, displayName: "CalDAV Test" });
    } catch (err) {
      available = skipIfDatabaseUnreachable(err, "CalDavAdapter tests");
      return;
    }

    // Create a calendar and put two events in it, using a real DAV client against the real server.
    try {
      const client = davClient();
      await client.login();
      let calendars = await client.fetchCalendars();
      if (!calendars || calendars.length === 0) {
        await client.makeCalendar({ url: `${SERVER_URL}/${DAV_USER}/veynlo-test-calendar/`, props: { displayname: "Veynlo Test" } });
        calendars = await client.fetchCalendars();
      }
      const calendar = calendars?.[0];
      if (!calendar) throw new Error("no calendar available after makeCalendar");
      calendarUrl = String(calendar.url);

      const soon = new Date(Date.now() + 3 * 86_400_000);
      const soonEnd = new Date(soon.getTime() + 3_600_000);
      await client.createCalendarObject({
        calendar,
        filename: "veynlo-dentist.ics",
        iCalString: icsEvent("veynlo-dentist-1", "Dentist appointment", soon.toISOString(), soonEnd.toISOString(), "12 High Street"),
      });

      const later = new Date(Date.now() + 10 * 86_400_000);
      const laterEnd = new Date(later.getTime() + 7_200_000);
      await client.createCalendarObject({
        calendar,
        filename: "veynlo-review.ics",
        iCalString: icsEvent("veynlo-review-1", "Quarterly review", later.toISOString(), laterEnd.toISOString()),
      });
    } catch (err) {
      console.warn(`Radicale is not reachable on ${SERVER_URL} — skipping the real-CalDAV suite. ${String((err as Error)?.message ?? err)}`);
      available = false;
      return;
    }

    const vault = new CredentialVault(db);
    const ingestion = new IngestionService(
      db,
      new FakeModelProvider(),
      stubNotifications,
      stubStorage,
      stubMalware,
      stubEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
    );
    adapter = new CalDavAdapter(db, vault, stubEntitlements, stubQueue, ingestion);

    connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      householdId: null,
      provider: "caldav",
      feasibilityClass: "open_standard",
      scopes: ["calendar.read"],
      enabledCategories: ["appointments"],
      health: "initializing",
      historyDepthDays: 365,
    });
    const credentialRef = await vault.store(
      connectionId,
      { serverUrl: SERVER_URL, username: DAV_USER, password: "any", providerKey: "custom" },
      null,
    );
    await db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));
  }, 90_000);

  afterAll(async () => {
    if (ownerUserId) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });


  /**
   * Prove this suite actually ran against the real server.
   *
   * Every test below early-returns when the server is unreachable, which is the repo's convention and is
   * right for CI — but it means a suite that connected to NOTHING reports exactly the same green as one
   * that connected to everything. That is the vacuous pass this audit keeps finding, and it is worse here
   * than most places because the whole point of these tests is that they are not mocked.
   *
   * So: set REQUIRE_REAL_SERVER=1 and the skip becomes a failure. The verification harness sets it; a
   * developer running the suite on a laptop with no Docker does not.
   */
  it("actually reached the real server (REQUIRE_REAL_SERVER)", () => {
    if (process.env.REQUIRE_REAL_SERVER === "1") {
      expect(available, "REQUIRE_REAL_SERVER=1 but the server was unreachable — this suite proved nothing").toBe(true);
    } else if (!available) {
      console.warn("   (skipped: the real server was unreachable — set REQUIRE_REAL_SERVER=1 to make that a failure)");
    }
  });

  it("discovers calendars and files their events over real TLS", async () => {
    if (!available) return;

    const result = await adapter.initialSync(connectionId);
    expect(result.itemCount, "no events were filed from the CalDAV server").toBeGreaterThan(0);

    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    const dentist = events.find((e) => e.title === "Dentist appointment");
    expect(dentist, "the event created on the server did not reach the database").toBeDefined();
    // The location came through the iCalendar, not from anywhere else.
    expect(dentist?.location).toBe("12 High Street");
    expect(events.find((e) => e.title === "Quarterly review")).toBeDefined();
  }, 90_000);

  it("does not duplicate events on a second sync", async () => {
    if (!available) return;

    const before = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    await adapter.incrementalSync(connectionId);
    const after = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));

    // Dedup is by the event's own UID, which is what makes a CalDAV sync safe to run repeatedly.
    expect(after).toHaveLength(before.length);
  }, 90_000);

  it("picks up an event added on the server after the first sync", async () => {
    if (!available) return;
    if (!calendarUrl) return;

    const client = davClient();
    await client.login();
    const calendars = await client.fetchCalendars();
    const calendar = calendars?.find((c) => String(c.url) === calendarUrl) ?? calendars?.[0];
    if (!calendar) return;

    const when = new Date(Date.now() + 20 * 86_400_000);
    await client.createCalendarObject({
      calendar,
      filename: "veynlo-added.ics",
      iCalString: icsEvent("veynlo-added-1", "Added after first sync", when.toISOString(), new Date(when.getTime() + 3_600_000).toISOString()),
    });

    await adapter.incrementalSync(connectionId);
    const events = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(events.find((e) => e.title === "Added after first sync")).toBeDefined();
  }, 90_000);

  it("marks the connection healthy with a real sync timestamp", async () => {
    if (!available) return;
    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connection?.health).toBe("healthy");
    expect(connection?.lastSuccessfulSyncAt).toBeTruthy();
  });

  it("flags an unreachable server as degraded rather than leaving it healthy", async () => {
    if (!available) return;

    const vault = new CredentialVault(db);
    const brokenId = generateId("connection");
    await db.insert(schema.connections).values({
      id: brokenId,
      ownerUserId,
      householdId: null,
      provider: "caldav",
      feasibilityClass: "open_standard",
      scopes: ["calendar.read"],
      enabledCategories: ["appointments"],
      health: "healthy",
      historyDepthDays: 30,
    });
    const ref = await vault.store(brokenId, { serverUrl: "https://localhost:5233", username: DAV_USER, password: "any", providerKey: "custom" }, null);
    await db.update(schema.connections).set({ credentialRef: ref }).where(eq(schema.connections.id, brokenId));

    await expect(adapter.initialSync(brokenId)).rejects.toThrow();

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, brokenId));
    // A dead source must be visible as one — §43.3's health model exists for exactly this.
    expect(connection?.health).toBe("degraded");
    expect(connection?.healthDetail).toBeTruthy();
  }, 90_000);
});
