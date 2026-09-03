import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * §40.3 "Representative state machines" — Return: `eligible → initiated → label/dropoff ready → in
 * transit → merchant received → refund expected → refunded / exchanged / disputed / closed`. Before this
 * pass, `returnCases.state` only ever moved eligible → "resolved" (a single generic terminal outcome —
 * see CommerceService.resolveReturn's own doc comment, left unchanged for backward compatibility) and
 * nothing else ever transitioned it. This is real Postgres integration coverage progressing a return case
 * through the real named states to a real terminal outcome, plus the warranty-void and savings-aggregate
 * side effects that outcome should (and shouldn't) trigger.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService §40.3 Return state machine", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `return-lifecycle-${ownerUserId}@example.com`, displayName: "Return Lifecycle Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping Return state machine tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  async function makePurchaseWithReturn(): Promise<{ purchaseId: string; lineId: string; returnCaseId: string }> {
    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      orderNumber: `RETURN-LIFECYCLE-${purchaseId}`,
      purchaseDate,
      purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 8_000,
      totalCurrency: "USD",
      state: "fulfilled",
      confidenceBand: "high",
    });
    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({
      id: lineId,
      purchaseId,
      productLabel: "Return Lifecycle Test Widget",
      quantity: 1,
      unitPriceMinorUnits: 8_000,
      lineTotalMinorUnits: 8_000,
      currency: "USD",
    });
    const returnCaseId = generateId("returnCase");
    await db.insert(schema.returnCases).values({
      id: returnCaseId,
      purchaseId,
      purchaseLineId: lineId,
      state: "eligible",
      deadline: { precision: "date", instantUtc: null, date: "2026-09-15", timezone: null, sourceText: null },
      deadlineSort: new Date("2026-09-15T00:00:00Z"),
      valueAtStakeMinorUnits: 8_000,
      valueAtStakeCurrency: "USD",
    });
    return { purchaseId, lineId, returnCaseId };
  }

  it("progresses eligible -> initiated -> label_ready -> in_transit -> merchant_received -> refund_expected -> refunded, voiding the line's warranty and counting toward savings", async () => {
    if (!dbAvailable) return;
    const { lineId, returnCaseId } = await makePurchaseWithReturn();
    const warrantyId = generateId("warranty");
    await db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId,
      purchaseLineId: lineId,
      productLabel: "Return Lifecycle Test Widget",
      expirationDate: { precision: "date", instantUtc: null, date: "2028-08-01", timezone: null, sourceText: null },
      expirationDateSort: new Date("2028-08-01T00:00:00Z"),
    });

    await commerce.initiateReturn(returnCaseId, ownerUserId);
    let [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("initiated");

    await commerce.markReturnLabelReady(returnCaseId, ownerUserId, { carrier: "Test Carrier", trackingNumber: `RTN-${returnCaseId}` });
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("label_ready");
    const [shipment] = await db.select().from(schema.shipments).where(eq(schema.shipments.returnCaseId, returnCaseId));
    expect(shipment?.carrier).toBe("Test Carrier");
    expect(shipment?.status).toBe("label_created");

    // Carrier scan updates the linked shipment directly (mirrors IngestionService.extractShipment) — the
    // return case's own state is derived from it, not written to directly.
    await db.update(schema.shipments).set({ status: "in_transit", updatedAt: new Date() }).where(eq(schema.shipments.id, shipment!.id));
    await commerce.syncReturnShippingStateFromLinkedShipment(returnCaseId);
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("in_transit");

    await db.update(schema.shipments).set({ status: "delivered", updatedAt: new Date() }).where(eq(schema.shipments.id, shipment!.id));
    await commerce.syncReturnShippingStateFromLinkedShipment(returnCaseId);
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("merchant_received");

    await commerce.markReturnRefundExpected(returnCaseId, ownerUserId);
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("refund_expected");

    await commerce.closeReturn(returnCaseId, ownerUserId, "refunded");
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("refunded");

    const [warranty] = await db.select({ voidedAt: schema.warranties.voidedAt }).from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warranty?.voidedAt).not.toBeNull();

    const summary = await commerce.savingsSummary(ownerUserId);
    expect(summary.resolvedReturnsMinorUnits).toBeGreaterThanOrEqual(8_000);

    // Already closed — a second close attempt must be rejected, not silently re-applied.
    await expect(commerce.closeReturn(returnCaseId, ownerUserId, "exchanged")).rejects.toThrow();
  });

  it("closeReturn to disputed does NOT void the warranty and is excluded from the savings aggregate", async () => {
    if (!dbAvailable) return;
    const { lineId, returnCaseId } = await makePurchaseWithReturn();
    const warrantyId = generateId("warranty");
    await db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId,
      purchaseLineId: lineId,
      productLabel: "Disputed Warranty Widget",
      expirationDate: { precision: "date", instantUtc: null, date: "2028-08-01", timezone: null, sourceText: null },
      expirationDateSort: new Date("2028-08-01T00:00:00Z"),
    });

    const beforeSummary = await commerce.savingsSummary(ownerUserId);
    await commerce.closeReturn(returnCaseId, ownerUserId, "disputed");

    const [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("disputed");
    const [warranty] = await db.select({ voidedAt: schema.warranties.voidedAt }).from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warranty?.voidedAt).toBeNull();

    const afterSummary = await commerce.savingsSummary(ownerUserId);
    expect(afterSummary.resolvedReturnsMinorUnits).toBe(beforeSummary.resolvedReturnsMinorUnits);
  });

  it("initiateReturn rejects a return that isn't eligible, and markReturnRefundExpected rejects one with no shipping evidence yet", async () => {
    if (!dbAvailable) return;
    const { returnCaseId } = await makePurchaseWithReturn();
    await commerce.initiateReturn(returnCaseId, ownerUserId);
    await expect(commerce.initiateReturn(returnCaseId, ownerUserId)).rejects.toThrow();
    await expect(commerce.markReturnRefundExpected(returnCaseId, ownerUserId)).rejects.toThrow();
  });

  /**
   * Backend gap found live via QA: `initiateReturn` was the only return-lifecycle write that ever promoted
   * the PARENT PURCHASE to "return_started" via `recomputePurchaseOutcomeState` — the legacy `resolveReturn`
   * manual-completion path (still the automatic path PlaidAdapter.matchTransaction's refund-matching also
   * writes through) and the newer `closeReturn` terminal-fork both moved the return case's own state but
   * never called it, so a purchase whose return was resolved/closed without ever going through
   * `initiateReturn` first stayed at whatever state it was already in (e.g. "fulfilled") forever, even
   * though its return had genuinely completed. Fixed by calling `recomputePurchaseOutcomeState` from both
   * paths too, same as `initiateReturn` already does.
   */
  it("resolveReturn promotes the parent purchase to return_started, even when the return was never explicitly initiated first", async () => {
    if (!dbAvailable) return;
    const { purchaseId, returnCaseId } = await makePurchaseWithReturn();
    let [purchaseRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(purchaseRow?.state).toBe("fulfilled");

    await commerce.resolveReturn(returnCaseId, ownerUserId);

    [purchaseRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(purchaseRow?.state).toBe("return_started");
  });

  it("closeReturn promotes the parent purchase to return_started for every terminal outcome, not just refunded/exchanged", async () => {
    if (!dbAvailable) return;
    const { purchaseId, returnCaseId } = await makePurchaseWithReturn();

    await commerce.closeReturn(returnCaseId, ownerUserId, "disputed");

    const [purchaseRow] = await db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(purchaseRow?.state).toBe("return_started");
  });
});
