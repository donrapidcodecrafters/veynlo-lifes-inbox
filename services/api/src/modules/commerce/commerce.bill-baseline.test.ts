import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { categorizeBiller } from "./biller-category";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

/**
 * UTIL-001 "Shows current bill vs prior/seasonal baseline" — CommerceService.billBaselineComparison
 * (embedded in billDetail's own response as `baselineComparison`). Proves: fewer than 2 prior bills from
 * the same biller yields no baseline at all (not a meaningless "average of one/zero"); a bill running more
 * than 25% above the average of its biller's last (up to 12) bills is flagged
 * `isSignificantlyAboveBaseline`; an ordinary bill within that threshold is not; a bill from a genuinely
 * different biller never gets pulled into the average (no cross-biller contamination); and access control
 * still applies (a stranger can't read another owner's baseline).
 */
describe("CommerceService.billBaselineComparison — UTIL-001", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;
  const dueDate = { precision: "date" as const, instantUtc: null, date: "2026-06-01", timezone: null, sourceText: null };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `bill-baseline-${ownerUserId}@example.com`, displayName: "Bill Baseline Test User" });
      otherUserId = generateId("user");
      await db.insert(schema.users).values({ id: otherUserId, email: `bill-baseline-other-${otherUserId}@example.com`, displayName: "Bill Baseline Other User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CommerceService bill-baseline tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, otherUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  async function makeBill(owner: string, billerLabel: string, amountDueMinorUnits: number, monthOffset: number, extra: Partial<typeof schema.bills.$inferInsert> = {}): Promise<string> {
    const id = generateId("bill");
    const month = 1 + monthOffset;
    const isoMonth = String(month).padStart(2, "0");
    await db.insert(schema.bills).values({
      id,
      ownerUserId: owner,
      billerLabel,
      amountDueMinorUnits,
      amountDueCurrency: "USD",
      dueDate,
      dueDateSort: new Date(`2026-${isoMonth}-01T00:00:00Z`),
      ...extra,
    });
    return id;
  }

  it("returns no baseline when fewer than 2 prior bills exist from the same biller", async () => {
    if (!dbAvailable) return;
    const billId = await makeBill(ownerUserId, "City Electric Co", 10_000, 5);
    const result = await commerce.billBaselineComparison(billId, ownerUserId);
    expect(result).toBeNull();

    // With exactly one prior bill, still not enough for a baseline.
    await makeBill(ownerUserId, "City Electric Co", 9_000, 4);
    const stillNull = await commerce.billBaselineComparison(billId, ownerUserId);
    expect(stillNull).toBeNull();
  });

  it("flags a bill running >25% above the average of its biller's prior bills, and is not fooled by a different biller's bills", async () => {
    if (!dbAvailable) return;
    // Three prior bills from "Metro Gas Utility" averaging $100.00 (10000 minor units).
    await makeBill(ownerUserId, "Metro Gas Utility", 9_500, 1);
    await makeBill(ownerUserId, "Metro Gas Utility", 10_000, 2);
    await makeBill(ownerUserId, "Metro Gas Utility", 10_500, 3);
    // A same-owner bill from a totally different biller must never be pulled into the average.
    await makeBill(ownerUserId, "Netflix", 1_599, 3);

    // Current bill: $150.00 — 50% above the $100.00 average, well past the 25% threshold.
    const highBillId = await makeBill(ownerUserId, "Metro Gas Utility", 15_000, 4);
    const highResult = await commerce.billBaselineComparison(highBillId, ownerUserId);
    expect(highResult).not.toBeNull();
    expect(highResult!.sampleSize).toBe(3);
    expect(highResult!.averageMinorUnits).toBe(10_000);
    expect(highResult!.diffMinorUnits).toBe(5_000);
    expect(highResult!.isSignificantlyAboveBaseline).toBe(true);
    expect(highResult!.isBelowBaseline).toBe(false);

    // An ordinary bill close to the average (within the 25% threshold) is not flagged.
    const ordinaryBillId = await makeBill(ownerUserId, "Metro Gas Utility", 10_800, 5);
    const ordinaryResult = await commerce.billBaselineComparison(ordinaryBillId, ownerUserId);
    expect(ordinaryResult).not.toBeNull();
    expect(ordinaryResult!.isSignificantlyAboveBaseline).toBe(false);

    // A bill below its biller's average is flagged as such, not as "above baseline".
    const lowBillId = await makeBill(ownerUserId, "Metro Gas Utility", 5_000, 6);
    const lowResult = await commerce.billBaselineComparison(lowBillId, ownerUserId);
    expect(lowResult).not.toBeNull();
    expect(lowResult!.isBelowBaseline).toBe(true);
    expect(lowResult!.isSignificantlyAboveBaseline).toBe(false);
  });

  it("billDetail embeds the same baselineComparison, and denies a non-owner/non-household caller", async () => {
    if (!dbAvailable) return;
    await makeBill(ownerUserId, "Acme Water District", 4_000, 1);
    await makeBill(ownerUserId, "Acme Water District", 4_200, 2);
    const billId = await makeBill(ownerUserId, "Acme Water District", 8_000, 3);

    const detail = await commerce.billDetail(billId, ownerUserId);
    expect(detail).not.toBeNull();
    expect(detail!.baselineComparison).not.toBeNull();
    expect(detail!.baselineComparison!.isSignificantlyAboveBaseline).toBe(true);

    const deniedComparison = await commerce.billBaselineComparison(billId, otherUserId);
    expect(deniedComparison).toBeNull();
    const deniedDetail = await commerce.billDetail(billId, otherUserId);
    expect(deniedDetail).toBeNull();
  });

  it("categorizeBiller recognizes common utility biller names and leaves an unrecognized name uncategorized (no network/DB needed)", () => {
    expect(categorizeBiller("Pacific Electric Power Co")).toBe("electric");
    expect(categorizeBiller("Metro Gas Utility")).toBe("gas");
    expect(categorizeBiller("City Water Department")).toBe("water");
    expect(categorizeBiller("Waste Management")).toBe("trash");
    expect(categorizeBiller("Comcast Xfinity")).toBe("internet");
    expect(categorizeBiller("Verizon Wireless")).toBe("mobile");
    expect(categorizeBiller("ADT Security Services")).toBe("security");
    expect(categorizeBiller("Joe's Handyman Service")).toBeNull();
    expect(categorizeBiller(null)).toBeNull();
  });

  it("categorizeBiller's result is what extractBill would persist as billerCategory", async () => {
    if (!dbAvailable) return;
    const billId = await makeBill(ownerUserId, "Pacific Electric Power Co", 8_000, 1, { billerCategory: categorizeBiller("Pacific Electric Power Co") });
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.id, billId));
    expect(bill?.billerCategory).toBe("electric");
  });
});
