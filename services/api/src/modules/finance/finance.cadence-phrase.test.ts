import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { FinanceService, INCOME_CADENCES } from "./finance.service";
import type { AttentionService } from "../attention/attention.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * FIN-003 — how a detected income stream's cadence reaches the screen.
 *
 * Found by eye, on a device, next to an unrelated feature: the Connections screen read
 *
 *     ~$3,142.88 every semi_monthly from Northwind LLC
 *
 * Three separate faults stacked to produce that one line:
 *
 *   1. The seed wrote "semi_monthly" and "irregular", neither of which `classifyCadence` can produce.
 *   2. The label lookup fell back to `?? r.cadence`, so an unmapped value went to screen verbatim —
 *      a raw database enum, underscore and all.
 *   3. Even a correctly mapped "semimonthly" gave the noun "twice a month", which the clients wrapped
 *      in "every {label}" to produce "every twice a month".
 *
 * So this file checks the two things that actually matter: every cadence the app can detect renders as a
 * grammatical phrase, and a value from outside the vocabulary never reaches a user as an enum.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubAttention = { fileIfNew: async () => {} } as unknown as AttentionService;

describe("detected income stream cadence phrasing", () => {
  let db: Database;
  let finance: FinanceService;
  let ownerUserId: string;
  let accountId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    finance = new FinanceService(db, stubAttention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `finance-cadence-test-${ownerUserId}@example.com`,
        displayName: "Finance Cadence Test",
      });

      const connectionId = generateId("connection");
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
        name: "Everyday Checking",
        type: "depository",
        currency: "USD",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "cadence phrasing tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  /** Insert a stream row directly — this is about how a STORED cadence renders, not about detection. */
  async function streamWithCadence(cadence: string) {
    const id = generateId("detectedIncomeStream");
    await db.insert(schema.detectedIncomeStreams).values({
      id,
      ownerUserId,
      accountId,
      streamKey: `key-${id}`,
      description: "Northwind LLC",
      cadence,
      averageAmountMinorUnits: 314_288,
      currency: "USD",
      occurrenceCount: 14,
      lastOccurrenceDate: "2026-09-15",
    });
    const streams = await finance.detectIncomeStreams(ownerUserId);
    const row = streams.find((s) => s.id === id);
    await db.delete(schema.detectedIncomeStreams).where(eq(schema.detectedIncomeStreams.id, id));
    return row;
  }

  it("renders every detectable cadence as a phrase that reads correctly in the sentence", async () => {
    if (!dbAvailable) return;

    const expected: Record<string, string> = {
      weekly: "every week",
      biweekly: "every 2 weeks",
      semimonthly: "twice a month",
      monthly: "every month",
    };

    for (const cadence of INCOME_CADENCES) {
      const row = await streamWithCadence(cadence);
      expect(row, `no stream came back for cadence "${cadence}"`).toBeDefined();
      expect(row?.cadenceLabel, `cadence "${cadence}" phrased wrong`).toBe(expected[cadence]);

      // The sentence the clients actually build. "~$3,142.88 every twice a month from Northwind LLC"
      // is the defect that started this; the phrase has to survive being dropped straight in.
      const sentence = `~$3,142.88 ${row!.cadenceLabel} from ${row!.description}`;
      expect(sentence).not.toMatch(/every twice/);
      expect(sentence).not.toMatch(/_/);
    }
  });

  it("every cadence in the vocabulary has a phrase — none falls through to the raw value", async () => {
    if (!dbAvailable) return;
    for (const cadence of INCOME_CADENCES) {
      const row = await streamWithCadence(cadence);
      // Falling through would return the bare enum, which is exactly what shipped.
      expect(row?.cadenceLabel, `"${cadence}" fell through to its raw value`).not.toBe(cadence);
    }
  });

  it("never puts a raw enum on screen for a value from outside the vocabulary", async () => {
    if (!dbAvailable) return;

    // The literal value the seed used to write, and what a row predating the vocabulary still holds.
    const row = await streamWithCadence("semi_monthly");
    expect(row).toBeDefined();
    expect(row?.cadenceLabel).toBe("semi monthly");
    expect(row?.cadenceLabel).not.toContain("_");
  });
});
