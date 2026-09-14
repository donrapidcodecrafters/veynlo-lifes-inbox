import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CACHE, type Cache } from "../../cache/cache.interface";
import { loadEnv } from "../../config/env";

const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8; // 8-hour shift-length session, not a persistent login

export interface AdminSessionIssued {
  token: string;
  expiresAt: Date;
  adminUserId: string;
}

/**
 * Separate identity plane from consumer auth (§3.1 "support agent" is a
 * distinct principal type). A different JWT audience claim (`aud: "admin"`)
 * means a consumer session token can never be replayed as an admin session
 * even if someone tried to reuse the cookie value across domains.
 */
/**
 * Tighter than the user-facing ten. The route comment on admin sign-in already says admin credentials are
 * "the highest-value target in the whole system", and unlike a user account there is no self-service
 * recovery to lock someone out of by abusing this.
 */
const ADMIN_SIGN_IN_FAILURE_LIMIT = 5;
const ADMIN_SIGN_IN_FAILURE_WINDOW_SECONDS = 15 * 60;

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Optional for the same reason IdentityService's is: unit tests construct this service directly.
    @Inject(CACHE) private readonly cache?: Cache,
  ) {}

  /** Same shape as IdentityService.signInFailureKey — hashed so the cache never holds an inventory of
   *  admin addresses, and normalised so casing variants cannot buy a fresh allowance. */
  private adminSignInFailureKey(email: string): string {
    const normalized = email.trim().toLowerCase();
    return `admin-signin-fail:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
  }

  private async assertNotThrottled(email: string): Promise<void> {
    if (!this.cache) return;
    const key = this.adminSignInFailureKey(email);
    const current = await this.cache.incr(key);
    if (current === 1) await this.cache.expire(key, ADMIN_SIGN_IN_FAILURE_WINDOW_SECONDS);
    if (current > ADMIN_SIGN_IN_FAILURE_LIMIT) {
      throw new HttpException(
        { code: "TOO_MANY_REQUESTS", message: "You're doing that too much. Please wait a bit and try again." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** A real argon2 verify against a throwaway hash, so an unknown or revoked account costs the same time
   *  as a real one. Cached because hashing once per process is the point — see
   *  CaregiverDayPassService.dummyPasscodeHash, which is where this pattern already lives. */
  private dummyHashCache: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    if (!this.dummyHashCache) this.dummyHashCache = argon2.hash(randomBytes(16).toString("hex"));
    return this.dummyHashCache;
  }

  async signIn(email: string, password: string): Promise<AdminSessionIssued> {
    // Per-ACCOUNT, on top of the route's per-IP @Throttle. The per-IP cap alone does nothing against
    // attempts spread across addresses, which is the same reasoning that put a per-account counter on the
    // user-facing sign-in — it just never got carried to the higher-value one.
    await this.assertNotThrottled(email);

    const [admin] = await this.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email)).limit(1);
    if (!admin || admin.revokedAt) {
      // Measured before this was added: a real account took ~269ms (argon2 ran) and an unknown one ~212ms
      // (it did not), with every sample separating cleanly — a reliable oracle for enumerating which
      // addresses are admin accounts. The dummy verify removes the difference.
      await argon2.verify(await this.dummyHash(), password).catch(() => false);
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    const valid = await argon2.verify(admin.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    // Cleared on success, so the counter measures attempts since the last correct password.
    await this.cache?.del(this.adminSignInFailureKey(email));

    const env = loadEnv();
    const sessionId = generateId("adminSession");
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000);
    await this.db.insert(schema.adminSessions).values({ id: sessionId, adminUserId: admin.id, expiresAt });
    await this.db.update(schema.adminUsers).set({ lastLoginAt: new Date() }).where(eq(schema.adminUsers.id, admin.id));

    const token = await new SignJWT({ sub: admin.id, sid: sessionId, aud: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));

    return { token, expiresAt, adminUserId: admin.id };
  }

  async verifySession(adminUserId: string, sessionId: string): Promise<{ id: string; email: string; role: string } | null> {
    const [session] = await this.db
      .select()
      .from(schema.adminSessions)
      .where(and(eq(schema.adminSessions.id, sessionId), isNull(schema.adminSessions.revokedAt)))
      .limit(1);
    if (!session || session.expiresAt < new Date()) return null;

    const [admin] = await this.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, adminUserId)).limit(1);
    if (!admin || admin.revokedAt) return null;

    return { id: admin.id, email: admin.email, role: admin.role };
  }

  async signOut(sessionId: string): Promise<void> {
    await this.db.update(schema.adminSessions).set({ revokedAt: new Date() }).where(eq(schema.adminSessions.id, sessionId));
  }
}
