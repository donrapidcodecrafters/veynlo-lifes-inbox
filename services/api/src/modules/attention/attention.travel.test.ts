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
 * Phase 3 §26 TRIP-006/TRIP-007 — the travelCredits expiration scan (mirroring storeCredits/warranties'
 * own pattern) and the travel-document (passport) readiness scan, both added to
 * AttentionService.scanAndFileDeadlines. See that method's own doc comments for the precision-first,
 * never-invents-a-visa-rule stance.
 */
describe("AttentionService.scanAndFileDeadlines — travel credits and document readiness", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-travel-${ownerUserId}@example.com`, displayName: "Attention Travel Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService travel tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("files a travel_credit_expiring item for an unredeemed, soon-expiring credit — and not for an already-redeemed one", async () => {
    if (!dbAvailable) return;
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const activeCreditId = generateId("travelCredit");
    const redeemedCreditId = generateId("travelCredit");
    await db.insert(schema.travelCredits).values([
      { id: activeCreditId, ownerUserId, providerName: "Test Air", amountMinorUnits: 15_000, currency: "USD", expirationDate: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null }, expirationDateSort: soon },
      { id: redeemedCreditId, ownerUserId, providerName: "Test Hotel", amountMinorUnits: 8_000, currency: "USD", expirationDate: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null }, expirationDateSort: soon, redeemed: true },
    ]);

    await attention.scanAndFileDeadlines();

    const [activeItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "travel_credit"), eq(schema.attentionItems.linkedResourceId, activeCreditId)));
    expect(activeItem).toBeTruthy();
    expect(activeItem!.reasonCode).toBe("travel_credit_expiring");
    expect(activeItem!.reasonText).toContain("Test Air");

    const [redeemedItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "travel_credit"), eq(schema.attentionItems.linkedResourceId, redeemedCreditId)));
    expect(redeemedItem).toBeUndefined();
  });

  it("flags a passport expiring before an upcoming trip ends, but not one that's valid well beyond it", async () => {
    if (!dbAvailable) return;
    const tripStart = new Date(Date.now() + 10 * 86_400_000);
    const tripEnd = new Date(Date.now() + 17 * 86_400_000);
    const tripId = generateId("trip");
    await db.insert(schema.trips).values({
      id: tripId,
      ownerUserId,
      destinationLabel: "Testland",
      startDate: { precision: "date", instantUtc: null, date: tripStart.toISOString().slice(0, 10), timezone: null, sourceText: null },
      startDateSort: tripStart,
      endDate: { precision: "date", instantUtc: null, date: tripEnd.toISOString().slice(0, 10), timezone: null, sourceText: null },
      endDateSort: tripEnd,
    });

    const expiredSoonDocId = generateId("document");
    const validDocId = generateId("document");
    const before = new Date(tripEnd.getTime() - 2 * 86_400_000); // expires DURING the trip
    const wellAfter = new Date(tripEnd.getTime() + 400 * 86_400_000); // expires well over a year later
    await db.insert(schema.documents).values([
      { id: expiredSoonDocId, ownerUserId, documentType: "identity_document", title: "Expiring passport", documentKind: "passport", expiresAt: { precision: "date", instantUtc: null, date: before.toISOString().slice(0, 10), timezone: null, sourceText: null }, expiresAtSort: before, tags: [] },
      { id: validDocId, ownerUserId, documentType: "identity_document", title: "Fresh passport", documentKind: "passport", expiresAt: { precision: "date", instantUtc: null, date: wellAfter.toISOString().slice(0, 10), timezone: null, sourceText: null }, expiresAtSort: wellAfter, tags: [] },
    ]);

    await attention.scanAndFileDeadlines();

    const [expiringItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "document"), eq(schema.attentionItems.linkedResourceId, expiredSoonDocId)));
    expect(expiringItem).toBeTruthy();
    expect(expiringItem!.reasonCode).toBe("travel_document_expiring");
    expect(expiringItem!.reasonText).toContain("verify entry requirements");
    // Never asserts a jurisdiction-specific rule as fact.
    expect(expiringItem!.reasonText.toLowerCase()).not.toContain("you are required to");

    const [validItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "document"), eq(schema.attentionItems.linkedResourceId, validDocId)));
    expect(validItem).toBeUndefined();

    await db.delete(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
  });
});
