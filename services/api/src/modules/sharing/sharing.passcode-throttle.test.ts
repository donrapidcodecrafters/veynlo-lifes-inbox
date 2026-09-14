import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SharingService } from "./sharing.service";
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
 * A share-link passcode is user-chosen and may be four characters (dto.ts: z.string().min(4)) - about ten
 * thousand possibilities for a four-digit one. The public redemption endpoints carried only a per-IP
 * @Throttle of 10/minute, which does not bound an attacker who can change address: at that rate from a
 * handful of IPs a four-digit passcode falls in hours.
 *
 * This codebase already answered the same question three times - sign-in, admin sign-in and the step-up
 * password each gained a per-ACCOUNT counter on top of their per-IP limit, for exactly this reason. The
 * link passcode is the same shape of secret and had only the per-IP half.
 *
 * Keyed on the link row's id, not the submitted token, so posting random tokens cannot mint counter keys
 * and the unknown-token path keeps the dummy-argon2 timing equalisation resolveShareLink documents.
 */
describe("SharingService - passcode attempt throttling", () => {
  let db: Database;
  let dbAvailable = true;
  let setupError: Error | null = null;

  const userId = generateId("user");
  const docId = generateId("document");
  const PASSCODE = "7391";
  // createShareLink mints the token itself and returns it once, which is the whole posture of the feature.
  let TOKEN = "";

  const makeService = (cache?: Cache) => new SharingService(db, cache);

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.insert(schema.users).values({ id: userId, email: `share-pc-${userId}@example.com`, displayName: "Share Passcode" });
    } catch {
      dbAvailable = false;
      return;
    }
    try {
      await db.insert(schema.documents).values({ id: docId, ownerUserId: userId, documentType: "receipt", title: "Shared Receipt", tags: [] });
      const created = await makeService().createShareLink("document", docId, userId, { passcode: PASSCODE });
      TOKEN = created.token;
    } catch (error) {
      setupError = error as Error;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("set the fixture up", () => {
    if (!dbAvailable) return;
    expect(setupError, setupError?.message).toBeNull();
  });

  const wrong = (svc: SharingService) => svc.resolveShareLink(TOKEN, "0000").catch((e: Error) => e);

  it("stops accepting passcode attempts for a link after the limit", async () => {
    if (!dbAvailable || setupError) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);

    for (let i = 0; i < 10; i++) {
      const err = (await wrong(svc)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("PASSCODE_REQUIRED");
    }
    const throttled = (await wrong(svc)) as { response?: { code?: string }; status?: number };
    expect(throttled.response?.code).toBe("TOO_MANY_REQUESTS");
    expect(throttled.status).toBe(429);
  });

  it("refuses the correct passcode too once the limit is hit", async () => {
    if (!dbAvailable || setupError) return;
    const { cache } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 11; i++) await wrong(svc);
    const err = (await svc.resolveShareLink(TOKEN, PASSCODE).catch((e: Error) => e)) as { response?: { code?: string } };
    expect(err.response?.code).toBe("TOO_MANY_REQUESTS");
  });

  it("clears the counter on a correct passcode", async () => {
    if (!dbAvailable || setupError) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 3; i++) await wrong(svc);
    expect([...store.values()]).toEqual([3]);
    await svc.resolveShareLink(TOKEN, PASSCODE);
    expect(store.size, "a legitimate holder's occasional fumble must not accumulate forever").toBe(0);
  });

  it("sets an expiry, so a counter cannot become a permanent lockout", async () => {
    if (!dbAvailable || setupError) return;
    const { cache, ttls } = fakeCache();
    await wrong(makeService(cache));
    expect([...ttls.values()]).toEqual([15 * 60]);
  });

  it("counts per link, so one link's attempts cannot lock another", async () => {
    if (!dbAvailable || setupError) return;
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    const { token: otherToken } = await svc.createShareLink("document", docId, userId, { passcode: PASSCODE });
    await wrong(svc);
    await svc.resolveShareLink(otherToken, "0000").catch(() => {});
    expect([...store.keys()], "two distinct counters, one per link").toHaveLength(2);
  });

  it("does not create a counter for a token that does not resolve", async () => {
    if (!dbAvailable || setupError) return;
    // Otherwise posting random tokens would mint unbounded keys in Redis, and the unknown-token path must
    // keep taking the dummy-argon2 branch that makes it indistinguishable from a wrong passcode.
    const { cache, store } = fakeCache();
    const svc = makeService(cache);
    for (let i = 0; i < 5; i++) {
      const err = (await svc.resolveShareLink(`no-such-token-${i}`, "0000").catch((e: Error) => e)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("SHARE_LINK_NOT_FOUND");
    }
    expect(store.size).toBe(0);
  });

  it("still works with no cache at all, since CacheModule may be absent in a unit context", async () => {
    if (!dbAvailable || setupError) return;
    const svc = makeService(undefined);
    for (let i = 0; i < 12; i++) {
      const err = (await wrong(svc)) as { response?: { code?: string } };
      expect(err.response?.code).toBe("PASSCODE_REQUIRED");
    }
    await expect(svc.resolveShareLink(TOKEN, PASSCODE)).resolves.toMatchObject({ resourceType: "document", resourceId: docId });
  });
});
