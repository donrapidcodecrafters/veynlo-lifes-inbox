import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
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
@Injectable()
export class AdminAuthService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async signIn(email: string, password: string): Promise<AdminSessionIssued> {
    const [admin] = await this.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email)).limit(1);
    if (!admin || admin.revokedAt) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    const valid = await argon2.verify(admin.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }

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
