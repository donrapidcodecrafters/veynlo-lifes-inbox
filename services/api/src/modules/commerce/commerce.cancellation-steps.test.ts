import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { resolveMerchantCancellationSteps } from "./merchant-cancellation-steps";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * SUB-004 "Cancellation assistant ... shows known steps/link/evidence" — real-DB proof of the three cases
 * this feature is built around, mirroring RET-004's own price-adjustment-policy test file exactly: (1) a
 * curated seeded merchant resolves to its steps, (2) a merchant with nothing curated resolves to null (the
 * subscription-detail UI's honest "not found" fallback), (3) a user's own correction outranks a seeded
 * global fact, for that user only.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("SUB-004 merchant cancellation-steps resolution and subscription-detail display", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `cancel-steps-${ownerUserId}@example.com`, displayName: "Cancellation Steps Test Owner" },
        { id: otherUserId, email: `cancel-steps-${otherUserId}@example.com`, displayName: "Cancellation Steps Test Other User" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping SUB-004 cancellation-steps tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  it("a merchant with curated seeded steps resolves those steps, source 'seeded'", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Cancellation Steps Test — Seeded Merchant" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Log into your account", "Go to Settings > Subscription", "Click Cancel Plan"],
      sourceNote: "Test fixture.",
    });

    const resolved = await resolveMerchantCancellationSteps(db, merchantId, ownerUserId);
    expect(resolved).not.toBeNull();
    expect(resolved?.steps).toEqual(["Log into your account", "Go to Settings > Subscription", "Click Cancel Plan"]);
    expect(resolved?.source).toBe("seeded");
    expect(resolved?.stepsId).not.toBeNull();
  });

  it("a merchant with nothing curated resolves to null — the honest 'not found' fallback, not an error", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Cancellation Steps Test — Nothing Curated" });

    const resolved = await resolveMerchantCancellationSteps(db, merchantId, ownerUserId);
    expect(resolved).toBeNull();

    // Also true when no merchant id is known at all (e.g. a subscription with no merchant resolved).
    const resolvedNullMerchant = await resolveMerchantCancellationSteps(db, null, ownerUserId);
    expect(resolvedNullMerchant).toBeNull();
  });

  it("a user's own correction overrides a seeded global fact, for that user only, via CommerceService.setMerchantCancellationSteps", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Cancellation Steps Test — Seeded Then Corrected" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Old seeded step one", "Old seeded step two"],
      sourceNote: "Original seeded guess.",
    });

    // Before any correction, both users see the seeded steps.
    const beforeOwner = await resolveMerchantCancellationSteps(db, merchantId, ownerUserId);
    expect(beforeOwner?.source).toBe("seeded");
    expect(beforeOwner?.steps).toEqual(["Old seeded step one", "Old seeded step two"]);

    // The owner corrects it via the same path the subscription-detail cancellation-steps editor uses.
    await commerce.setMerchantCancellationSteps(merchantId, ownerUserId, {
      steps: ["Call support directly", "Ask them to cancel your plan"],
      sourceNote: "I actually called and this is what worked.",
    });

    const afterOwner = await resolveMerchantCancellationSteps(db, merchantId, ownerUserId);
    expect(afterOwner?.source).toBe("user");
    expect(afterOwner?.steps).toEqual(["Call support directly", "Ask them to cancel your plan"]);
    expect(afterOwner?.sourceNote).toBe("I actually called and this is what worked.");

    // A DIFFERENT user still sees the original seeded steps — a personal correction is never a global
    // overwrite (see merchant_cancellation_steps' own doc comment).
    const otherUserView = await resolveMerchantCancellationSteps(db, merchantId, otherUserId);
    expect(otherUserView?.source).toBe("seeded");
    expect(otherUserView?.steps).toEqual(["Old seeded step one", "Old seeded step two"]);

    // CommerceService's own read endpoint reflects the same per-caller resolution.
    const viaService = await commerce.merchantCancellationSteps(merchantId, ownerUserId);
    expect(viaService?.source).toBe("user");
    expect(viaService?.steps).toEqual(["Call support directly", "Ask them to cancel your plan"]);

    // Saving again for the SAME user updates the existing correction in place rather than creating a
    // second row (upsert semantics — see setUserMerchantCancellationSteps's own doc comment).
    await commerce.setMerchantCancellationSteps(merchantId, ownerUserId, { steps: ["Updated single step"] });
    const afterSecondSave = await resolveMerchantCancellationSteps(db, merchantId, ownerUserId);
    expect(afterSecondSave?.steps).toEqual(["Updated single step"]);
    expect(afterSecondSave?.stepsId).toBe(afterOwner?.stepsId);
  });

  it("setMerchantCancellationSteps rejects a merchant id that doesn't exist", async () => {
    if (!dbAvailable) return;
    await expect(commerce.setMerchantCancellationSteps("mer_does_not_exist_xyz", ownerUserId, { steps: ["Anything"] })).rejects.toThrow();
  });

  it("a seeded real-world merchant (Netflix) from the shipped reference-data seed resolves its curated steps when present", async () => {
    if (!dbAvailable) return;
    // This only asserts something when the merchant-cancellation-steps seed has actually been run in this
    // environment (packages/db/src/seed/merchant-cancellation-steps.ts) — it's a real seed check, not a
    // fixture, so it degrades gracefully (skips its assertion) rather than failing in an environment where
    // that seed script was never run, same as this repo's other "if seeded" style checks.
    const resolved = await resolveMerchantCancellationSteps(db, "mer_netflix", ownerUserId);
    if (!resolved) return;
    expect(resolved.source).toBe("seeded");
    expect(resolved.steps.length).toBeGreaterThan(0);
  });

  it("subscriptionDetail falls back to curated cancellation steps when no evidenced URL exists, and to null when neither exists", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Cancellation Steps Test — Subscription Detail" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Open the app", "Tap Cancel Subscription"],
      sourceNote: "Test fixture for subscriptionDetail.",
    });

    const streamId = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({
      id: streamId,
      ownerUserId,
      merchantId,
      serviceLabel: "Subscription Detail Cancellation Test Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 999,
      typicalAmountCurrency: "USD",
    });
    const subscriptionId = generateId("subscription");
    await db.insert(schema.subscriptions).values({
      id: subscriptionId,
      recurringStreamId: streamId,
      state: "active",
      confidenceBand: "high",
      cancellationInstructionsUrl: null,
    });

    const detail = await commerce.subscriptionDetail(subscriptionId, ownerUserId);
    expect(detail?.cancellationSteps).not.toBeNull();
    expect(detail?.cancellationSteps?.steps).toEqual(["Open the app", "Tap Cancel Subscription"]);

    // A second subscription whose merchant has nothing curated at all falls back to null — the UI's
    // existing honest "not found" message, never fabricated steps.
    const merchantId2 = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId2, displayName: "Cancellation Steps Test — No Curated Steps" });
    const streamId2 = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({
      id: streamId2,
      ownerUserId,
      merchantId: merchantId2,
      serviceLabel: "Subscription Detail No-Steps Test Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 499,
      typicalAmountCurrency: "USD",
    });
    const subscriptionId2 = generateId("subscription");
    await db.insert(schema.subscriptions).values({
      id: subscriptionId2,
      recurringStreamId: streamId2,
      state: "active",
      confidenceBand: "high",
      cancellationInstructionsUrl: null,
    });
    const detail2 = await commerce.subscriptionDetail(subscriptionId2, ownerUserId);
    expect(detail2?.cancellationSteps).toBeNull();
  });
});
