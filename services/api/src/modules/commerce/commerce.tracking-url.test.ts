import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import type { AttentionService } from "../attention/attention.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * A shipment's link to its carrier.
 *
 * `packages/core`'s carrier module is tested in isolation and thoroughly. What this adds is the join: that
 * the link actually reaches the client, that it is derived from the row rather than stored (so it works
 * for every shipment already in the database without a backfill), and — the part worth guarding — that a
 * shipment whose carrier cannot be established gets NO link rather than a wrong one.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubAttention = { fileIfNew: async () => {} } as unknown as AttentionService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf" }) } as unknown as NotificationDeliveryService;

describe("shipment tracking links", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      commerce = new CommerceService(db, stubAttention, stubNotifications);
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `tracking-${ownerUserId}@example.com`, displayName: "Tracking Test" });

      const shipments: Array<[string, string, string]> = [
        // key, carrier as stated by the sender, tracking number
        ["ups", "UPS", "1Z999AA10123456784"],
        // Ambiguous number, but the sender named the carrier — the link still works.
        ["statedFedex", "FedEx", "123456789012"],
        // Carrier nobody recognises AND an ambiguous number: no link is the only honest answer.
        ["unknown", "Some Regional Courier", "123456789012"],
        // No stated carrier, but the number's shape identifies it on its own.
        ["detected", "Unknown carrier", "TBA123456789012"],
      ];

      for (const [key, carrier, trackingNumber] of shipments) {
        const id = generateId("shipment");
        ids[key] = id;
        await db.insert(schema.shipments).values({
          id,
          ownerUserId,
          carrier,
          trackingNumber,
          status: "in_transit",
          confidenceBand: "high",
          isGiftPrivate: false,
        });
      }
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "shipment tracking link tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("attaches a carrier link to the shipment list", async () => {
    if (!dbAvailable) return;
    const rows = await commerce.shipments(ownerUserId);
    const ups = rows.find((r) => r.shipment.id === ids.ups);
    expect(ups?.shipment.trackingUrl).toContain("ups.com");
    expect(ups?.shipment.trackingUrl).toContain("1Z999AA10123456784");
  });

  it("attaches a carrier link to the shipment detail", async () => {
    if (!dbAvailable) return;
    const detail = await commerce.shipmentDetail(ids.ups!, ownerUserId);
    expect(detail?.shipment.trackingUrl).toContain("ups.com");
  });

  it("uses the carrier the sender named even when the number's shape is ambiguous", async () => {
    if (!dbAvailable) return;
    // 12 digits is equally a FedEx and a USPS number. The sender said FedEx, and that is better evidence
    // than any pattern — so this one gets a working link where detection alone would give none.
    const rows = await commerce.shipments(ownerUserId);
    const stated = rows.find((r) => r.shipment.id === ids.statedFedex);
    expect(stated?.shipment.trackingUrl).toContain("fedex.com");
  });

  it("gives no link at all when the carrier cannot be established", async () => {
    if (!dbAvailable) return;
    // The assertion that matters. A link to the wrong carrier reports "not found" for a parcel that is
    // perfectly fine, and looks to the user like the app lost their package.
    const rows = await commerce.shipments(ownerUserId);
    const unknown = rows.find((r) => r.shipment.id === ids.unknown);
    expect(unknown?.shipment.trackingUrl).toBeNull();
  });

  it("falls back to the number's own shape when no carrier was named", async () => {
    if (!dbAvailable) return;
    const rows = await commerce.shipments(ownerUserId);
    const detected = rows.find((r) => r.shipment.id === ids.detected);
    expect(detected?.shipment.trackingUrl).toContain("amazon.com");
  });

  it("still returns the underlying row unchanged", async () => {
    if (!dbAvailable) return;
    // The link is added, not substituted — nothing downstream should lose a field because of it.
    const rows = await commerce.shipments(ownerUserId);
    const ups = rows.find((r) => r.shipment.id === ids.ups);
    expect(ups?.shipment.carrier).toBe("UPS");
    expect(ups?.shipment.trackingNumber).toBe("1Z999AA10123456784");
    expect(ups?.shipment.status).toBe("in_transit");
  });
});
