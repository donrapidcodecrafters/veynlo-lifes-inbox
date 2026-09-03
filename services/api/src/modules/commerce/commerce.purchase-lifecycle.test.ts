import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * §40.3 "Representative state machines" — Purchase: `candidate → confirmed → fulfilled/partially
 * fulfilled → kept / return started / gifted / sold / disposed`. Before this pass, `purchases.state` was
 * written once as "candidate" at creation and NEVER transitioned anywhere else in the codebase (confirmed
 * by grepping every write to it) — every purchase sat at "candidate" forever regardless of what actually
 * happened to it. This is real Postgres integration coverage for the meaningful transitions:
 * confirm-by-confidence, fulfill-on-delivery, settle-to-kept, and the order-level gift/sold/return-started
 * outcomes CommerceService.recomputePurchaseOutcomeState derives from line-item evidence.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService §40.3 Purchase state machine", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `purchase-lifecycle-${ownerUserId}@example.com`, displayName: "Purchase Lifecycle Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping Purchase state machine tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  async function makePurchase(state: string, confidenceBand: string, opts?: { purchaseDateSort?: Date }) {
    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      orderNumber: `LIFECYCLE-${purchaseId}`,
      purchaseDate,
      purchaseDateSort: opts?.purchaseDateSort ?? new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 5_000,
      totalCurrency: "USD",
      state,
      confidenceBand,
    });
    return purchaseId;
  }

  async function makeLine(purchaseId: string, overrides?: Partial<typeof schema.purchaseLines.$inferInsert>) {
    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({
      id: lineId,
      purchaseId,
      productLabel: "Lifecycle Test Widget",
      quantity: 1,
      unitPriceMinorUnits: 5_000,
      lineTotalMinorUnits: 5_000,
      currency: "USD",
      ...overrides,
    });
    return lineId;
  }

  it("scanAndAdvancePurchaseLifecycle confirms a high-confidence candidate but leaves a needs_review one alone", async () => {
    if (!dbAvailable) return;
    const highConfidence = await makePurchase("candidate", "high");
    const needsReview = await makePurchase("candidate", "needs_review");

    const result = await commerce.scanAndAdvancePurchaseLifecycle();
    expect(result.confirmed).toBeGreaterThanOrEqual(1);

    const [confirmedRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, highConfidence));
    expect(confirmedRow?.state).toBe("confirmed");
    const [stillCandidateRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, needsReview));
    expect(stillCandidateRow?.state).toBe("candidate");
  });

  it("scanAndAdvancePurchaseLifecycle moves a purchase to fulfilled once its shipment is delivered, even from a low-confidence candidate", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("candidate", "needs_review");
    // A still-open return case (deadline far in the future) so this purchase doesn't also settle straight
    // to "kept" within the same scan call — isolates the fulfilled transition for this assertion.
    await db.insert(schema.returnCases).values({
      id: generateId("returnCase"),
      purchaseId,
      state: "eligible",
      deadline: { precision: "date", instantUtc: null, date: "2026-12-01", timezone: null, sourceText: null },
      deadlineSort: new Date("2026-12-01T00:00:00Z"),
      valueAtStakeMinorUnits: 5_000,
      valueAtStakeCurrency: "USD",
    });
    await db.insert(schema.shipments).values({
      id: generateId("shipment"),
      ownerUserId,
      purchaseId,
      carrier: "Test Carrier",
      trackingNumber: `TRACK-${purchaseId}`,
      status: "delivered",
      isGiftPrivate: false,
    });

    const result = await commerce.scanAndAdvancePurchaseLifecycle();
    expect(result.fulfilled).toBeGreaterThanOrEqual(1);
    const [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("fulfilled");
  });

  it("scanAndAdvancePurchaseLifecycle settles a fulfilled purchase with no return case straight to kept", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("fulfilled", "high");
    const result = await commerce.scanAndAdvancePurchaseLifecycle();
    expect(result.kept).toBeGreaterThanOrEqual(1);
    const [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("kept");
  });

  it("scanAndAdvancePurchaseLifecycle does NOT settle a fulfilled purchase to kept while its return window is still open", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("fulfilled", "high");
    await db.insert(schema.returnCases).values({
      id: generateId("returnCase"),
      purchaseId,
      state: "eligible",
      deadline: { precision: "date", instantUtc: null, date: "2026-12-01", timezone: null, sourceText: null },
      deadlineSort: new Date("2026-12-01T00:00:00Z"),
      valueAtStakeMinorUnits: 5_000,
      valueAtStakeCurrency: "USD",
    });
    await commerce.scanAndAdvancePurchaseLifecycle(new Date("2026-08-15T00:00:00Z"));
    const [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("fulfilled");
  });

  it("initiateReturn moves the return case to initiated and promotes the parent purchase to return_started", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("fulfilled", "high");
    const returnCaseId = generateId("returnCase");
    await db.insert(schema.returnCases).values({
      id: returnCaseId,
      purchaseId,
      state: "eligible",
      deadline: { precision: "date", instantUtc: null, date: "2026-09-01", timezone: null, sourceText: null },
      deadlineSort: new Date("2026-09-01T00:00:00Z"),
      valueAtStakeMinorUnits: 5_000,
      valueAtStakeCurrency: "USD",
    });

    await commerce.initiateReturn(returnCaseId, ownerUserId);

    const [returnRow] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(returnRow?.state).toBe("initiated");
    const [purchaseRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(purchaseRow?.state).toBe("return_started");
  });

  it("updatePurchaseLine promotes the order to gifted only once every line is gift-flagged, never for a mixed order", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("fulfilled", "high");
    const line1 = await makeLine(purchaseId);
    const line2 = await makeLine(purchaseId);

    await commerce.updatePurchaseLine(line1, ownerUserId, { giftFlag: true });
    let [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("fulfilled"); // mixed — one line gifted, one not — must NOT be called "gifted" yet

    await commerce.updatePurchaseLine(line2, ownerUserId, { giftFlag: true });
    [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("gifted");
  });

  it("updatePurchaseLine promotes a single-line order to sold once its resaleStatus is sold", async () => {
    if (!dbAvailable) return;
    const purchaseId = await makePurchase("confirmed", "high");
    const lineId = await makeLine(purchaseId);

    await commerce.updatePurchaseLine(lineId, ownerUserId, { resaleStatus: "sold" });
    const [row] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(row?.state).toBe("sold");
  });

  it("markPurchaseDisposed sets the manual-only disposed terminal state, and confirmPurchase advances a candidate regardless of confidence band", async () => {
    if (!dbAvailable) return;
    const disposedId = await makePurchase("fulfilled", "high");
    await commerce.markPurchaseDisposed(disposedId, ownerUserId);
    const [disposedRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, disposedId));
    expect(disposedRow?.state).toBe("disposed");

    const candidateId = await makePurchase("candidate", "needs_review");
    await commerce.confirmPurchase(candidateId, ownerUserId);
    const [confirmedRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, candidateId));
    expect(confirmedRow?.state).toBe("confirmed");
  });
});
