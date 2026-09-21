import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import * as argon2 from "argon2";
import { IdentityService } from "./identity.service";
import { OnboardingService } from "../onboarding/onboarding.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopMailer = { send: async () => {} } as unknown as MailerService;
const noopQueue = {} as unknown as QueueProducer;

function fakeCache() {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    cache: {
      incr: async (key: string) => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      },
      expire: async (key: string, ttlSeconds: number) => {
        ttls.set(key, ttlSeconds);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    } satisfies Cache,
  };
}

/**
 * §28.9's step-up gate protects the emergency binder (identity records, vehicles, properties, pets, medical
 * appointments), a raw passport/licence number reveal, the full data export, and connector connect.
 *
 * It had no throttle of its own, and of the endpoints using it only data export carried a per-route
 * `@Throttle`. So someone holding a stolen session could guess the step-up password at the global per-IP
 * rate to unlock the binder or reveal a document number — and both of those paths wrote an audit row on
 * every failed attempt that nothing ever counted. The same shape as sign-in before DEF-057, on the second
 * factor instead of the first.
 *
 * Throttled inside `verifyStepUpPassword` rather than at each caller, so a new step-up-protected action
 * cannot be added without it.
 */
describe("IdentityService.verifyStepUpPassword — per-account throttling", () => {
  let db: Database;
  let userId: string;
  let oauthOnlyUserId: string;
  let dbAvailable = true;
  const PASSWORD = "Step-Up-Password-1";

  const makeService = (cache: Cache) => {
    const onboarding = { ensureStateFor: async () => {} } as unknown as OnboardingService;
    return new IdentityService(db, noopQueue, noopMailer, onboarding, undefined, cache);
  };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      userId = generateId("user");
      oauthOnlyUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: userId, email: `stepup-${userId}@example.com`, displayName: "Step Up User", passwordHash: await argon2.hash(PASSWORD) },
        // No passwordHash: an OAuth-only account has no step-up factor to verify or to brute force.
        { id: oauthOnlyUserId, email: `stepup-oauth-${oauthOnlyUserId}@example.com`, displayName: "OAuth Only User" },
      ]);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, oauthOnlyUserId));
  });

  const wrong = (svc: IdentityService) => svc.verifyStepUpPassword(userId, "not-the-password").catch((e: Error) => e);

  it("stops accepting attempts after the limit", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);

    for (let i = 0; i < 5; i++) {
      const err = (await wrong(svc)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("INVALID_CREDENTIALS");
    }
    const throttled = (await wrong(svc)) as { response?: { code?: string }; status?: number };
    expect(throttled.response?.code).toBe("TOO_MANY_REQUESTS");
    expect(throttled.status).toBe(429);
  });

  it("refuses the correct password too once the limit is hit", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 6; i++) await wrong(svc);
    const err = (await svc.verifyStepUpPassword(userId, PASSWORD).catch((e: Error) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe("TOO_MANY_REQUESTS");
  });

  it("does NOT count the password-required round-trip, which every unlock makes", async () => {
    if (!dbAvailable) return;
    // The emergency binder calls unlock with no password first, precisely to be told one is needed. If that
    // counted, a legitimate user would burn their allowance before typing anything.
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 10; i++) {
      const err = (await svc.verifyStepUpPassword(userId, undefined).catch((e: Error) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("PASSWORD_REQUIRED");
    }
    expect(store.size).toBe(0);
    // And a correct password still works afterwards.
    await expect(svc.verifyStepUpPassword(userId, PASSWORD)).resolves.toBeUndefined();
  });

  it("clears the counter on a correct password", async () => {
    if (!dbAvailable) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 3; i++) await wrong(svc);
    expect(store.get(`stepup-fail:${userId}`)).toBe(3);
    await svc.verifyStepUpPassword(userId, PASSWORD);
    expect(store.size).toBe(0);
  });

  it("sets an expiry, so a counter cannot become a permanent lockout", async () => {
    if (!dbAvailable) return;
    const { cache, ttls } = fakeCache();
    const svc = makeService(cache);
    await wrong(svc);
    expect([...ttls.values()]).toEqual([15 * 60]);
  });

  it("stays a no-op for an OAuth-only account, which has no step-up factor at all", async () => {
    if (!dbAvailable) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 10; i++) {
      await expect(svc.verifyStepUpPassword(oauthOnlyUserId, undefined)).resolves.toBeUndefined();
    }
    expect(store.size).toBe(0);
  });

  it("counts separately from the sign-in throttle", async () => {
    if (!dbAvailable) return;
    // Two different gates with two different limits; one must not consume the other's allowance.
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    await wrong(svc);
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^stepup-fail:/);
    expect(keys[0]).not.toMatch(/^signin-fail:/);
  });
});
