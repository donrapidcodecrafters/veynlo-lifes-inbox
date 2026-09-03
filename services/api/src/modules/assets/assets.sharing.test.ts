import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AssetsService } from "./assets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import type { RecallMonitorService } from "./recall-monitor.service";
import type { VinDecodeService } from "./vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002), generalized off documents onto properties —
 * see SharingService's own doc comment. Mirrors documents.sharing.test.ts's structure, plus the
 * sensitivity-tier gate on public links that properties/vehicles share with documents but lists/purchases
 * don't (propertyProfiles/vehicleProfiles both carry a `sensitivity` column — see packages/db/src/schema/
 * assets.ts).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

// This test exercises sharing/access control, not recall monitoring — RecallMonitorService/queue are
// stubbed no-ops the same way stubHouseholds above is, rather than pulling in real Redis/BullMQ or a real
// outbound NHTSA/CPSC call for a suite that never inspects recall results.
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubVinDecode = {} as unknown as VinDecodeService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;

describe("AssetsService property sharing", () => {
  let db: Database;
  let sharing: SharingService;
  let assets: AssetsService;
  let ownerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    assets = new AssetsService(db, stubHouseholds, sharing, stubRecallMonitor, stubVinDecode, stubQueue);
    try {
      ownerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `property-share-grantee-${granteeUserId}@example.com`;
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `property-share-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
        { id: strangerUserId, email: `property-share-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping property sharing tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, granteeUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("resource grant: a stranger is denied, the grantee gains access, revoking removes it, and it shows up in the grantee's listProperties()", async () => {
    if (!dbAvailable) return;
    const { id: propertyId } = await assets.createProperty(ownerUserId, { label: "Lake cabin", propertyType: "vacation" });

    // Unlike DocumentsService/CommerceService's *Detail methods, AssetsService.propertyDetail throws
    // (via assertAssetAccess) rather than returning null for an unauthorized caller — matching its
    // existing behavior, not something this sharing pass changed.
    await expect(assets.propertyDetail(propertyId, strangerUserId)).rejects.toThrow();
    await expect(assets.createPropertyGrant(propertyId, strangerUserId, granteeEmail)).rejects.toThrow(); // non-owner can't grant

    const { id: grantId } = await assets.createPropertyGrant(propertyId, ownerUserId, granteeEmail);

    const granteeDetail = await assets.propertyDetail(propertyId, granteeUserId);
    expect(granteeDetail?.property.id).toBe(propertyId);
    expect((await assets.listProperties(granteeUserId)).some((p) => p.id === propertyId)).toBe(true);

    await assets.revokeResourceGrant(grantId, ownerUserId);
    await expect(assets.propertyDetail(propertyId, granteeUserId)).rejects.toThrow();
    expect((await assets.listProperties(granteeUserId)).some((p) => p.id === propertyId)).toBe(false);

    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
  });

  it("share link: a highly_sensitive property is blocked from a public link (grants still work), and an ordinary property's link resolves to a redacted public view", async () => {
    if (!dbAvailable) return;
    const { id: sensitivePropertyId } = await assets.createProperty(ownerUserId, { label: "Vault house", propertyType: "home" });
    await db.update(schema.propertyProfiles).set({ sensitivity: "highly_sensitive" }).where(eq(schema.propertyProfiles.id, sensitivePropertyId));
    await expect(assets.createPropertyShareLink(sensitivePropertyId, ownerUserId, {})).rejects.toThrow();
    await expect(assets.createPropertyGrant(sensitivePropertyId, ownerUserId, granteeEmail)).resolves.toHaveProperty("id");

    const { id: propertyId } = await assets.createProperty(ownerUserId, { label: "Beach house", propertyType: "vacation", address: "1 Ocean Ave" });
    const { id: linkId, token } = await assets.createPropertyShareLink(propertyId, ownerUserId, {});

    const { resourceType, resourceId } = await sharing.resolveShareLink(token, undefined);
    expect(resourceType).toBe("property");
    const content = await assets.publicPropertyContent(resourceId);
    expect(content.label).toBe("Beach house");
    expect(content.address).toBe("1 Ocean Ave");

    await assets.revokeShareLink(linkId, ownerUserId);
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();

    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, sensitivePropertyId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
  });
});
