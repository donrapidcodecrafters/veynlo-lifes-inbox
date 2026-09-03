import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { ensureState: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

/**
 * PRIV-002 "grace period if used" — `IdentityService.requestDeletion` used to enqueue the destructive
 * worker job with NO delay at all. Now it sets `status: "deletion_pending"` + `scheduledDeletionAt` 14
 * days out and only enqueues the destructive job for that future time; `cancelDeletion` reverses the DB
 * state AND removes the still-delayed queue job (not just the DB flag), since the actual safety property
 * this feature exists for is "the destructive job must never fire for an account that cancelled in time."
 * Real-Postgres test using a spy QueueProducer to assert against the queue calls themselves, not just the
 * DB row, matching this file's own doc comment on why `cancelAccountDeletion` exists as a distinct call.
 */
describe("IdentityService — account deletion grace period", () => {
  let db: Database;
  let identity: IdentityService;
  let enqueueCalls: Array<{ userId: string; delayMs: number | undefined }>;
  let cancelCalls: string[];
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    enqueueCalls = [];
    cancelCalls = [];
    const stubQueue = {
      enqueueAccountDeletion: async (data: { userId: string }, delayMs?: number) => {
        enqueueCalls.push({ userId: data.userId, delayMs });
      },
      cancelAccountDeletion: async (userId: string) => {
        cancelCalls.push(userId);
      },
    } as unknown as QueueProducer;
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    try {
      ownerUserId = generateId("user");
      // No passwordHash set — verifyStepUpPassword is a documented no-op for an OAuth-only account, so
      // requestDeletion/cancelDeletion can be exercised here without constructing a real argon2 hash.
      await db.insert(schema.users).values({ id: ownerUserId, email: `deletion-grace-${ownerUserId}@example.com`, displayName: "Deletion Grace Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping deletion-grace-period test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("requestDeletion schedules a delayed job instead of an immediate one, and cancelDeletion pulls it back before it fires", async () => {
    if (!dbAvailable) return;

    await identity.requestDeletion(ownerUserId, undefined);

    const [afterRequest] = await db.select().from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(afterRequest?.status).toBe("deletion_pending");
    expect(afterRequest?.scheduledDeletionAt).toBeTruthy();
    // The actual grace-period property: the job must be delayed, not fired immediately.
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.userId).toBe(ownerUserId);
    expect(enqueueCalls[0]!.delayMs).toBeGreaterThan(0);
    const scheduledMs = afterRequest!.scheduledDeletionAt!.getTime() - Date.now();
    // scheduledDeletionAt and the enqueued delay should agree (within a few seconds of test execution time).
    expect(Math.abs(scheduledMs - enqueueCalls[0]!.delayMs!)).toBeLessThan(5_000);

    await identity.cancelDeletion(ownerUserId);

    const [afterCancel] = await db.select().from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(afterCancel?.status).toBe("active");
    expect(afterCancel?.scheduledDeletionAt).toBeNull();
    expect(afterCancel?.deletedAt).toBeNull();
    // The real safety property — not just a DB flag flip: the delayed destructive job itself must be pulled.
    expect(cancelCalls).toEqual([ownerUserId]);
  });

  it("requestDeletion is idempotent for an account already deletion_pending or deleted — no duplicate job", async () => {
    if (!dbAvailable) return;
    await identity.requestDeletion(ownerUserId, undefined);
    const callsAfterFirst = enqueueCalls.length;

    await identity.requestDeletion(ownerUserId, undefined);
    expect(enqueueCalls).toHaveLength(callsAfterFirst); // no second job enqueued for an already-pending account

    await identity.cancelDeletion(ownerUserId); // restore for afterAll's cleanup delete
  });

  it("cancelDeletion on an account that is NOT pending deletion is a harmless no-op", async () => {
    if (!dbAvailable) return;
    const before = cancelCalls.length;
    await identity.cancelDeletion(ownerUserId); // ownerUserId is "active" at this point (prior test restored it)
    expect(cancelCalls).toHaveLength(before); // no queue call made — nothing to cancel
    const [user] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(user?.status).toBe("active");
  });
});
