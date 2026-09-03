import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002), generalized off documents onto purchases —
 * see SharingService's own doc comment. Mirrors documents.sharing.test.ts's structure: a stranger is
 * denied, a grant grants real access to purchaseDetail (and shows up in purchases()), revoking removes
 * it, and a share link's redemption content is the narrower publicShareContent view (no returns/
 * shipments/evidence — see that method's own doc comment on why).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService purchase sharing", () => {
  let db: Database;
  let sharing: SharingService;
  let commerce: CommerceService;
  let ownerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let strangerUserId: string;
  let purchaseId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    commerce = new CommerceService(db, stubHouseholds, sharing);
    try {
      ownerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `purchase-share-grantee-${granteeUserId}@example.com`;
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `purchase-share-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
        { id: strangerUserId, email: `purchase-share-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);

      purchaseId = generateId("purchase");
      const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
      await db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId,
        orderNumber: "SHARE-TEST-001",
        purchaseDate,
        purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
        totalMinorUnits: 5_000,
        totalCurrency: "USD",
        state: "candidate",
        confidenceBand: "high",
      });
      await db.insert(schema.purchaseLines).values({
        id: generateId("purchaseLine"),
        purchaseId,
        productLabel: "Share Test Widget",
        quantity: 1,
        unitPriceMinorUnits: 5_000,
        lineTotalMinorUnits: 5_000,
        currency: "USD",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping purchase sharing tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, granteeUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("resource grant: a stranger is denied, the grantee gains access, revoking removes it, and it shows up in the grantee's purchases()", async () => {
    if (!dbAvailable) return;
    expect(await commerce.purchaseDetail(purchaseId, strangerUserId)).toBeNull();
    await expect(commerce.createResourceGrant(purchaseId, strangerUserId, granteeEmail)).rejects.toThrow(); // non-owner can't grant

    const { id: grantId } = await commerce.createResourceGrant(purchaseId, ownerUserId, granteeEmail);

    const granteeDetail = await commerce.purchaseDetail(purchaseId, granteeUserId);
    expect(granteeDetail?.purchase.id).toBe(purchaseId);
    expect((await commerce.purchases(granteeUserId)).some((p) => p.id === purchaseId)).toBe(true);

    await commerce.revokeResourceGrant(grantId, ownerUserId);
    expect(await commerce.purchaseDetail(purchaseId, granteeUserId)).toBeNull();
    expect((await commerce.purchases(granteeUserId)).some((p) => p.id === purchaseId)).toBe(false);
  });

  it("share link: resolves to a redacted public view (no returns/shipments/evidence) and revoking invalidates the token", async () => {
    if (!dbAvailable) return;
    const { id: linkId, token } = await commerce.createShareLink(purchaseId, ownerUserId, {});

    const { resourceType, resourceId } = await sharing.resolveShareLink(token, undefined);
    expect(resourceType).toBe("purchase");
    const content = await commerce.publicShareContent(resourceId);
    expect(content.totalMinorUnits).toBe(5_000);
    expect(content.lines).toHaveLength(1);
    expect(content.lines[0]?.productLabel).toBe("Share Test Widget");

    await commerce.revokeShareLink(linkId, ownerUserId);
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();
  });
});
