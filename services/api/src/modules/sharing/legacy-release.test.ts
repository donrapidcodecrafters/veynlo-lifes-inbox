import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as argon2 from "argon2";
import { and, eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IdentityService } from "../identity/identity.service";
import { SharingService } from "./sharing.service";
import { LegacyReleaseService } from "./legacy-release.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { EmailProvider, PushProvider } from "../notifications/notification-provider.interface";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * §35 SHARE-006 "Future trusted delegate / legacy release" — real-Postgres coverage of the full lifecycle
 * this pass actually built: draft -> step-up-confirmed "armed" -> admin-initiated "pending_release" (with
 * a real waiting period) -> owner cancel OR superadmin finalize -> redemption. See LegacyReleaseService's
 * own doc comment for exactly what's manual (the admin actions) vs. what's explicitly NOT automated
 * (inactivity detection).
 *
 * IdentityService is constructed with stub queue/mailer/onboarding deps — this test only exercises
 * verifyStepUpPassword, which touches none of them (see that method's own body: a plain DB read + argon2
 * verify).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = {} as unknown as OnboardingService;
// Never exercised by anything in this file — none of these tests touch a code path in IdentityService
// that tracks a product analytics event.
const stubAnalytics = {} as unknown as AnalyticsService;

describe("LegacyReleaseService — §35 SHARE-006", () => {
  let db: Database;
  let legacyRelease: LegacyReleaseService;
  let ownerId: string;
  let ownerPassword = "correct-horse-battery-staple";
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    // Never exercised by any test in this top-level describe (none of them call scanInactivity/
    // sendInactivityWarning) — a real instance is constructed separately below, for the describe block
    // that actually tests the inactivity trigger.
    const stubNotificationDelivery = {} as unknown as NotificationDeliveryService;
    legacyRelease = new LegacyReleaseService(db, identity, new SharingService(db), stubNotificationDelivery);
    try {
      ownerId = generateId("user");
      await db.insert(schema.users).values({ id: ownerId, email: `legacy-owner-${ownerId}@example.com`, passwordHash: await argon2.hash(ownerPassword), displayName: "Owner" });
      await db.insert(schema.identityRecords).values({ id: generateId("identityRecord"), ownerUserId: ownerId, recordType: "passport", label: "US Passport" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping legacy-release tests — dev Postgres unavailable:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.ownerUserId, ownerId));
    await db.delete(schema.identityRecords).where(eq(schema.identityRecords.ownerUserId, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  it("creates a draft that does nothing until confirmed with the owner's real password", async () => {
    if (!dbAvailable) return;
    const { id } = await legacyRelease.create(ownerId, {
      trustedContactEmail: "trusted@example.com",
      categories: ["identity_records"],
      waitingPeriodDays: 14,
    });
    const [draft] = await db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id));
    expect(draft?.status).toBe("draft");

    await expect(legacyRelease.confirm(id, ownerId, "wrong-password")).rejects.toThrow();
    const [stillDraft] = await db.select({ status: schema.legacyReleaseConfigs.status }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id));
    expect(stillDraft?.status).toBe("draft");

    const confirmed = await legacyRelease.confirm(id, ownerId, ownerPassword);
    expect(confirmed.status).toBe("armed");
    const [armed] = await db.select({ status: schema.legacyReleaseConfigs.status, confirmedAt: schema.legacyReleaseConfigs.confirmedAt }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id));
    expect(armed?.status).toBe("armed");
    expect(armed?.confirmedAt).not.toBeNull();

    // Revocation is always available and needs no step-up gate.
    await legacyRelease.revoke(id, ownerId);
    const [revoked] = await db.select({ status: schema.legacyReleaseConfigs.status }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id));
    expect(revoked?.status).toBe("revoked");
    await expect(legacyRelease.revoke(id, ownerId)).rejects.toThrow(); // already revoked
  });

  it("the admin release path enforces the waiting period and requires two distinct actions, with an owner cancel escape hatch", async () => {
    if (!dbAvailable) return;
    const { id } = await legacyRelease.create(ownerId, {
      trustedContactEmail: "trusted2@example.com",
      categories: ["identity_records"],
      waitingPeriodDays: 30,
    });
    // Can't initiate a release before it's armed.
    await expect(legacyRelease.initiateRelease(id, "admin_1")).rejects.toThrow();

    await legacyRelease.confirm(id, ownerId, ownerPassword);
    const { status, releaseEligibleAt } = await legacyRelease.initiateRelease(id, "admin_1");
    expect(status).toBe("pending_release");
    expect(releaseEligibleAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000); // ~30 days out, never shortened

    // Finalizing before the waiting period elapses must be refused, even though the release is pending.
    await expect(legacyRelease.finalizeRelease(id, "superadmin_1")).rejects.toThrow();

    // The owner's cancel escape hatch pulls it back to "armed" without needing a password.
    const cancelled = await legacyRelease.cancelPendingRelease(id, ownerId);
    expect(cancelled.status).toBe("armed");
    const [afterCancel] = await db.select({ releaseEligibleAt: schema.legacyReleaseConfigs.releaseEligibleAt }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id));
    expect(afterCancel?.releaseEligibleAt).toBeNull();

    // Re-initiate, then simulate the waiting period having elapsed (directly, since this test can't wait
    // 30 real days) and finalize — a genuinely separate admin action succeeding once the clock has run out.
    await legacyRelease.initiateRelease(id, "admin_1");
    await db.update(schema.legacyReleaseConfigs).set({ releaseEligibleAt: new Date(Date.now() - 1000) }).where(eq(schema.legacyReleaseConfigs.id, id));
    const finalized = await legacyRelease.finalizeRelease(id, "superadmin_1");
    expect(finalized.status).toBe("released");
    expect(finalized.token).toBeTruthy();

    // Once released, revoke must refuse — the whole point of this status being terminal.
    await expect(legacyRelease.revoke(id, ownerId)).rejects.toThrow();

    // Redemption returns exactly the selected category, nothing else.
    const packet = await legacyRelease.access(finalized.token);
    expect(packet).toHaveProperty("identityRecords");
    expect(Object.keys(packet)).toEqual(["identityRecords"]);
    expect((packet.identityRecords as unknown[]).length).toBe(1);

    // An unknown/already-used-up token shape must be rejected the same generic way.
    await expect(legacyRelease.access("not-a-real-token")).rejects.toThrow();
  });
});

/**
 * §35 SHARE-006 automatic inactivity trigger — real-Postgres coverage of `scanInactivity` (the recurring
 * `legacy-release-inactivity-scan` queue tick's processor), the piece the original pass deliberately left
 * unbuilt. Uses a REAL NotificationDeliveryService (only its own queue dependency is stubbed, so
 * createAndEnqueue's own dedupe-by-existing-row / row-insert logic runs for real against Postgres) rather
 * than a mock, so "an owner gets a real email notification" is verified by reading the actual
 * `notifications` row back, not by asserting a spy was called.
 *
 * One shared owner/armed-config pair is deliberately reused, in order, across all four tests below — each
 * test manipulates `users.lastActiveAt` (the exact column AuthGuard/IdentityService.issueSession/
 * refreshSession maintain in production) to move the SAME owner through the real lifecycle a real account
 * would go through: warned -> logs back in (reset) -> warned again would be possible, but instead goes
 * straight to fully inactive -> auto-triggered. A second, permanently-unarmed (draft) config for this same
 * owner is checked at every step to prove an unarmed config never triggers, no matter how inactive its
 * owner is.
 */
describe("LegacyReleaseService — automatic inactivity trigger (scanInactivity)", () => {
  let db: Database;
  let legacyRelease: LegacyReleaseService;
  let ownerId: string;
  let armedConfigId: string;
  let draftConfigId: string;
  let dbAvailable = true;

  const ownerPassword = "correct-horse-battery-staple";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const THRESHOLD_DAYS = 10;
  const WAITING_PERIOD_DAYS = 20;

  async function setLastActiveAt(daysAgo: number) {
    await db.update(schema.users).set({ lastActiveAt: new Date(Date.now() - daysAgo * DAY_MS) }).where(eq(schema.users.id, ownerId));
  }

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    // Only enqueueNotificationDelivery is ever called (by createAndEnqueue) — deliver() itself is never
    // exercised by these tests, so the mailer/push providers below are never actually invoked.
    const stubQueueForNotifications = { enqueueNotificationDelivery: async () => {} } as unknown as QueueProducer;
    const stubEmailProvider = {} as unknown as EmailProvider;
    const stubPushProvider = {} as unknown as PushProvider;
    const notificationDelivery = new NotificationDeliveryService(db, stubQueueForNotifications, stubEmailProvider, stubPushProvider);
    legacyRelease = new LegacyReleaseService(db, identity, new SharingService(db), notificationDelivery);

    try {
      ownerId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerId,
        email: `legacy-inactivity-${ownerId}@example.com`,
        passwordHash: await argon2.hash(ownerPassword),
        displayName: "Inactivity Owner",
      });
      await db.insert(schema.identityRecords).values({ id: generateId("identityRecord"), ownerUserId: ownerId, recordType: "passport", label: "US Passport" });

      // Deliberately never confirmed — stays "draft" through every test below, to prove an unarmed config
      // never triggers regardless of inactivity.
      const draft = await legacyRelease.create(ownerId, {
        trustedContactEmail: "draft-trusted@example.com",
        categories: ["identity_records"],
        waitingPeriodDays: 14,
        inactivityThresholdDays: 5,
      });
      draftConfigId = draft.id;

      const armed = await legacyRelease.create(ownerId, {
        trustedContactEmail: "armed-trusted@example.com",
        categories: ["identity_records"],
        waitingPeriodDays: WAITING_PERIOD_DAYS,
        inactivityThresholdDays: THRESHOLD_DAYS,
      });
      armedConfigId = armed.id;
      await legacyRelease.confirm(armedConfigId, ownerId, ownerPassword);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping legacy-release inactivity tests — dev Postgres unavailable:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.notifications).where(eq(schema.notifications.ownerUserId, ownerId));
    await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.resourceId, [armedConfigId, draftConfigId]));
    await db.delete(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.ownerUserId, ownerId));
    await db.delete(schema.identityRecords).where(eq(schema.identityRecords.ownerUserId, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  });

  it("an owner crossing the warning threshold (75% of their configured inactivity days) gets a real email notification, at most once per inactivity spell", async () => {
    if (!dbAvailable) return;
    await setLastActiveAt(8); // 8 of 10 days — past the 7.5-day (75%) warning point, short of the full threshold

    const first = await legacyRelease.scanInactivity();
    expect(first.warned).toBe(1);
    expect(first.triggered).toBe(0);

    const [afterFirstScan] = await db
      .select({ status: schema.legacyReleaseConfigs.status, inactivityWarningSentAt: schema.legacyReleaseConfigs.inactivityWarningSentAt })
      .from(schema.legacyReleaseConfigs)
      .where(eq(schema.legacyReleaseConfigs.id, armedConfigId));
    expect(afterFirstScan?.status).toBe("armed"); // a warning never moves status
    expect(afterFirstScan?.inactivityWarningSentAt).not.toBeNull();

    const notificationRows = await db.select().from(schema.notifications).where(eq(schema.notifications.ownerUserId, ownerId));
    const warningRows = notificationRows.filter((n) => n.dedupeKey.startsWith(`legacy-release-inactivity-warning:${armedConfigId}:`));
    expect(warningRows.length).toBe(1);
    expect(warningRows[0]?.priority).toBe("critical");

    // The unarmed draft, sharing this same (very inactive) owner, must be completely untouched.
    const [draftRow] = await db.select({ status: schema.legacyReleaseConfigs.status }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, draftConfigId));
    expect(draftRow?.status).toBe("draft");

    // A second tick at the same inactivity level must not send a second warning email.
    const second = await legacyRelease.scanInactivity();
    expect(second.warned).toBe(0);
    const notificationRowsAfterSecondScan = await db.select().from(schema.notifications).where(eq(schema.notifications.ownerUserId, ownerId));
    expect(notificationRowsAfterSecondScan.filter((n) => n.dedupeKey.startsWith(`legacy-release-inactivity-warning:${armedConfigId}:`)).length).toBe(1);
  });

  it("logging back in before the full threshold resets the inactivity clock and triggers nothing", async () => {
    if (!dbAvailable) return;
    // Simulate a real sign-in: the exact column AuthGuard/IdentityService.issueSession/refreshSession bump.
    await setLastActiveAt(0);

    const result = await legacyRelease.scanInactivity();
    expect(result.triggered).toBe(0);
    expect(result.warned).toBe(0);

    const [config] = await db
      .select({ status: schema.legacyReleaseConfigs.status, inactivityWarningSentAt: schema.legacyReleaseConfigs.inactivityWarningSentAt })
      .from(schema.legacyReleaseConfigs)
      .where(eq(schema.legacyReleaseConfigs.id, armedConfigId));
    expect(config?.status).toBe("armed"); // still armed, never touched
    expect(config?.inactivityWarningSentAt).toBeNull(); // the earlier warning flag was cleared by the reset
  });

  it("an armed config whose owner crosses the FULL configured inactivity threshold has the waiting period auto-started, exactly like a manual admin initiation", async () => {
    if (!dbAvailable) return;
    await setLastActiveAt(THRESHOLD_DAYS + 1); // past the full threshold

    const result = await legacyRelease.scanInactivity();
    expect(result.triggered).toBe(1);

    const [config] = await db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, armedConfigId));
    expect(config?.status).toBe("pending_release");
    expect(config?.releaseEligibleAt).not.toBeNull();
    expect(config!.releaseEligibleAt!.getTime()).toBeGreaterThan(Date.now() + (WAITING_PERIOD_DAYS - 1) * DAY_MS); // the owner's own waiting period, never shortened
    expect(config?.releaseInitiatedByAdminId).toBeNull(); // no human admin — a system trigger

    const [auditRow] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.resourceId, armedConfigId), eq(schema.auditEvents.action, "legacy_release.auto_initiate")));
    expect(auditRow?.actorType).toBe("system");

    // The unarmed draft, sharing this same fully-inactive owner, must STILL be completely untouched.
    const [draftRow] = await db.select({ status: schema.legacyReleaseConfigs.status }).from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, draftConfigId));
    expect(draftRow?.status).toBe("draft");

    // The superadmin-gated finalize step is completely unaffected by an auto-initiated release — it's
    // still refused before the waiting period elapses, exactly as it would be for a manual admin initiation.
    await expect(legacyRelease.finalizeRelease(armedConfigId, "superadmin_1")).rejects.toThrow();

    // The owner's own cancel-anytime escape hatch still works on an auto-initiated pending release.
    const cancelled = await legacyRelease.cancelPendingRelease(armedConfigId, ownerId);
    expect(cancelled.status).toBe("armed");
  });
});
