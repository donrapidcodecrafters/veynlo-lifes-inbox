import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import type { SignInDto, SignUpDto } from "./dto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days; short-lived-enough with server-side revocation as the real control

export interface SessionIssued {
  token: string;
  expiresAt: Date;
  userId: string;
}

@Injectable()
export class IdentityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async signUp(dto: SignUpDto, deviceInfo: { platform: string; displayName?: string }): Promise<SessionIssued> {
    const [existing] = await this.db.select().from(schema.users).where(eq(schema.users.email, dto.email)).limit(1);
    if (existing) {
      throw new ConflictException({
        code: "EMAIL_ALREADY_REGISTERED",
        message: "An account with this email already exists. Try signing in instead.",
      });
    }

    const passwordHash = await argon2.hash(dto.password);
    const userId = generateId("user");
    await this.db.insert(schema.users).values({
      id: userId,
      email: dto.email,
      displayName: dto.displayName,
      timezone: dto.timezone,
      passwordHash,
      status: "active",
    });
    await this.db.insert(schema.identityLinks).values({
      id: generateId("identityLink"),
      userId,
      provider: "email",
      providerSubject: dto.email,
    });
    await this.db.insert(schema.notificationPreferences).values({ userId });

    return this.issueSession(userId, deviceInfo);
  }

  async signIn(dto: SignInDto, deviceInfo: { platform: string; displayName?: string }): Promise<SessionIssued> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, dto.email)).limit(1);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    return this.issueSession(user.id, deviceInfo);
  }

  private async issueSession(
    userId: string,
    deviceInfo: { platform: string; displayName?: string },
  ): Promise<SessionIssued> {
    const env = loadEnv();
    const deviceId = generateId("device");
    await this.db.insert(schema.devices).values({
      id: deviceId,
      userId,
      platform: deviceInfo.platform,
      displayName: deviceInfo.displayName ?? null,
      trusted: false,
    });

    const sessionId = generateId("session");
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    await this.db.insert(schema.sessions).values({
      id: sessionId,
      userId,
      deviceId,
      refreshTokenHash: "not_used_v1", // rotating refresh-token flow lands with mobile native auth; web uses this session cookie directly for now
      expiresAt,
    });

    const token = await new SignJWT({ sub: userId, sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));

    return { token, expiresAt, userId };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  }

  async listSessions(userId: string) {
    return this.db
      .select({
        id: schema.sessions.id,
        deviceId: schema.sessions.deviceId,
        createdAt: schema.sessions.createdAt,
        lastSeenAt: schema.sessions.lastSeenAt,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId));
  }

  async me(userId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) return null;
    const { passwordHash: _passwordHash, ...safe } = user;
    return safe;
  }
}
