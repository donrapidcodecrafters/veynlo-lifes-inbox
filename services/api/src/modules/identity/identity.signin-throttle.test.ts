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

/** An in-memory stand-in for the Redis cache, so the counter behaviour is observable and deterministic. */
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
 * THREAT_MODEL.md states the abuse case as "attacker with a large credential-stuffing list hits /sign-in —
 * mitigated by rate limiting", and SECURITY_CONTROLS.md V2.2 names the route's `@Throttle` as that
 * mitigation. It is not one: credential stuffing is distributed by definition and that limit is keyed by
 * IP, so a list spread across a botnet never trips it. Nothing counted per-account failures — they were
 * written to the audit log and never read.
 *
 * These check the control that closes it, including the two ways such a control usually goes wrong: it
 * must not tell an attacker which addresses exist, and it must not become a way to lock someone out.
 */
describe("IdentityService.signIn — per-account throttling", () => {
  let db: Database;
  let userId: string;
  let email: string;
  let dbAvailable = true;
  const PASSWORD = "Correct-Password-1";

  const makeService = (cache: Cache) => {
    const onboarding = { ensureStateFor: async () => {} } as unknown as OnboardingService;
    return new IdentityService(db, noopQueue, noopMailer, onboarding, undefined, cache);
  };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      userId = generateId("user");
      email = `throttle-${userId}@example.com`.toLowerCase();
      await db.insert(schema.users).values({
        id: userId,
        email,
        displayName: "Throttle Test User",
        passwordHash: await argon2.hash(PASSWORD),
      });
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  const signInWrong = (svc: IdentityService, address = email) =>
    svc.signIn({ email: address, password: "wrong-password" }, { platform: "web" }).catch((e: Error) => e);

  it("stops accepting attempts for one account after the limit, regardless of where they come from", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);

    // Ten wrong guesses: each rejected as bad credentials, which is the honest answer.
    for (let i = 0; i < 10; i++) {
      const err = (await signInWrong(svc)) as { code?: string; response?: { code?: string } };
      expect((err.response?.code ?? err.code) ?? String(err)).toBe("INVALID_CREDENTIALS");
    }

    // The eleventh is refused before the password is even checked.
    const throttled = (await signInWrong(svc)) as { response?: { code?: string }; status?: number };
    expect(throttled.response?.code).toBe("TOO_MANY_REQUESTS");
    expect(throttled.status).toBe(429);
  });

  it("refuses the CORRECT password too once the limit is hit — otherwise it would not stop a guesser", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 11; i++) await signInWrong(svc);

    const err = (await svc.signIn({ email, password: PASSWORD }, { platform: "web" }).catch((e: Error) => e)) as {
      response?: { code?: string };
    };
    expect(err.response?.code).toBe("TOO_MANY_REQUESTS");
  });

  it("does not reveal whether an address has an account", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);
    const nobody = `no-such-account-${generateId("user")}@example.com`;

    // Same rejection code for a real address and an unknown one, before the limit...
    const realErr = (await signInWrong(svc)) as { response?: { code?: string } };
    const fakeErr = (await signInWrong(svc, nobody)) as { response?: { code?: string } };
    expect(fakeErr.response?.code).toBe(realErr.response?.code);

    // ...and the same again after it, rather than one being throttled and the other not.
    for (let i = 0; i < 11; i++) await signInWrong(svc, nobody);
    const fakeThrottled = (await signInWrong(svc, nobody)) as { response?: { code?: string; message?: string } };
    expect(fakeThrottled.response?.code).toBe("TOO_MANY_REQUESTS");
    // And the message says nothing about accounts or locking.
    expect(fakeThrottled.response?.message).not.toMatch(/account|lock|exist/i);
  });

  it("clears the counter on a successful sign-in, so an earlier typo is not still counted later", async () => {
    if (!dbAvailable) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);

    for (let i = 0; i < 3; i++) await signInWrong(svc);
    expect([...store.values()].some((v) => v === 3)).toBe(true);

    await svc.signIn({ email, password: PASSWORD }, { platform: "web" });
    expect(store.size).toBe(0);
  });

  it("sets an expiry the first time, so a counter cannot outlive its window and lock an address out", async () => {
    if (!dbAvailable) return;
    const { cache, ttls } = fakeCache();
    const svc = makeService(cache);
    await signInWrong(svc);
    expect([...ttls.values()]).toEqual([15 * 60]);
  });

  it("keys on a hash, so the cache does not become a list of who has an account", async () => {
    if (!dbAvailable) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    await signInWrong(svc);
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(email);
    expect(keys[0]).toMatch(/^signin-fail:[0-9a-f]{32}$/);
  });

  it("counts casing variants of one address against the same counter", async () => {
    if (!dbAvailable) return;
    // Otherwise an attacker gets a fresh allowance per capitalisation — Foo@x.com, FOO@x.com, foo@X.com…
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    await signInWrong(svc, email);
    await signInWrong(svc, email.toUpperCase());
    await signInWrong(svc, ` ${email} `);
    expect(store.size).toBe(1);
    expect([...store.values()]).toEqual([3]);
  });

  it("is simply absent when no cache is wired, rather than throwing", async () => {
    if (!dbAvailable) return;
    const onboarding = { ensureStateFor: async () => {} } as unknown as OnboardingService;
    const svc = new IdentityService(db, noopQueue, noopMailer, onboarding);
    for (let i = 0; i < 12; i++) {
      const err = (await signInWrong(svc)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("INVALID_CREDENTIALS");
    }
  });
});
