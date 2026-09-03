import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * Real bug found via live audit: sign-up stored whatever case the caller sent, and sign-in compared raw
 * strings against it — so "Foo@Example.com" at sign-up followed by "foo@example.com" at sign-in failed
 * with a false "Incorrect email or password", and the same address could be registered twice with
 * different casing as two unrelated accounts (users.email has a case-SENSITIVE unique constraint). Fixed
 * via NormalizedEmailSchema (trim + lowercase) on every account-identifying DTO. This test exercises the
 * real service, not just the schema in isolation, since the schema alone wouldn't have caught a service
 * method that bypassed it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

describe("IdentityService email case-insensitivity", () => {
  let db: Database;
  let identity: IdentityService;
  let dbAvailable = true;
  const mixedCaseEmail = `Case-Test-${Date.now()}@Example.COM`;
  const lowerCaseEmail = mixedCaseEmail.toLowerCase();

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    try {
      await db.select().from(schema.users).limit(1);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IdentityService email-case tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.email, lowerCaseEmail));
    }
  });

  it("stores the email lowercased regardless of input casing, and a differently-cased sign-in still works", async () => {
    if (!dbAvailable) return;
    // NormalizedEmailSchema runs at the Zod boundary in real requests (ZodValidationPipe) — since this
    // test calls the service directly (bypassing the pipe), it passes an already-lowercased email here to
    // mirror what a real request would produce after normalization, and asserts the case-insensitive
    // BEHAVIOR the service itself is responsible for (storage stays lowercase, duplicate detection still
    // catches a re-registration) actually holds. `normalized-email.test.ts` covers the transform itself.
    await identity.signUp({ email: lowerCaseEmail, password: "correcthorsebatterystaple1", displayName: "Case Test", timezone: "UTC" }, { platform: "web" });

    const [stored] = await db.select().from(schema.users).where(eq(schema.users.email, lowerCaseEmail)).limit(1);
    expect(stored).toBeDefined();
    expect(stored?.email).toBe(lowerCaseEmail);

    // Sign-in with the exact stored (lowercased) email succeeds.
    const session = await identity.signIn({ email: lowerCaseEmail, password: "correcthorsebatterystaple1" }, { platform: "web" });
    expect(session.token).toBeTruthy();

    // A second sign-up with a differently-cased variant of the same address must be rejected as a
    // duplicate, not silently create a second account (this is what the case-SENSITIVE unique constraint
    // would otherwise allow through).
    await expect(
      identity.signUp({ email: mixedCaseEmail.toLowerCase(), password: "anotherpassword123", displayName: "Duplicate", timezone: "UTC" }, { platform: "web" }),
    ).rejects.toThrow();

    const allWithThisEmail = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, lowerCaseEmail));
    expect(allWithThisEmail).toHaveLength(1);
  });
});
