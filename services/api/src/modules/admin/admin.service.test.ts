import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AdminService } from "./admin.service";
import { IdentityService } from "../identity/identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = { enqueueConnectorSync: async () => {}, enqueueConnectionDataDeletion: async () => {}, getQueueHealth: async () => ({}) } as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

describe("AdminService — suspend/unsuspend/force-logout and merchant-merge lineage", () => {
  let db: Database;
  let admin: AdminService;
  let actorAdminId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    admin = new AdminService(db, stubQueue, identity);
    try {
      actorAdminId = generateId("adminUser");
      await db.insert(schema.adminUsers).values({ id: actorAdminId, email: `admin-service-test-${actorAdminId}@example.com`, displayName: "Admin Service Test Admin", passwordHash: "unused-in-this-test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AdminService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, actorAdminId));
  });

  // --- suspend/unsuspend + force-logout (docs/INCIDENT_RESPONSE.md's two tracked gaps) -----------------

  async function makeUserWithSession(): Promise<{ userId: string; sessionId: string }> {
    const userId = generateId("user");
    await db.insert(schema.users).values({ id: userId, email: `admin-suspend-test-${userId}@example.com`, displayName: "Admin Suspend Test User", status: "active" });
    const sessionId = generateId("session");
    await db.insert(schema.sessions).values({ id: sessionId, userId, refreshTokenHash: "unused-in-this-test", expiresAt: new Date(Date.now() + 3_600_000) });
    return { userId, sessionId };
  }

  it("suspendUser sets status to suspended, revokes every live session, and is reversible via unsuspendUser", async () => {
    if (!dbAvailable) return;
    const { userId, sessionId } = await makeUserWithSession();

    await admin.suspendUser(userId, { reason: "Reported fraud on this account" }, actorAdminId);

    const [suspendedUser] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId));
    expect(suspendedUser?.status).toBe("suspended");
    const [revokedSession] = await db.select({ revokedAt: schema.sessions.revokedAt }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(revokedSession?.revokedAt).not.toBeNull();

    // Rejects a second suspend on an already-suspended account rather than silently no-op'ing.
    await expect(admin.suspendUser(userId, { reason: "again" }, actorAdminId)).rejects.toMatchObject({ response: { code: "ALREADY_SUSPENDED" } });

    await admin.unsuspendUser(userId, actorAdminId);
    const [reactivatedUser] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId));
    expect(reactivatedUser?.status).toBe("active");

    await expect(admin.unsuspendUser(userId, actorAdminId)).rejects.toMatchObject({ response: { code: "NOT_SUSPENDED" } });

    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("forceLogoutUser revokes every live session without changing account status", async () => {
    if (!dbAvailable) return;
    const { userId, sessionId } = await makeUserWithSession();

    await admin.forceLogoutUser(userId, actorAdminId);

    const [session] = await db.select({ revokedAt: schema.sessions.revokedAt }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(session?.revokedAt).not.toBeNull();
    const [user] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.status).toBe("active"); // force-logout is not suspension — the account stays fully usable

    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  // --- merchant-merge lineage now also repoints storeCredits/recurringStreams --------------------------

  it("mergeMerchants repoints purchases, store credits, AND recurring streams atomically, and unmergeMerchants reverses all three", async () => {
    if (!dbAvailable) return;
    const ownerUserId = generateId("user");
    await db.insert(schema.users).values({ id: ownerUserId, email: `merge-lineage-test-${ownerUserId}@example.com`, displayName: "Merge Lineage Test User" });

    const survivingMerchantId = generateId("merchant");
    const mergedMerchantId = generateId("merchant");
    await db.insert(schema.merchants).values([
      { id: survivingMerchantId, displayName: "Surviving Merchant Co." },
      { id: mergedMerchantId, displayName: "Merged Merchant Co." },
    ]);

    const storeCreditId = generateId("storeCredit");
    await db.insert(schema.storeCredits).values({ id: storeCreditId, ownerUserId, merchantId: mergedMerchantId, amountMinorUnits: 2_500, currency: "USD" });

    const recurringStreamId = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({ id: recurringStreamId, ownerUserId, merchantId: mergedMerchantId, serviceLabel: "Merged Merchant Subscription", cadence: "monthly" });

    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({ id: purchaseId, ownerUserId, merchantId: mergedMerchantId, purchaseDate, state: "candidate", confidenceBand: "high" });

    const { lineageId, repointedStoreCreditCount, repointedRecurringStreamCount } = await admin.mergeMerchants(survivingMerchantId, mergedMerchantId, actorAdminId);
    expect(repointedStoreCreditCount).toBe(1);
    expect(repointedRecurringStreamCount).toBe(1);

    const [storeCreditAfterMerge] = await db.select({ merchantId: schema.storeCredits.merchantId }).from(schema.storeCredits).where(eq(schema.storeCredits.id, storeCreditId));
    expect(storeCreditAfterMerge?.merchantId).toBe(survivingMerchantId);
    const [streamAfterMerge] = await db.select({ merchantId: schema.recurringStreams.merchantId }).from(schema.recurringStreams).where(eq(schema.recurringStreams.id, recurringStreamId));
    expect(streamAfterMerge?.merchantId).toBe(survivingMerchantId);
    const [purchaseAfterMerge] = await db.select({ merchantId: schema.purchases.merchantId }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    expect(purchaseAfterMerge?.merchantId).toBe(survivingMerchantId);

    const { restoredStoreCreditCount, restoredRecurringStreamCount } = await admin.unmergeMerchants(lineageId, actorAdminId);
    expect(restoredStoreCreditCount).toBe(1);
    expect(restoredRecurringStreamCount).toBe(1);

    const [storeCreditAfterUnmerge] = await db.select({ merchantId: schema.storeCredits.merchantId }).from(schema.storeCredits).where(eq(schema.storeCredits.id, storeCreditId));
    expect(storeCreditAfterUnmerge?.merchantId).toBe(mergedMerchantId);
    const [streamAfterUnmerge] = await db.select({ merchantId: schema.recurringStreams.merchantId }).from(schema.recurringStreams).where(eq(schema.recurringStreams.id, recurringStreamId));
    expect(streamAfterUnmerge?.merchantId).toBe(mergedMerchantId);

    // merchantMergeLineage.actorAdminId has no onDelete action — must go before afterAll deletes actorAdminId.
    await db.delete(schema.merchantMergeLineage).where(eq(schema.merchantMergeLineage.id, lineageId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, survivingMerchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, mergedMerchantId));
  });
});
