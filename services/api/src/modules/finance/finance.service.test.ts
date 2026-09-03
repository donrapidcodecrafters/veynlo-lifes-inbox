import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { FinanceService } from "./finance.service";
import type { AttentionService } from "../attention/attention.service";

/**
 * FIN-001 spec-conformance fix — `financial_accounts.name` is an `encryptedText` column (AES-256-GCM,
 * random IV per row), so ordering by it at the SQL level sorts by random ciphertext, not the actual
 * account name — real DB test proving `FinanceService.accounts` returns rows in stable alphabetical
 * order by (decrypted) name regardless of insertion order.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
// None of the tests in this file exercise FIN-004's anomaly scan (that's finance.anomaly-detection.test.ts,
// which needs a real AttentionService to verify actual attention-item rows) — a stub is enough here.
const stubAttention = { fileIfNew: async () => {} } as unknown as AttentionService;

describe("FinanceService.accounts ordering", () => {
  let db: Database;
  let finance: FinanceService;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;
  const accountIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    finance = new FinanceService(db, stubAttention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `finance-svc-test-${ownerUserId}@example.com`, displayName: "Finance Svc Test" });

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

      // Inserted deliberately out of alphabetical order — if `accounts()` were sorting by ciphertext
      // this ordering (or any ordering) would be indistinguishable from correct; sorting by the
      // decrypted name is the only way to reliably land these back in "Checking, Savings, Zzz Credit".
      const names = ["Zzz Credit Card", "Checking", "Savings"];
      for (const name of names) {
        const id = generateId("financialAccount");
        accountIds.push(id);
        await db.insert(schema.financialAccounts).values({
          id,
          connectionId,
          ownerUserId,
          plaidAccountId: `plaid-acct-${id}`,
          name,
          type: "depository",
          currency: "USD",
        });
      }
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping FinanceService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("returns accounts sorted alphabetically by decrypted name, not insertion or ciphertext order", async () => {
    if (!dbAvailable) return;
    const accounts = await finance.accounts(ownerUserId);
    expect(accounts.map((a) => a.name)).toEqual(["Checking", "Savings", "Zzz Credit Card"]);
  });
});

/**
 * FIN-001 "account list allows per-account inclusion/exclusion ... disappear from summaries while staying
 * visible (dimmed) in the raw account list" — a real gap found via spec-conformance audit: no column, no
 * toggle endpoint, and no summary even existed to respect it. Proves both halves of that contract against
 * a real DB: excluding an account changes `summary()`'s totals but never removes it from `accounts()`.
 */
describe("FinanceService — FIN-001 per-account inclusion/exclusion", () => {
  let db: Database;
  let finance: FinanceService;
  let ownerUserId: string;
  let connectionId: string;
  let includedAccountId: string;
  let excludedAccountId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    finance = new FinanceService(db, stubAttention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `finance-incl-test-${ownerUserId}@example.com`, displayName: "Finance Inclusion Test" });
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
      includedAccountId = generateId("financialAccount");
      excludedAccountId = generateId("financialAccount");
      await db.insert(schema.financialAccounts).values([
        {
          id: includedAccountId,
          connectionId,
          ownerUserId,
          plaidAccountId: `plaid-acct-${includedAccountId}`,
          name: "Personal Checking",
          type: "depository",
          currency: "USD",
          currentBalanceMinorUnits: 10_000,
        },
        {
          id: excludedAccountId,
          connectionId,
          ownerUserId,
          plaidAccountId: `plaid-acct-${excludedAccountId}`,
          name: "Joint Savings",
          type: "depository",
          currency: "USD",
          currentBalanceMinorUnits: 50_000,
        },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping FinanceService inclusion tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("defaults every account to included, and both accounts sum into the summary", async () => {
    if (!dbAvailable) return;
    const accounts = await finance.accounts(ownerUserId);
    expect(accounts.every((a) => a.isIncluded)).toBe(true);
    const summary = await finance.summary(ownerUserId);
    expect(summary.includedAccountCount).toBe(2);
    expect(summary.excludedAccountCount).toBe(0);
    expect(summary.totalsByCurrency).toEqual([{ currency: "USD", totalMinorUnits: 60_000 }]);
  });

  it("excluding an account removes it from the summary total but keeps it in the raw account list", async () => {
    if (!dbAvailable) return;
    const updated = await finance.setAccountIncluded(excludedAccountId, ownerUserId, false);
    expect(updated.isIncluded).toBe(false);

    // Still visible in the raw list — spec: "stay visible (dimmed/labeled excluded), so they can re-include it".
    const accounts = await finance.accounts(ownerUserId);
    expect(accounts.map((a) => a.id).sort()).toEqual([excludedAccountId, includedAccountId].sort());
    const excludedRow = accounts.find((a) => a.id === excludedAccountId);
    expect(excludedRow?.isIncluded).toBe(false);

    // But gone from the summed total.
    const summary = await finance.summary(ownerUserId);
    expect(summary.includedAccountCount).toBe(1);
    expect(summary.excludedAccountCount).toBe(1);
    expect(summary.totalsByCurrency).toEqual([{ currency: "USD", totalMinorUnits: 10_000 }]);

    // Re-including brings it back into the total — a user can undo an accidental exclusion.
    await finance.setAccountIncluded(excludedAccountId, ownerUserId, true);
    const restoredSummary = await finance.summary(ownerUserId);
    expect(restoredSummary.totalsByCurrency).toEqual([{ currency: "USD", totalMinorUnits: 60_000 }]);
  });
});
