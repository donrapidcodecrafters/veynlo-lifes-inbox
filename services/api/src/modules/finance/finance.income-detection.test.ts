import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { FinanceService } from "./finance.service";
import type { AttentionService } from "../attention/attention.service";

/**
 * FIN-003 "Model paycheck and recurring expenses as expected streams" — zero code existed for this before
 * (see FinanceService.detectIncomeStreams' own doc comment for the precision-first tolerances). Real DB
 * tests proving both a true positive (a genuine biweekly paycheck pattern gets surfaced) and the two
 * false-positive-avoidance cases that actually matter for a "never flag an outflow, never flag on too few
 * occurrences" precision-first stance.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubAttention = { fileIfNew: async () => {} } as unknown as AttentionService;

function isoDate(daysFromEpochAnchor: number): string {
  // Anchored to a fixed, arbitrary past date so the test is deterministic regardless of when it runs.
  const anchor = new Date("2026-01-01T00:00:00Z").getTime();
  return new Date(anchor + daysFromEpochAnchor * 86_400_000).toISOString().slice(0, 10);
}

describe("FinanceService.detectIncomeStreams", () => {
  let db: Database;
  let finance: FinanceService;
  let ownerUserId: string;
  let connectionId: string;
  let accountId: string;
  let dbAvailable = true;
  const txnIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    finance = new FinanceService(db, stubAttention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `finance-income-test-${ownerUserId}@example.com`, displayName: "Finance Income Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "plaid",
        feasibilityClass: "aggregator",
        scopes: ["transactions"],
        enabledCategories: ["purchases", "bills"],
        health: "healthy",
      });
      accountId = generateId("financialAccount");
      await db.insert(schema.financialAccounts).values({
        id: accountId,
        connectionId,
        ownerUserId,
        plaidAccountId: `plaid-acct-${accountId}`,
        name: "Direct Deposit Checking",
        type: "depository",
        currency: "USD",
      });

      const insertTxn = async (daysOffset: number, amountMinorUnits: number, name: string, merchantName: string | null) => {
        const id = generateId("financialTransaction");
        txnIds.push(id);
        await db.insert(schema.financialTransactions).values({
          id,
          accountId,
          ownerUserId,
          plaidTransactionId: `plaid-txn-${id}`,
          name,
          merchantName,
          amountMinorUnits,
          currency: "USD",
          pending: false,
          postedDate: isoDate(daysOffset),
        });
      };

      // True positive: 4 biweekly (14-day) paycheck deposits of ~$2,500 (Plaid convention: negative = money in).
      await insertTxn(0, -250_000, "ACME CORP PAYROLL", "Acme Corp");
      await insertTxn(14, -250_012, "ACME CORP PAYROLL", "Acme Corp"); // a few cents of variance, still within 5%
      await insertTxn(28, -249_500, "ACME CORP PAYROLL", "Acme Corp");
      await insertTxn(42, -250_300, "ACME CORP PAYROLL", "Acme Corp");

      // False-positive-avoidance #1: only 2 occurrences of an otherwise clean biweekly deposit — must not
      // be surfaced (INCOME_MIN_OCCURRENCES requires at least 3).
      await insertTxn(0, -80_000, "FREELANCE CLIENT ACH", "Freelance Client");
      await insertTxn(14, -80_000, "FREELANCE CLIENT ACH", "Freelance Client");

      // False-positive-avoidance #2: a genuinely regular biweekly OUTFLOW (e.g. a recurring transfer to
      // savings) — must never be classified as income no matter how regular its cadence is.
      await insertTxn(0, 20_000, "AUTO TRANSFER TO SAVINGS", "Internal Transfer");
      await insertTxn(14, 20_000, "AUTO TRANSFER TO SAVINGS", "Internal Transfer");
      await insertTxn(28, 20_000, "AUTO TRANSFER TO SAVINGS", "Internal Transfer");
      await insertTxn(42, 20_000, "AUTO TRANSFER TO SAVINGS", "Internal Transfer");

      // False-positive-avoidance #3: irregular gaps between deposits from the same "employer" name — a
      // real pattern (e.g. reimbursements) that must not be misread as a paycheck cadence.
      await insertTxn(0, -60_000, "IRREGULAR CLIENT PMT", "Irregular Client");
      await insertTxn(5, -60_000, "IRREGULAR CLIENT PMT", "Irregular Client");
      await insertTxn(40, -60_000, "IRREGULAR CLIENT PMT", "Irregular Client");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping FinanceService income-detection tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("detects a genuine biweekly paycheck stream but not the outflow, too-few-occurrence, or irregular-cadence candidates", async () => {
    if (!dbAvailable) return;
    const streams = await finance.detectIncomeStreams(ownerUserId);
    const descriptions = streams.map((s) => s.description);

    expect(descriptions).toContain("Acme Corp");
    const paycheck = streams.find((s) => s.description === "Acme Corp")!;
    expect(paycheck.cadence).toBe("biweekly");
    expect(paycheck.occurrenceCount).toBe(4);
    expect(paycheck.averageAmountMinorUnits).toBeGreaterThan(249_000);
    expect(paycheck.averageAmountMinorUnits).toBeLessThan(251_000);

    // Never the outflow, regardless of how regular it looks.
    expect(descriptions).not.toContain("Internal Transfer");
    // Never a stream with fewer than 3 occurrences.
    expect(descriptions).not.toContain("Freelance Client");
    // Never a stream whose gaps aren't consistent enough to look like a real schedule.
    expect(descriptions).not.toContain("Irregular Client");
  });

  it("stops resurfacing a stream once dismissed, even though the transactions are still there", async () => {
    if (!dbAvailable) return;
    const before = await finance.detectIncomeStreams(ownerUserId);
    const paycheck = before.find((s) => s.description === "Acme Corp");
    expect(paycheck).toBeDefined();

    await finance.dismissIncomeStream(paycheck!.id, ownerUserId);

    const after = await finance.detectIncomeStreams(ownerUserId);
    expect(after.map((s) => s.description)).not.toContain("Acme Corp");
  });
});
