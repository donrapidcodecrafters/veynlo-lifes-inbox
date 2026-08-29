import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
import { google } from "googleapis";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured, isInboundEmailConfigured } from "../../config/env";
import { QueueProducerService } from "../../queue/queue-producer.service";
import type { SignInDto, SignUpDto } from "./dto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days; short-lived-enough with server-side revocation as the real control

const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OIDC_SCOPES = "openid email profile";

export class OAuthNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} sign-in is not configured on this deployment (missing OAuth client credentials).`);
    this.name = "OAuthNotConfiguredError";
  }
}

/** Minimal decode of a JWT's payload segment — no signature check. Safe here specifically because both
 * callers receive this token from a server-to-server token-endpoint exchange (this process's own HTTPS
 * call to Google/Microsoft, authenticated with our client_secret), not from anything attacker-influenced
 * like a browser redirect fragment — the same trust model GmailAdapter/OutlookAdapter already rely on for
 * the access/refresh tokens they get back from the identical kind of exchange. */
/** An opaque routing token — deliberately not the userId itself, so a leaked/spammed alias can be
 * rotated without exposing the internal id in an externally-forwarded address. */
function generateInboundAlias(): string {
  return `u-${randomBytes(8).toString("hex")}`;
}

function decodeJwtPayload<T>(jwt: string): T {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("Malformed JWT: missing payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

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
      inboundEmailAlias: generateInboundAlias(),
    });
    await this.db.insert(schema.identityLinks).values({
      id: generateId("identityLink"),
      userId,
      provider: "email",
      providerSubject: dto.email,
    });
    await this.db.insert(schema.notificationPreferences).values({ userId });
    await this.activatePendingHouseholdInvites(userId, dto.email);

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
    await this.activatePendingHouseholdInvites(user.id, user.email);
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

  /**
   * FAM invite acceptance — a person invited to a household (HouseholdService.invite, which only ever
   * created a pending `status: "invited"` row with no way to ever become active) activates automatically
   * the moment they authenticate with the invited email address, rather than needing a separate "accept"
   * click or token. Runs on every successful sign-up/sign-in/OAuth callback, not just once at signup —
   * idempotent (an already-active row never matches `status: "invited"`), and an invite can legitimately
   * arrive after the account already existed.
   */
  private async activatePendingHouseholdInvites(userId: string, email: string | null): Promise<void> {
    if (!email) return;
    await this.db
      .update(schema.householdMemberships)
      .set({ userId, status: "active", joinedAt: new Date() })
      .where(and(eq(schema.householdMemberships.invitedEmail, email), eq(schema.householdMemberships.status, "invited")));
  }

  isGoogleSignInConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  isMicrosoftSignInConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  /** Same Google Cloud OAuth client as the Gmail/Google Calendar connectors — one client can register
   * multiple redirect URIs and request different scopes per flow; this one asks for identity claims only
   * (no offline access, no Gmail/Calendar scopes, no consent-screen forcing), so it's a distinctly smaller
   * ask than connecting a connector even though it shares the same GOOGLE_OAUTH_CLIENT_ID/SECRET. */
  googleAuthorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isGoogleSignInConfigured()) throw new OAuthNotConfiguredError("google");
    const env = loadEnv();
    const client = new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, params.redirectUri);
    return client.generateAuthUrl({ scope: OIDC_SCOPES.split(" "), state: params.state });
  }

  async handleGoogleCallback(code: string, redirectUri: string, deviceInfo: { platform: string }): Promise<SessionIssued> {
    if (!this.isGoogleSignInConfigured()) throw new OAuthNotConfiguredError("google");
    const env = loadEnv();
    const client = new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new UnauthorizedException({ code: "OAUTH_NO_ID_TOKEN", message: "Google didn't return an identity token." });

    // Unlike the id_tokens decoded by decodeJwtPayload elsewhere in this file, this one IS verified —
    // verifyIdToken checks the signature against Google's published keys, since Google's client library
    // makes that essentially free to do properly rather than a reason to skip it.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_OAUTH_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Google identity." });

    return this.oauthSignIn(
      { provider: "google", providerSubject: payload.sub, email: payload.email ?? null, displayName: payload.name ?? payload.email ?? "Veynlo user" },
      deviceInfo,
    );
  }

  microsoftAuthorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isMicrosoftSignInConfigured()) throw new OAuthNotConfiguredError("microsoft");
    const env = loadEnv();
    const url = new URL(MICROSOFT_AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", OIDC_SCOPES);
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleMicrosoftCallback(code: string, redirectUri: string, deviceInfo: { platform: string }): Promise<SessionIssued> {
    if (!this.isMicrosoftSignInConfigured()) throw new OAuthNotConfiguredError("microsoft");
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: OIDC_SCOPES,
    });
    const response = await fetch(MICROSOFT_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) {
      throw new UnauthorizedException({ code: "OAUTH_TOKEN_EXCHANGE_FAILED", message: "Couldn't complete Microsoft sign-in." });
    }
    const json = (await response.json()) as { id_token?: string };
    if (!json.id_token) throw new UnauthorizedException({ code: "OAUTH_NO_ID_TOKEN", message: "Microsoft didn't return an identity token." });

    const payload = decodeJwtPayload<{ sub?: string; oid?: string; email?: string; preferred_username?: string; name?: string }>(json.id_token);
    const providerSubject = payload.sub ?? payload.oid;
    if (!providerSubject) throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Microsoft identity." });

    return this.oauthSignIn(
      {
        provider: "microsoft",
        providerSubject,
        email: payload.email ?? payload.preferred_username ?? null,
        displayName: payload.name ?? payload.email ?? "Veynlo user",
      },
      deviceInfo,
    );
  }

  /**
   * Deliberately never auto-links an OAuth sign-in to an existing password-based account just because the
   * emails match — that's a well-known account-takeover pattern (anyone who can get *any* email address
   * into an OAuth token, verified or not depending on the provider/tenant config, would otherwise be able
   * to sign into someone else's existing account). Only two paths: an `identity_links` row already proves
   * this exact provider+subject belongs to a Veynlo user (sign them in), or it doesn't, in which case a
   * new account is created — unless `users.email` already has a row for that address, since the column is
   * unique and silently creating a duplicate isn't possible anyway; that case is rejected with a message
   * pointing back to password sign-in rather than resolved by guessing.
   */
  private async oauthSignIn(
    params: { provider: string; providerSubject: string; email: string | null; displayName: string },
    deviceInfo: { platform: string },
  ): Promise<SessionIssued> {
    const [link] = await this.db
      .select()
      .from(schema.identityLinks)
      .where(and(eq(schema.identityLinks.provider, params.provider), eq(schema.identityLinks.providerSubject, params.providerSubject)))
      .limit(1);

    if (link) {
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_NOT_FOUND", message: "This sign-in method isn't linked to an account anymore." });
      if (user.status === "deletion_pending" || user.status === "deleted") {
        throw new UnauthorizedException({ code: "ACCOUNT_DELETED", message: "This account has been deleted." });
      }
      await this.activatePendingHouseholdInvites(user.id, user.email);
      return this.issueSession(user.id, deviceInfo);
    }

    if (params.email) {
      const [existingByEmail] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, params.email)).limit(1);
      if (existingByEmail) {
        throw new ConflictException({
          code: "EMAIL_ALREADY_REGISTERED",
          message: "An account with this email already exists. Sign in with your email and password instead.",
        });
      }
    }

    const userId = generateId("user");
    await this.db
      .insert(schema.users)
      .values({ id: userId, email: params.email, displayName: params.displayName, status: "active", inboundEmailAlias: generateInboundAlias() });
    await this.db.insert(schema.notificationPreferences).values({ userId });
    await this.db.insert(schema.identityLinks).values({
      id: generateId("identityLink"),
      userId,
      provider: params.provider,
      providerSubject: params.providerSubject,
    });
    await this.activatePendingHouseholdInvites(userId, params.email);

    return this.issueSession(userId, deviceInfo);
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

  /** Called after sign-in once the mobile client has a real Expo push token — stored on the device row
   * tied to the current session, since that's the only per-device identity a session carries. */
  async registerPushToken(sessionId: string, pushToken: string): Promise<void> {
    const [session] = await this.db.select({ deviceId: schema.sessions.deviceId }).from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
    if (!session?.deviceId) return;
    await this.db.update(schema.devices).set({ pushToken, lastActiveAt: new Date() }).where(eq(schema.devices.id, session.deviceId));
  }

  /** CAP-005 "forward-to-Life-Inbox address" — the alias always exists (generated at sign-up), but the
   * full forwardable address needs a real domain, so this reports "not configured" whenever no inbound
   * provider is wired up rather than showing an address that can never actually receive anything. */
  async inboundAliasInfo(userId: string): Promise<{ configured: boolean; address: string | null }> {
    if (!isInboundEmailConfigured()) return { configured: false, address: null };
    const [user] = await this.db.select({ inboundEmailAlias: schema.users.inboundEmailAlias }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const alias = user?.inboundEmailAlias;
    return { configured: true, address: alias ? `${alias}@${loadEnv().INBOUND_EMAIL_DOMAIN}` : null };
  }

  async rotateInboundAlias(userId: string): Promise<{ configured: boolean; address: string | null }> {
    const alias = generateInboundAlias();
    await this.db.update(schema.users).set({ inboundEmailAlias: alias, updatedAt: new Date() }).where(eq(schema.users.id, userId));
    return this.inboundAliasInfo(userId);
  }

  /** Resolves the inbound-email webhook's "To" address back to an owning user. Returns null for any
   * unrecognized/rotated-away alias — the webhook logs and no-ops rather than erroring, since a provider
   * will otherwise retry a bounced/stale forward indefinitely. */
  async findUserIdByInboundAlias(alias: string): Promise<string | null> {
    const [user] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.inboundEmailAlias, alias)).limit(1);
    return user?.id ?? null;
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

  /** PRIV-001 privacy/consent center — see the schema comment on `users.aiProcessingEnabled` for what this actually gates. */
  async setAiProcessingEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.db.update(schema.users).set({ aiProcessingEnabled: enabled, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  }
}
