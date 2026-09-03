import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * "Pre-launch private testing distribution" (docs/ROADMAP.md) — SIGNUP_REQUIRES_INVITE defaults to false
 * (see config/env.ts), so this file deliberately does NOT set it, exercising the real default. Kept in its
 * own file (separate from identity.signup-invite.test.ts, which sets the flag true) since config/env.ts's
 * loadEnv() caches its parsed result for the lifetime of a module registry — vitest gives each test file
 * its own, so the two files' opposite flag states can't bleed into each other.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

describe("Sign-up with SIGNUP_REQUIRES_INVITE left at its default (off)", () => {
  let db: Database;
  let identity: IdentityService;
  let dbAvailable = true;
  const email = `no-invite-needed-${Date.now()}@example.com`;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    try {
      await db.select().from(schema.users).limit(1);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping flag-off sign-up test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.identityLinks).where(eq(schema.identityLinks.providerSubject, email));
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (user) {
      await db.delete(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, user.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      await db.delete(schema.devices).where(eq(schema.devices.userId, user.id));
    }
    await db.delete(schema.users).where(eq(schema.users.email, email));
  });

  it("succeeds with no inviteCode field at all, exactly as sign-up worked before this feature existed", async () => {
    if (!dbAvailable) return;
    const session = await identity.signUp({ email, password: "correcthorsebatterystaple1", displayName: "No Gate", timezone: "UTC" }, { platform: "web" });
    expect(session.token).toBeTruthy();

    const [stored] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    expect(stored).toBeDefined();
  });
});
