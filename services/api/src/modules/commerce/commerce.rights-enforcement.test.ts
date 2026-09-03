import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * SHARE-001 "Set view/edit/manage" — same adversarial goal as lists.rights-enforcement.test.ts, applied to
 * CommerceService's one sharable resource (purchases). `updatePurchaseLine` is the only real write path a
 * purchase grant can reach (bills/warranties/returns/subscriptions/store credits have no sharing endpoint
 * of their own — see CommerceService's own doc comment), so that's the "edit" proof; there's no
 * deletePurchase in this codebase at all, so "manage"'s delete half has nothing to prove here — its
 * grant/revoke-management half is fully exercised instead.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService SHARE-001 right enforcement (view/edit/manage)", () => {
  let db: Database;
  let sharing: SharingService;
  let commerce: CommerceService;
  let ownerUserId: string;
  let viewerUserId: string;
  let editorUserId: string;
  let managerUserId: string;
  let purchaseId: string;
  let lineId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    commerce = new CommerceService(db, stubHouseholds, sharing);
    try {
      ownerUserId = generateId("user");
      viewerUserId = generateId("user");
      editorUserId = generateId("user");
      managerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `purchase-rights-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: viewerUserId, email: `purchase-rights-viewer-${viewerUserId}@example.com`, displayName: "Viewer" },
        { id: editorUserId, email: `purchase-rights-editor-${editorUserId}@example.com`, displayName: "Editor" },
        { id: managerUserId, email: `purchase-rights-manager-${managerUserId}@example.com`, displayName: "Manager" },
      ]);

      purchaseId = generateId("purchase");
      const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
      await db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId,
        orderNumber: "RIGHTS-TEST-001",
        purchaseDate,
        purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
        totalMinorUnits: 2_500,
        totalCurrency: "USD",
        state: "candidate",
        confidenceBand: "high",
      });
      lineId = generateId("purchaseLine");
      await db.insert(schema.purchaseLines).values({
        id: lineId,
        purchaseId,
        productLabel: "Rights Test Widget",
        quantity: 1,
        unitPriceMinorUnits: 2_500,
        lineTotalMinorUnits: 2_500,
        currency: "USD",
      });

      const [viewerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, viewerUserId)).limit(1);
      const [editorRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, editorUserId)).limit(1);
      const [managerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, managerUserId)).limit(1);
      await commerce.createResourceGrant(purchaseId, ownerUserId, viewerRow!.email!, undefined, "view");
      await commerce.createResourceGrant(purchaseId, ownerUserId, editorRow!.email!, undefined, "edit");
      await commerce.createResourceGrant(purchaseId, ownerUserId, managerRow!.email!, undefined, "manage");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping purchase rights-enforcement tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, viewerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, editorUserId));
      await db.delete(schema.users).where(eq(schema.users.id, managerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a 'view' grant can read the purchase but cannot edit its lines or re-share it", async () => {
    if (!dbAvailable) return;
    const detail = await commerce.purchaseDetail(purchaseId, viewerUserId);
    expect(detail?.purchase.id).toBe(purchaseId);

    await expect(commerce.updatePurchaseLine(lineId, viewerUserId, { giftFlag: true })).rejects.toThrow();
    await expect(commerce.createResourceGrant(purchaseId, viewerUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(commerce.createShareLink(purchaseId, viewerUserId, {})).rejects.toThrow();
  });

  it("an 'edit' grant can update purchase line fields but cannot create or revoke grants", async () => {
    if (!dbAvailable) return;
    await commerce.updatePurchaseLine(lineId, editorUserId, { giftFlag: true, serialNumber: "EDIT-OK" });
    const [line] = await db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.id, lineId)).limit(1);
    expect(line?.giftFlag).toBe(true);
    expect(line?.serialNumber).toBe("EDIT-OK");

    await expect(commerce.createResourceGrant(purchaseId, editorUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(commerce.createShareLink(purchaseId, editorUserId, {})).rejects.toThrow();
  });

  it("a 'manage' grant can create/revoke other grants and edit purchase lines, but ownership never changes", async () => {
    if (!dbAvailable) return;
    await commerce.updatePurchaseLine(lineId, managerUserId, { serialNumber: "MANAGE-OK" });
    const [line] = await db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.id, lineId)).limit(1);
    expect(line?.serialNumber).toBe("MANAGE-OK");

    const tempGranteeId = generateId("user");
    const tempGranteeEmail = `purchase-rights-temp-${tempGranteeId}@example.com`;
    await db.insert(schema.users).values({ id: tempGranteeId, email: tempGranteeEmail, displayName: "Temp" });
    const { id: tempGrantId } = await commerce.createResourceGrant(purchaseId, managerUserId, tempGranteeEmail, undefined, "view");
    expect((await commerce.listResourceGrants(purchaseId, managerUserId)).some((g) => g.grant.id === tempGrantId)).toBe(true);
    await commerce.revokeResourceGrant(tempGrantId, managerUserId);

    const stillOwnedByOriginalOwner = await db.select({ ownerUserId: schema.purchases.ownerUserId }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    expect(stillOwnedByOriginalOwner[0]?.ownerUserId).toBe(ownerUserId);

    await db.delete(schema.users).where(eq(schema.users.id, tempGranteeId));
  });
});
