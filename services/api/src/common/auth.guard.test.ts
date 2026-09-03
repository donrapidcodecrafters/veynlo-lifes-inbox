import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { loadEnv } from "../config/env";
import { AuthGuard } from "./auth.guard";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

function makeContext(request: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

/**
 * Regression for docs/INCIDENT_RESPONSE.md's tracked gap: "`users.status` has a `suspended` enum value
 * that nothing in the codebase ever sets or checks — AuthGuard only rejects `deletion_pending`/`deleted`,
 * never `suspended`." Proves the new check actually rejects a live, otherwise-valid session the moment its
 * owning account is suspended (the bearer-token path, so CSRF's cookie-only check never enters into it —
 * see AuthGuard's own doc comment for why bearer skips CSRF), and that an active account's session is
 * unaffected.
 */
describe("AuthGuard — suspended account rejection", () => {
  let db: Database;
  let guard: AuthGuard;
  let userId: string;
  let sessionId: string;
  let token: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    guard = new AuthGuard(db, new Reflector());
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `auth-guard-suspend-${userId}@example.com`, displayName: "Auth Guard Suspend Test User", status: "active" });
      sessionId = generateId("session");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.insert(schema.sessions).values({ id: sessionId, userId, refreshTokenHash: "unused-in-this-test", expiresAt });
      token = await new SignJWT({ sub: userId, sid: sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AuthGuard suspended-account tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("allows a session through while the owning account is active", async () => {
    if (!dbAvailable) return;
    const request: { headers: Record<string, string>; cookies: Record<string, string>; user?: unknown } = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toEqual({ userId, sessionId });
  });

  it("rejects the same still-unexpired session the moment the account is suspended, with a distinct ACCOUNT_SUSPENDED code", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ status: "suspended" }).where(eq(schema.users.id, userId));

    const request = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
    let caught: unknown;
    try {
      await guard.canActivate(makeContext(request));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect((caught as UnauthorizedException).getResponse()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });

    // Restore for the next test / any re-run.
    await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, userId));
  });
});

/**
 * §35 SHARE-006 legacy-release inactivity trigger — `users.lastActiveAt` is the real activity signal
 * LegacyReleaseService.scanInactivity reads (see that file's own test suite for the actual trigger/warning
 * behavior); this proves AuthGuard is one of the places that keeps it current, throttled so it isn't a
 * write on every single request (see ACTIVITY_TOUCH_THROTTLE_MS).
 */
describe("AuthGuard — users.lastActiveAt activity tracking", () => {
  let db: Database;
  let guard: AuthGuard;
  let userId: string;
  let sessionId: string;
  let token: string;
  let dbAvailable = true;

  async function makeRequest() {
    return { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  }

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    guard = new AuthGuard(db, new Reflector());
    try {
      userId = generateId("user");
      // Backdated well past the 5-minute throttle window, so the very first request below is guaranteed
      // to see it as stale and write a fresh value.
      await db.insert(schema.users).values({
        id: userId,
        email: `auth-guard-activity-${userId}@example.com`,
        displayName: "Auth Guard Activity Test User",
        lastActiveAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      sessionId = generateId("session");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.insert(schema.sessions).values({
        id: sessionId,
        userId,
        refreshTokenHash: "unused-in-this-test",
        expiresAt,
        lastSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      token = await new SignJWT({ sub: userId, sid: sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AuthGuard activity-tracking tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("bumps users.lastActiveAt (and sessions.lastSeenAt) on a real authenticated request when the existing value is stale", async () => {
    if (!dbAvailable) return;
    const before = Date.now();
    await guard.canActivate(makeContext(await makeRequest()));

    const [row] = await db.select({ lastActiveAt: schema.users.lastActiveAt }).from(schema.users).where(eq(schema.users.id, userId));
    expect(row?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before);

    const [sessionRow] = await db.select({ lastSeenAt: schema.sessions.lastSeenAt }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(sessionRow?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("does not re-write lastActiveAt on the very next request within the throttle window", async () => {
    if (!dbAvailable) return;
    const [before] = await db.select({ lastActiveAt: schema.users.lastActiveAt }).from(schema.users).where(eq(schema.users.id, userId));

    await guard.canActivate(makeContext(await makeRequest()));

    const [after] = await db.select({ lastActiveAt: schema.users.lastActiveAt }).from(schema.users).where(eq(schema.users.id, userId));
    expect(after?.lastActiveAt.getTime()).toBe(before?.lastActiveAt.getTime());
  });
});
