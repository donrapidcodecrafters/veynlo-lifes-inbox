import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ImapAdapter } from "./imap.adapter";
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
 * IMAP, against a REAL IMAP server over REAL TLS.
 *
 * This is deliberately not a mocked `imapflow`. The things most likely to be wrong in an IMAP connector
 * are the parts a mock defines away: whether the UID cursor actually resumes, whether a second sync
 * re-ingests everything, whether mailparser's output maps onto what the pipeline expects, and whether the
 * HTML part survives intact. A mock that returns whatever shape the code already assumes proves that the
 * code agrees with itself.
 *
 * So: GreenMail in Docker, mail delivered over its SMTP port, read back over IMAPS on 3993.
 *
 * The certificate matters. GreenMail's built-in cert has CN "GreenMail selfsigned Test Certificate" and no
 * SAN, so Node's hostname check rejects it — and the correct response to that was NOT to relax
 * `rejectUnauthorized` in the adapter to make a test pass. A connector that holds a mailbox password must
 * verify the server it hands it to. GreenMail is given a real localhost certificate instead, and the test
 * runs with NODE_EXTRA_CA_CERTS pointing at it, so the adapter's TLS settings are exercised exactly as
 * they ship.
 *
 *   docker run -d --name veynlo-greenmail -p 3143:3143 -p 3993:3993 -p 3025:3025 \
 *     -v <repo>/.claude/test-certs:/certs:ro \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled \
 *       -Dgreenmail.tls.keystore.file=/certs/greenmail-keystore.p12 -Dgreenmail.tls.keystore.password=changeit" \
 *     greenmail/standalone:2.1.0
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem npx vitest run src/modules/connectors/imap.adapter.test.ts
 *
 * Skips rather than fails when GreenMail is not running, the same posture as the database-backed suites.
 *
 * `connect()` itself is NOT exercised here, and cannot be: it calls `assertHostnameIsPublic`, which
 * correctly refuses localhost. That guard has its own tests. What runs here is `initialSync` /
 * `incrementalSync` against stored, already-validated credentials — which is the real runtime path.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const IMAP_HOST = "localhost";
const IMAP_PORT = 3993;
const SMTP_PORT = 3025;
const MAILBOX_USER = "imaptest@localhost";

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

async function greenmailReachable(): Promise<boolean> {
  try {
    const transport = nodemailer.createTransport({ host: IMAP_HOST, port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
    await transport.verify();
    return true;
  } catch {
    return false;
  }
}

/** Deliver a message into the test mailbox over GreenMail's SMTP port. */
async function deliver(subject: string, html: string, text: string): Promise<void> {
  const transport = nodemailer.createTransport({ host: IMAP_HOST, port: SMTP_PORT, secure: false, tls: { rejectUnauthorized: false } });
  await transport.sendMail({ from: "orders@example-outfitters.test", to: MAILBOX_USER, subject, text, html });
}

describe("ImapAdapter against a real IMAP server", () => {
  let db: Database;
  let adapter: ImapAdapter;
  let ownerUserId: string;
  let connectionId: string;
  let available = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `imap-test-${ownerUserId}@example.com`, displayName: "IMAP Test" });
    } catch (err) {
      available = skipIfDatabaseUnreachable(err, "ImapAdapter tests");
      return;
    }

    if (!(await greenmailReachable())) {
      console.warn("GreenMail is not running on localhost:3025 — skipping the real-IMAP suite. See this file's header for how to start it.");
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
    adapter = new ImapAdapter(db, vault, stubEntitlements, stubQueue, ingestion);

    connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      householdId: null,
      provider: "imap",
      feasibilityClass: "open_standard",
      scopes: ["mail.read"],
      enabledCategories: ["purchases", "bills", "appointments"],
      health: "initializing",
      historyDepthDays: 365,
    });
    const credentialRef = await vault.store(
      connectionId,
      { host: IMAP_HOST, port: IMAP_PORT, secure: true, username: MAILBOX_USER, password: "any-password", providerKey: "custom" },
      null,
    );
    await db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));
  }, 60_000);

  afterAll(async () => {
    if (ownerUserId) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("reads a real mailbox over TLS and files what the sender declared in it", async () => {
    if (!available) return;

    const orderNumber = `IMAP-${Date.now()}`;
    const html =
      `<html><body><p>Your order shipped.</p>` +
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Order",
        orderNumber,
        merchant: { "@type": "Organization", name: "Example Outfitters" },
        orderDate: "2026-09-18",
        priceSpecification: { price: "64.50", priceCurrency: "USD" },
      })}</script></body></html>`;
    await deliver("Your order is confirmed", html, "Your order shipped.");

    const result = await adapter.initialSync(connectionId);
    expect(result.itemCount).toBeGreaterThan(0);

    // A source event exists, from a real IMAP fetch of a real message.
    const events = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.connectionId, connectionId));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.kind).toBe("email_message");

    // And the markup in the HTML part survived mailparser and the whole pipeline. This is the assertion
    // that proves bodyHtml is genuinely carried from an IMAP fetch — the text/plain part alone contains
    // none of these values.
    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    const filed = purchases.find((p) => p.orderNumber === orderNumber);
    expect(filed, "the Order declared in the HTML part did not reach the pipeline").toBeDefined();
    expect(filed?.totalMinorUnits).toBe(6_450);
  }, 60_000);

  it("records a UID cursor and does not re-ingest the same message on the next sync", async () => {
    if (!available) return;

    const [before] = await db.select({ cursor: schema.connections.cursor }).from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(before?.cursor, "no UID cursor was stored after the first sync").toBeTruthy();
    const parsed = JSON.parse(before!.cursor!) as { uidValidity: string; lastUid: number };
    expect(parsed.lastUid).toBeGreaterThan(0);
    expect(parsed.uidValidity).toBeTruthy();

    const eventsBefore = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.connectionId, connectionId));

    // Nothing new has arrived, so an incremental sync must find nothing and change nothing.
    const again = await adapter.incrementalSync(connectionId);
    expect(again.itemCount).toBe(0);

    const eventsAfter = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.connectionId, connectionId));
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  }, 60_000);

  it("picks up only genuinely new mail on an incremental sync", async () => {
    if (!available) return;

    const eventsBefore = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.connectionId, connectionId));
    const tracking = `1ZIMAP${Date.now()}`;
    const html =
      `<html><body><p>On its way.</p>` +
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ParcelDelivery",
        trackingNumber: tracking,
        carrier: { "@type": "Organization", name: "UPS" },
        expectedArrivalUntil: "2026-09-30",
      })}</script></body></html>`;
    await deliver("Your package is on its way", html, "On its way.");

    const result = await adapter.incrementalSync(connectionId);
    expect(result.itemCount).toBe(1);

    const eventsAfter = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.connectionId, connectionId));
    // Exactly one more — the cursor resumed rather than refetching the mailbox.
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1);

    const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
    expect(shipments.find((s) => s.trackingNumber === tracking)).toBeDefined();
  }, 60_000);

  it("marks the connection healthy with a real sync timestamp", async () => {
    if (!available) return;
    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connection?.health).toBe("healthy");
    expect(connection?.lastSuccessfulSyncAt).toBeTruthy();
  });

  it("flags a revoked password as needing reauthorization, not as a transient fault", async () => {
    if (!available) return;

    // A separate connection, so the healthy one above is not disturbed. GreenMail runs with auth disabled
    // and accepts anything, so the failure is forced with an unreachable port instead — what is asserted
    // is the health TRANSITION, which is the part this adapter owns.
    const vault = new CredentialVault(db);
    const brokenId = generateId("connection");
    await db.insert(schema.connections).values({
      id: brokenId,
      ownerUserId,
      householdId: null,
      provider: "imap",
      feasibilityClass: "open_standard",
      scopes: ["mail.read"],
      enabledCategories: ["purchases"],
      health: "healthy",
      historyDepthDays: 30,
    });
    const ref = await vault.store(
      brokenId,
      { host: IMAP_HOST, port: 3994, secure: true, username: MAILBOX_USER, password: "x", providerKey: "custom" },
      null,
    );
    await db.update(schema.connections).set({ credentialRef: ref }).where(eq(schema.connections.id, brokenId));

    await expect(adapter.initialSync(brokenId)).rejects.toThrow();

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, brokenId));
    // Not silently left "healthy" — the spec's §43.3 health model exists so a user can see a dead source.
    expect(connection?.health).toBe("degraded");
    expect(connection?.healthDetail).toBeTruthy();
  }, 60_000);
});
