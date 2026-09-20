import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { FinanceService } from "./finance.service";
import type { AttentionService } from "../attention/attention.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * FIN-006 "Investments" — `FinanceService.holdings`.
 *
 * The sync side (Plaid's response -> rows) is proven in plaid.adapter.test.ts. What this file proves is
 * the reporting side, where the decisions that can be silently wrong live:
 *
 *   1. An EXCLUDED account's positions are still listed, but are not summed. "Excluded" is FIN-001's
 *      word for "not counted toward totals", not "hidden" — getting this backwards either fabricates a
 *      total the user asked not to see, or vanishes a real holding.
 *   2. Unrealized gain is withheld, not guessed, when cost basis is missing. Plaid omits cost basis for
 *      plenty of institutions, and treating an absent basis as zero reports the entire position as pure
 *      gain — a fabricated number presented with the same confidence as a real one.
 *   3. The same withholding applies to the per-currency total: one basis-less position makes the whole
 *      currency's basis unknowable, and a partial sum would understate what was paid.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubAttention = { fileIfNew: async () => {} } as unknown as AttentionService;

describe("FinanceService.holdings", () => {
  let db: Database;
  let finance: FinanceService;
  let ownerUserId: string;
  let includedAccountId: string;
  let excludedAccountId: string;
  let basislessSecurityId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    finance = new FinanceService(db, stubAttention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `finance-holdings-test-${ownerUserId}@example.com`,
        displayName: "Finance Holdings Test",
      });

      const connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "plaid",
        feasibilityClass: "aggregator",
        scopes: ["transactions", "liabilities", "investments"],
        enabledCategories: ["purchases", "bills"],
        health: "healthy",
      });

      includedAccountId = generateId("financialAccount");
      await db.insert(schema.financialAccounts).values({
        id: includedAccountId,
        connectionId,
        ownerUserId,
        plaidAccountId: `plaid-acct-${includedAccountId}`,
        name: "Brokerage",
        type: "investment",
        subtype: "brokerage",
        currency: "USD",
        isIncluded: true,
      });

      excludedAccountId = generateId("financialAccount");
      await db.insert(schema.financialAccounts).values({
        id: excludedAccountId,
        connectionId,
        ownerUserId,
        plaidAccountId: `plaid-acct-${excludedAccountId}`,
        name: "Joint Brokerage",
        type: "investment",
        subtype: "brokerage",
        currency: "USD",
        isIncluded: false,
      });

      // Three securities: two with a cost basis, one without.
      const equityId = generateId("security");
      const fundId = generateId("security");
      const basislessId = generateId("security");
      basislessSecurityId = basislessId;
      await db.insert(schema.securities).values([
        {
          id: equityId,
          ownerUserId,
          plaidSecurityId: `plaid-sec-${equityId}`,
          name: "Apple Inc.",
          tickerSymbol: "AAPL",
          type: "equity",
          closePrice: "187.660000",
          closePriceAsOf: "2026-09-19",
          currency: "USD",
          isCashEquivalent: false,
        },
        {
          id: fundId,
          ownerUserId,
          plaidSecurityId: `plaid-sec-${fundId}`,
          name: "Broad Market Index Fund",
          tickerSymbol: "BMIFX",
          type: "mutual fund",
          closePrice: "42.105000",
          closePriceAsOf: "2026-09-19",
          currency: "USD",
          isCashEquivalent: false,
        },
        {
          id: basislessId,
          ownerUserId,
          plaidSecurityId: `plaid-sec-${basislessId}`,
          name: "Employer Stock Plan",
          tickerSymbol: null,
          type: "equity",
          closePrice: null,
          closePriceAsOf: null,
          currency: "USD",
          isCashEquivalent: false,
        },
      ]);

      await db.insert(schema.investmentHoldings).values([
        // Included account, full data. The larger of the two included positions.
        {
          id: generateId("investmentHolding"),
          accountId: includedAccountId,
          ownerUserId,
          securityId: equityId,
          quantity: "12.34567890",
          institutionPrice: "187.655000",
          institutionPriceAsOf: "2026-09-19",
          institutionValueMinorUnits: 231_679,
          costBasisMinorUnits: 150_000,
          currency: "USD",
        },
        // Included account, full data, smaller.
        {
          id: generateId("investmentHolding"),
          accountId: includedAccountId,
          ownerUserId,
          securityId: fundId,
          quantity: "100.00000000",
          institutionPrice: "42.105000",
          institutionPriceAsOf: "2026-09-19",
          institutionValueMinorUnits: 421_05,
          costBasisMinorUnits: 400_00,
          currency: "USD",
        },
        // EXCLUDED account — listed but never summed. Deliberately the biggest number in the fixture, so
        // a totals bug that counted it would be impossible to miss.
        {
          id: generateId("investmentHolding"),
          accountId: excludedAccountId,
          ownerUserId,
          securityId: equityId,
          quantity: "500.00000000",
          institutionPrice: "187.655000",
          institutionPriceAsOf: "2026-09-19",
          institutionValueMinorUnits: 9_382_750,
          costBasisMinorUnits: 5_000_000,
          currency: "USD",
        },
      ]);
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "FinanceService.holdings tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("lists every holding with its security, largest position first", async () => {
    if (!dbAvailable) return;
    const { holdings } = await finance.holdings(ownerUserId);

    expect(holdings).toHaveLength(3);
    // Excluded account's 9,382,750 position is the largest and must still appear, at the top.
    expect(holdings[0]?.institutionValueMinorUnits).toBe(9_382_750);
    expect(holdings[0]?.isIncluded).toBe(false);
    expect(holdings[0]?.accountName).toBe("Joint Brokerage");
    expect(holdings[1]?.institutionValueMinorUnits).toBe(231_679);
    expect(holdings[2]?.institutionValueMinorUnits).toBe(42_105);

    // The security is joined, not just its id.
    expect(holdings[1]?.security.tickerSymbol).toBe("AAPL");
    expect(holdings[1]?.security.name).toBe("Apple Inc.");
    // Exact decimal survives the whole round trip, database through service.
    expect(holdings[1]?.quantity).toBe("12.34567890");
  });

  it("computes unrealized gain per holding from value minus cost basis", async () => {
    if (!dbAvailable) return;
    const { holdings } = await finance.holdings(ownerUserId, includedAccountId);

    const apple = holdings.find((h) => h.security.tickerSymbol === "AAPL");
    expect(apple?.unrealizedGainMinorUnits).toBe(231_679 - 150_000);
    const fund = holdings.find((h) => h.security.tickerSymbol === "BMIFX");
    expect(fund?.unrealizedGainMinorUnits).toBe(42_105 - 40_000);
  });

  it("narrows to a single account when accountId is supplied", async () => {
    if (!dbAvailable) return;
    const { holdings } = await finance.holdings(ownerUserId, includedAccountId);
    expect(holdings).toHaveLength(2);
    expect(holdings.every((h) => h.accountId === includedAccountId)).toBe(true);
  });

  it("sums only included accounts into the portfolio total", async () => {
    if (!dbAvailable) return;
    const { totalsByCurrency } = await finance.holdings(ownerUserId);

    expect(totalsByCurrency).toHaveLength(1);
    const usd = totalsByCurrency[0]!;
    expect(usd.currency).toBe("USD");
    // 231,679 + 42,105 — and emphatically NOT the excluded account's 9,382,750.
    expect(usd.totalMinorUnits).toBe(273_784);
    expect(usd.costBasisMinorUnits).toBe(190_000);
    expect(usd.unrealizedGainMinorUnits).toBe(83_784);
  });

  it("withholds gain rather than guessing it when a position has no cost basis", async () => {
    if (!dbAvailable) return;

    // Add a basis-less position to the INCLUDED account. Its value still counts toward the total (it is
    // really worth that), but the currency's cost basis becomes unknowable and must be reported as such.
    const holdingId = generateId("investmentHolding");
    await db.insert(schema.investmentHoldings).values({
      id: holdingId,
      accountId: includedAccountId,
      ownerUserId,
      securityId: basislessSecurityId,
      quantity: "10.00000000",
      institutionPrice: null,
      institutionPriceAsOf: null,
      institutionValueMinorUnits: 50_000,
      costBasisMinorUnits: null, // the case under test
      currency: "USD",
    });

    try {
      const { holdings, totalsByCurrency } = await finance.holdings(ownerUserId);

      const added = holdings.find((h) => h.id === holdingId);
      expect(added).toBeDefined();
      // Null, not 50,000 — an absent basis is not a basis of zero.
      expect(added?.unrealizedGainMinorUnits).toBeNull();

      const usd = totalsByCurrency.find((t) => t.currency === "USD")!;
      // Its value still counts: 273,784 + 50,000.
      expect(usd.totalMinorUnits).toBe(323_784);
      // But the currency's basis and gain are now withheld entirely, not partially summed.
      expect(usd.costBasisMinorUnits).toBeNull();
      expect(usd.unrealizedGainMinorUnits).toBeNull();
    } finally {
      await db.delete(schema.investmentHoldings).where(eq(schema.investmentHoldings.id, holdingId));
    }
  });
});
