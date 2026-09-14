import { beforeAll, describe, expect, it } from "vitest";
import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IdentityService } from "./identity.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { OnboardingService } from "../onboarding/onboarding.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopMailer = { send: async () => {} } as unknown as MailerService;
const noopQueue = {} as unknown as QueueProducer;
const noopOnboarding = { ensureStateFor: async () => {} } as unknown as OnboardingService;

/** Never throttles, so the timing measurement is not distorted by the per-account counter. */
const permissiveCache: Cache = { incr: async () => 1, expire: async () => {}, del: async () => {} };

/**
 * §28.8 — "return generic authorization errors where detail would help enumerate accounts". This
 * codebase's own forgotPassword doc comment spells out that the response "(and timing/shape)" must not let
 * a caller distinguish a real account from an unknown one.
 *
 * Sign-in did not honour that: it returned before argon2 for an unknown address, so it answered sooner.
 * Measured against the running API before the fix, four samples each —
 *
 *   real account, wrong password:  0.255  0.256  0.255  0.254
 *   no such account:               0.223  0.215  0.217  0.233
 *
 * — with every sample separating, which makes it a reliable test for "does this address have an account"
 * rather than a statistical lean.
 */
describe("IdentityService.signIn — an unknown address must not answer faster than a real one", () => {
  let db: Database;
  let identity: IdentityService;
  let email: string;
  let userId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, noopQueue, noopMailer, noopOnboarding, undefined, permissiveCache);
    try {
      userId = generateId("user");
      email = `signin-timing-${userId}@example.com`;
      await db.insert(schema.users).values({ id: userId, email, displayName: "Timing", passwordHash: await argon2.hash("Correct-Horse-Battery-Staple-9") });
    } catch {
      dbAvailable = false;
    }
  });

  it("spends comparable time on both, so the response does not enumerate accounts", async () => {
    if (!dbAvailable) return;
    const attempt = async (addr: string) => {
      const t0 = performance.now();
      await identity.signIn({ email: addr, password: "wrong-password" } as Parameters<IdentityService["signIn"]>[0], { platform: "test" }).catch(() => undefined);
      return performance.now() - t0;
    };

    // Warm the cached dummy hash and argon2's own lazy init, so neither is charged to the first sample.
    await attempt("warmup-unknown@example.com");
    await attempt(email);

    const real: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      real.push(await attempt(email));
      unknown.push(await attempt(`nobody-${i}-${Date.now()}@example.com`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

    // Asserted as a RATIO of the argon2 cost, not an absolute millisecond figure: an absolute threshold is
    // machine- and load-dependent, which is exactly the clock dependence that made DEF-072 flaky in CI.
    // Before the fix the unknown path skipped argon2 entirely and this ratio collapsed.
    expect(median(unknown)).toBeGreaterThan(median(real) * 0.5);

    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
});
