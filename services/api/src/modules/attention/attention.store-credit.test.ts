import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * CRED-001 "Credits and stored value" — found live during an audit pass: the comment on the travelCredits
 * scan in AttentionService.scanAndFileDeadlines always claimed to mirror "the exact same expiration-alert
 * pattern as storeCredits/warranties above," but no storeCredits expiration scan ever actually existed — a
 * store credit could silently expire with zero warning. Mirrors attention.travel.test.ts's
 * travel_credit_expiring test exactly, since store_credit_expiring is built to the same shape.
 */
describe("AttentionService.scanAndFileDeadlines — store credit expiration", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let merchantId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      merchantId = generateId("merchant");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-store-credit-${ownerUserId}@example.com`, displayName: "Attention Store Credit Test" });
      await db.insert(schema.merchants).values({ id: merchantId, displayName: "Test Outfitters" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService store-credit test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
    }
  });

  it("files a store_credit_expiring item for an unredeemed, soon-expiring credit — and not for an already-redeemed one", async () => {
    if (!dbAvailable) return;
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const activeCreditId = generateId("storeCredit");
    const redeemedCreditId = generateId("storeCredit");
    await db.insert(schema.storeCredits).values([
      {
        id: activeCreditId,
        ownerUserId,
        merchantId,
        amountMinorUnits: 4_200,
        currency: "USD",
        expirationDate: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null },
        expirationDateSort: soon,
      },
      {
        id: redeemedCreditId,
        ownerUserId,
        merchantId,
        amountMinorUnits: 1_500,
        currency: "USD",
        expirationDate: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null },
        expirationDateSort: soon,
        redeemed: true,
      },
    ]);

    await attention.scanAndFileDeadlines();

    const [activeItem] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "store_credit"), eq(schema.attentionItems.linkedResourceId, activeCreditId)));
    expect(activeItem).toBeTruthy();
    expect(activeItem!.reasonCode).toBe("store_credit_expiring");
    expect(activeItem!.reasonText).toContain("Test Outfitters");

    const [redeemedItem] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "store_credit"), eq(schema.attentionItems.linkedResourceId, redeemedCreditId)));
    expect(redeemedItem).toBeUndefined();

    await db.delete(schema.storeCredits).where(eq(schema.storeCredits.ownerUserId, ownerUserId));
  });
});
