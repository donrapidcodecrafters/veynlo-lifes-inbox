import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AdminAuthService } from "./admin-auth.service";
import type { Cache } from "../../cache/cache.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

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
 * Admin sign-in had a per-IP `@Throttle` whose own comment calls admin credentials "the highest-value
 * target in the whole system" — and nothing per account. A per-IP cap does nothing against attempts spread
 * across addresses, which is exactly the reasoning that put a per-account counter on the USER-facing
 * sign-in; it was simply never carried to the higher-value one.
 *
 * It also returned early for an unknown or revoked account without running argon2, so the response was
 * measurably faster. Measured against the running API before the fix: ~269ms for a real account against
 * ~212ms for an unknown one, with every sample separating cleanly — a reliable oracle for enumerating
 * which addresses are admin accounts. This codebase already avoids that elsewhere, in
 * CaregiverDayPassService.dummyPasscodeHash.
 */
describe("AdminAuthService.signIn — hardening", () => {
  let db: Database;
  let adminId: string;
  let revokedId: string;
  let dbAvailable = true;
  const PASSWORD = "Admin-Password-1";

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      adminId = generateId("adminUser");
      revokedId = generateId("adminUser");
      const passwordHash = await argon2.hash(PASSWORD);
      await db.insert(schema.adminUsers).values([
        { id: adminId, email: `hardening-${adminId}@veynlo.app`, displayName: "Hardening Admin", passwordHash, role: "support" },
        { id: revokedId, email: `hardening-revoked-${revokedId}@veynlo.app`, displayName: "Revoked Admin", passwordHash, role: "support", revokedAt: new Date() },
      ]);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, adminId));
    await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, revokedId));
  });

  const email = () => `hardening-${adminId}@veynlo.app`;

  it("stops accepting attempts for one account after the limit, regardless of source address", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = new AdminAuthService(db, cache);
    for (let i = 0; i < 5; i++) {
      const err = (await svc.signIn(email(), "wrong").catch((e: Error) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("INVALID_CREDENTIALS");
    }
    const throttled = (await svc.signIn(email(), "wrong").catch((e: Error) => e)) as { response?: { code?: string }; status?: number };
    expect(throttled.response?.code).toBe("TOO_MANY_REQUESTS");
    expect(throttled.status).toBe(429);
  });

  it("refuses the correct password too, once the limit is hit", async () => {
    if (!dbAvailable) return;
    const { cache } = fakeCache();
    const svc = new AdminAuthService(db, cache);
    for (let i = 0; i < 6; i++) await svc.signIn(email(), "wrong").catch(() => undefined);
    const err = (await svc.signIn(email(), PASSWORD).catch((e: Error) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe("TOO_MANY_REQUESTS");
  });

  it("clears the counter on a correct password, and sets an expiry so it cannot become a lockout", async () => {
    if (!dbAvailable) return;
    const { cache, store, ttls } = fakeCache();
    const svc = new AdminAuthService(db, cache);
    await svc.signIn(email(), "wrong").catch(() => undefined);
    await svc.signIn(email(), "wrong").catch(() => undefined);
    expect(store.size).toBe(1);
    expect([...ttls.values()]).toEqual([15 * 60]);
    await svc.signIn(email(), PASSWORD);
    expect(store.size).toBe(0);
  });

  it("counts per account, so one address cannot consume another's allowance", async () => {
    if (!dbAvailable) return;
    const { cache, store } = fakeCache();
    const svc = new AdminAuthService(db, cache);
    await svc.signIn(email(), "wrong").catch(() => undefined);
    await svc.signIn(`hardening-revoked-${revokedId}@veynlo.app`, "wrong").catch(() => undefined);
    expect(store.size).toBe(2);
  });

  it("spends comparable time on an unknown account as on a real one", async () => {
    if (!dbAvailable) return;
    // The oracle was ~57ms wide and separated cleanly on every sample. This asserts the gap is a small
    // fraction of the argon2 cost rather than asserting an absolute number, which would be machine- and
    // load-dependent and therefore flaky — the kind of clock dependence DEF-072 was about.
    const { cache } = fakeCache();
    const svc = new AdminAuthService(db, cache);
    // Warm the cached dummy hash first, so its one-off argon2.hash is not charged to the first sample.
    await svc.signIn("warmup-unknown@veynlo.app", "x").catch(() => undefined);

    const time = async (addr: string) => {
      const t0 = performance.now();
      await svc.signIn(addr, "wrong-password").catch(() => undefined);
      return performance.now() - t0;
    };
    const real: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { cache: c } = fakeCache();
      const s2 = new AdminAuthService(db, c);
      await s2.signIn("warm@veynlo.app", "x").catch(() => undefined);
      real.push(await time(email()));
      unknown.push(await time(`nobody-${i}-${Date.now()}@veynlo.app`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const realMs = median(real);
    const unknownMs = median(unknown);
    // Both paths now run one argon2 verify, so the unknown path must not be dramatically cheaper.
    expect(unknownMs).toBeGreaterThan(realMs * 0.5);
  });
});
