import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { QueueProducerService } from "../../queue/queue-producer.service";
import type { SignInDto, SignUpDto } from "./dto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days; short-lived-enough with server-side revocation as the real control

export interface SessionIssued {
  token: string;
  expiresAt: Date;
  userId: string;
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queue: QueueProducerService,
  ) {}

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
    if (user.status === "deletion_pending" || user.status === "deleted") {
      // Correct credentials, but re-authenticating into an account mid-deletion would just create a new
      // session for data that's actively being torn down in the background — reject rather than race it.
      throw new UnauthorizedException({ code: "ACCOUNT_DELETED", message: "This account has been deleted." });
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

  /**
   * App Store §5.1.1(v) / Play Store User Data policy both require in-app self-service account deletion,
   * not just "contact support". Deletion itself (household reassignment/removal, cascading data delete,
   * S3 object cleanup) runs in the background (AccountDeletionJobData, worker-main.ts) since it can touch
   * a large, arbitrarily deep object graph — but everything that determines whether the user can be
   * deleted at all, and everything that makes the account immediately unusable, happens synchronously
   * here so the caller gets a definitive answer before the connection closes.
   */
  async requestDeletion(userId: string, password: string): Promise<void> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
    }
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
    }
    if (user.status === "deletion_pending" || user.status === "deleted") {
      return; // already in progress/done — idempotent, not an error
    }

    // A household must not vanish just because its billing owner deletes their account while other
    // members still depend on it — block and ask them to transfer ownership or remove the other members
    // first, rather than silently reassigning billing responsibility without anyone's consent.
    const ownedHouseholds = await this.db
      .select({ id: schema.households.id })
      .from(schema.households)
      .where(eq(schema.households.billingOwnerUserId, userId));
    for (const household of ownedHouseholds) {
      const [otherActiveMember] = await this.db
        .select({ id: schema.householdMemberships.id })
        .from(schema.householdMemberships)
        .where(
          and(
            eq(schema.householdMemberships.householdId, household.id),
            eq(schema.householdMemberships.status, "active"),
            ne(schema.householdMemberships.userId, userId),
          ),
        )
        .limit(1);
      if (otherActiveMember) {
        throw new BadRequestException({
          code: "HOUSEHOLD_OWNER_MUST_TRANSFER",
          message:
            "You own a household with other active members. Transfer ownership or remove the other members before deleting your account.",
        });
      }
    }

    await this.db
      .update(schema.users)
      .set({ status: "deletion_pending", deletedAt: new Date() })
      .where(eq(schema.users.id, userId));
    await this.revokeAllSessions(userId);
    await this.queue.enqueueAccountDeletion({ userId });
  }

  async me(userId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) return null;
    const { passwordHash: _passwordHash, ...safe } = user;
    return safe;
  }
}
