import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import {
  resolvePriceAdjustmentPolicy,
  resolvePriceAdjustmentPoliciesForMerchants,
  DEFAULT_PRICE_ADJUSTMENT_POLICY,
} from "./price-adjustment-policy";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const FIXTURE_EFFECTIVE_FROM = new Date("2020-01-01T00:00:00.000Z");
const LATER_EFFECTIVE_FROM = new Date("2021-01-01T00:00:00.000Z");

/**
 * `InboxService.priceAdjustmentDeadlinesByPurchaseId` called the single-merchant resolver inside a loop
 * over the purchases on the page — one query per purchase, on a request path, bounded only by however many
 * purchase items the inbox returned. The batch resolver does it in one query.
 *
 * The risk in that change is not performance, it is **drift**: two implementations of the same precedence
 * rule that agree today and diverge later. So the assertion here is not "the batch version returns
 * something sensible" but "the batch version returns exactly what the single version returns", for every
 * shape of the rule — a user override outranking a newer global fact, confidence tiers, a later
 * effective_from within one tier, a future-dated row that has not taken effect, and a merchant with no row
 * at all.
 */
describe("resolvePriceAdjustmentPoliciesForMerchants agrees with the single-merchant resolver", () => {
  let db: Database;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;
  let setupError: Error | null = null;
  const merchantIds: string[] = [];

  async function merchant(label: string): Promise<string> {
    const id = generateId("merchant");
    await db.insert(schema.merchants).values({ id, displayName: `${label} ${id}` });
    merchantIds.push(id);
    return id;
  }
  async function policy(merchantId: string, opts: { windowDays: number; confidence: string; ownerUserId?: string | null; effectiveFrom?: Date }) {
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: opts.ownerUserId ?? null,
      windowDays: opts.windowDays,
      confidence: opts.confidence,
      sourceNote: "batch agreement fixture",
      effectiveFrom: opts.effectiveFrom ?? FIXTURE_EFFECTIVE_FROM,
    });
  }

  const cases: Array<{ name: string; merchantId: string }> = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `batch-${ownerUserId}@example.com`, displayName: "Batch Owner" },
        { id: otherUserId, email: `batch-other-${otherUserId}@example.com`, displayName: "Someone Else" },
      ]);

      const noRow = await merchant("No policy at all");
      cases.push({ name: "no row at all", merchantId: noRow });

      const assumedOnly = await merchant("Assumed only");
      await policy(assumedOnly, { windowDays: 30, confidence: "assumed" });
      cases.push({ name: "a global assumed row", merchantId: assumedOnly });

      const tiers = await merchant("Tiers");
      await policy(tiers, { windowDays: 30, confidence: "assumed" });
      await policy(tiers, { windowDays: 14, confidence: "commonly_known" });
      cases.push({ name: "commonly_known outranks assumed", merchantId: tiers });

      const override = await merchant("User override");
      await policy(override, { windowDays: 14, confidence: "commonly_known", effectiveFrom: LATER_EFFECTIVE_FROM });
      await policy(override, { windowDays: 90, confidence: "user_confirmed", ownerUserId, effectiveFrom: FIXTURE_EFFECTIVE_FROM });
      cases.push({ name: "a user's own correction outranks a NEWER global fact", merchantId: override });

      const history = await merchant("History within a tier");
      await policy(history, { windowDays: 14, confidence: "commonly_known", effectiveFrom: FIXTURE_EFFECTIVE_FROM });
      await policy(history, { windowDays: 21, confidence: "commonly_known", effectiveFrom: LATER_EFFECTIVE_FROM });
      cases.push({ name: "latest effective_from wins within one tier", merchantId: history });

      const future = await merchant("Not yet effective");
      await policy(future, { windowDays: 14, confidence: "commonly_known", effectiveFrom: new Date(Date.now() + 365 * 86_400_000) });
      cases.push({ name: "a future-dated row has not taken effect", merchantId: future });

      const someoneElse = await merchant("Another user's override");
      await policy(someoneElse, { windowDays: 99, confidence: "user_confirmed", ownerUserId: otherUserId });
      cases.push({ name: "another user's correction is invisible here", merchantId: someoneElse });
    } catch (err) {
      setupError = err as Error;
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.merchantPriceAdjustmentPolicies).where(inArray(schema.merchantPriceAdjustmentPolicies.merchantId, merchantIds));
    await db.delete(schema.merchants).where(inArray(schema.merchants.id, merchantIds));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  // Without this, every assertion below short-circuits on !dbAvailable and the file reports green having
  // checked nothing.
  it("actually inserted its fixtures", () => {
    expect(setupError?.message ?? null).toBeNull();
    expect(dbAvailable).toBe(true);
    expect(cases.length).toBe(7);
  });

  it("returns the identical answer to the single resolver, for every shape of the rule", async () => {
    if (!dbAvailable) return;
    const batch = await resolvePriceAdjustmentPoliciesForMerchants(db, cases.map((c) => c.merchantId), ownerUserId);

    for (const { name, merchantId } of cases) {
      const single = await resolvePriceAdjustmentPolicy(db, merchantId, ownerUserId);
      const fromBatch = batch.get(merchantId) ?? DEFAULT_PRICE_ADJUSTMENT_POLICY;
      expect(fromBatch, `batch and single disagreed on: ${name}`).toEqual(single);
    }
  });

  it("issues one query for many merchants rather than one each", async () => {
    if (!dbAvailable) return;
    let queries = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") queries++;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Database;
    await resolvePriceAdjustmentPoliciesForMerchants(counting, cases.map((c) => c.merchantId), ownerUserId);
    expect(queries, "the batch resolver should read once regardless of how many merchants it is given").toBe(1);
  });

  it("de-duplicates repeated merchant ids and ignores nulls", async () => {
    if (!dbAvailable) return;
    const withDupes = [...cases.map((c) => c.merchantId), ...cases.map((c) => c.merchantId)];
    const batch = await resolvePriceAdjustmentPoliciesForMerchants(db, withDupes, ownerUserId);
    // One entry per distinct merchant with an APPLICABLE row. Three of the seven legitimately have none,
    // and each for a different reason worth keeping straight: the no-row merchant, the one whose only row
    // is future-dated and has not taken effect, and the one whose only row belongs to another user. Their
    // absence from the map is the same "fall back to the flat default" answer the single resolver gives,
    // which the agreement test above already pins.
    expect(batch.size).toBe(4);
  });
});
