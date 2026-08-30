import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { BillingService } from "./billing.service";

/**
 * §46.2 "prevent double subscription when user attempts a second channel" — previously unenforced:
 * createCheckoutSession never checked whether the user already had an active paid entitlement from ANY
 * source before starting a brand-new Stripe checkout, so a user already subscribed via one channel (or
 * plan) could start a second, overlapping paid subscription. This guard runs before any Stripe API call,
 * so it's testable here with no live Stripe credentials — this environment has none (a pre-existing,
 * already-documented constraint for Stripe/RevenueCat integration tests elsewhere in this codebase).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const billing = new BillingService(db, {} as never); // NotificationDeliveryService — unreached by this guard

const ownerUserId = generateId("user");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerUserId, displayName: "Double Subscription Test User" });
});

afterAll(async () => {
  await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
});

describe("BillingService.createCheckoutSession — refuses a second subscription across channels", () => {
  it("refuses to start a new checkout when the user already has an active entitlement from a DIFFERENT source", async () => {
    const entitlementId = generateId("entitlement");
    await db.insert(schema.entitlements).values({
      id: entitlementId,
      userId: ownerUserId,
      planKey: "plus",
      source: "revenuecat", // already subscribed via native IAP
      effectiveFrom: new Date(),
      effectiveTo: null,
    });

    await expect(billing.createCheckoutSession(ownerUserId, "family", "price_fake")).rejects.toBeInstanceOf(BadRequestException);
    await expect(billing.createCheckoutSession(ownerUserId, "family", "price_fake")).rejects.toMatchObject({
      response: { code: "ALREADY_SUBSCRIBED" },
    });
  });

  it("refuses even when the target plan differs from the currently active one (not just an exact-plan check)", async () => {
    const [existing] = await db.select({ id: schema.entitlements.id }).from(schema.entitlements).where(eq(schema.entitlements.userId, ownerUserId));
    expect(existing).toBeDefined(); // still has the "plus" entitlement from the previous test

    await expect(billing.createCheckoutSession(ownerUserId, "pro_agent", "price_fake")).rejects.toMatchObject({
      response: { code: "ALREADY_SUBSCRIBED" },
    });
  });
});
