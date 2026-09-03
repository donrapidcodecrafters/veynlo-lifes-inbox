import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import * as argon2 from "argon2";
import { generateId } from "@veynlo/core";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

/**
 * Companion to AdminService's suspendUser (admin.service.test.ts) and AuthGuard's "suspended" rejection
 * (auth.guard.test.ts): AuthGuard rejects a suspended account's ALREADY-ISSUED session, but nothing
 * previously stopped a suspended account from completing a fresh password sign-in and getting a brand-new
 * session in the first place — found while wiring up the suspend feature, same "correct credentials but
 * the account itself can't be used right now" shape as the existing deletion_pending/deleted check right
 * above it in IdentityService.signIn.
 */
describe("IdentityService.signIn — suspended account rejection", () => {
  let db: Database;
  let identity: IdentityService;
  let userId: string;
  let dbAvailable = true;
  const email = `suspended-sign-in-test-${Date.now()}@example.com`;
  const password = "correcthorsebattery123";

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    try {
      userId = generateId("user");
      const passwordHash = await argon2.hash(password);
      await db.insert(schema.users).values({ id: userId, email, displayName: "Suspended Sign-In Test User", passwordHash, status: "suspended" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IdentityService suspended sign-in tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("rejects sign-in with correct credentials while the account is suspended, with a distinct ACCOUNT_SUSPENDED code", async () => {
    if (!dbAvailable) return;
    await expect(identity.signIn({ email, password }, { platform: "web" })).rejects.toMatchObject({ response: { code: "ACCOUNT_SUSPENDED" } });
  });

  it("allows sign-in again once the account is reactivated", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, userId));
    const session = await identity.signIn({ email, password }, { platform: "web" });
    expect(session.userId).toBe(userId);
  });
});
