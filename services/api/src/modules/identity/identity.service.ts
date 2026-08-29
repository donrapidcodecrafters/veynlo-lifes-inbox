import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNull, ne, gt } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import { google } from "googleapis";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured, isInboundEmailConfigured } from "../../config/env";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { getRedisConnection } from "../../queue/redis-connection";
import { MailerService } from "../notifications/mailer.service";
import type { SignInDto, SignUpDto } from "./dto";

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days; short-lived-enough with server-side revocation as the real control

const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OIDC_SCOPES = "openid email profile";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// createRemoteJWKSet keeps its own internal key cache keyed by the JWKSet instance itself, not the URL —
// building a fresh one per request would refetch Apple/Google's public keys on every single native sign-in.
// Module-level singletons, lazily created on first use so a deployment with neither configured never fetches.
let appleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getAppleJwks() {
  if (!appleJwks) appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  return appleJwks;
}

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getGoogleJwks() {
  if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

// WebAuthn (passkeys) — web-only this pass; the browser's native navigator.credentials API has no mobile
// equivalent here without a native module port (react-native-passkeys or similar), a separate, larger
// effort tracked as a follow-up rather than attempted alongside this. The relying party ID/origin are
// derived from WEB_APP_URL rather than a new env var — they're not independent config, they're properties
// of wherever the web app is actually served from, and getting rpID wrong silently breaks every ceremony.
const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;

function webauthnRelyingParty(): { rpName: string; rpID: string; origin: string } {
  const url = new URL(loadEnv().WEB_APP_URL);
  return { rpName: "Veynlo", rpID: url.hostname, origin: url.origin };
}

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
    private readonly mailer: MailerService,
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
    await this.db.insert(schema.onboardingState).values({ userId });
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
   * §Account/security "Sign in with Apple" — native-only (there's no web redirect flow here; the mobile
   * app gets a signed identity token straight from the on-device Apple auth sheet via
   * expo-apple-authentication and posts it here). Apple's identity token only carries an email on the
   * FIRST-ever sign-in for a given app+user pair — every subsequent token omits it once the private-relay
   * pairing is already established server-side on Apple's end — and never carries a display name at all
   * (that comes back from the native SDK's one-time AuthorizationCredential.fullName, which the client
   * already has and could pass along, but isn't required here since oauthSignIn already falls back to the
   * email like the Google/Microsoft callbacks above).
   */
  async verifyAppleIdentityToken(identityToken: string, deviceInfo: { platform: string }): Promise<SessionIssued> {
    const env = loadEnv();
    if (!env.APPLE_SIGN_IN_CLIENT_ID) throw new OAuthNotConfiguredError("apple");

    let payload;
    try {
      ({ payload } = await jwtVerify(identityToken, getAppleJwks(), { issuer: APPLE_ISSUER, audience: env.APPLE_SIGN_IN_CLIENT_ID }));
    } catch {
      throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Apple identity." });
    }
    if (!payload.sub) throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Apple identity." });

    const email = typeof payload.email === "string" ? payload.email : null;
    return this.oauthSignIn({ provider: "apple", providerSubject: payload.sub, email, displayName: email ?? "Veynlo user" }, deviceInfo);
  }

  /**
   * §Account/security "Sign in with Google" (native) — a separate verification path from
   * handleGoogleCallback above even though both end up in the same oauthSignIn: the web flow's code gets
   * exchanged server-to-server with our own client_secret, so the id_token that comes back is already
   * something we fetched ourselves. A native app has no client_secret to hold, so Google's native SDK hands
   * the mobile app an already-signed identity token directly, which is verified here against Google's JWKS
   * instead of trusting a same-process fetch. Deliberately reuses provider: "google" (not e.g.
   * "google_native") — Google's `sub` claim is the same stable per-account identifier across every OAuth
   * client that account has ever used, so a user who first signed in via the web flow and later via native
   * Google Sign-In on mobile correctly matches the same identity_links row instead of creating a duplicate.
   */
  async verifyGoogleNativeIdentityToken(identityToken: string, deviceInfo: { platform: string }): Promise<SessionIssued> {
    const env = loadEnv();
    if (!env.GOOGLE_OAUTH_NATIVE_CLIENT_ID) throw new OAuthNotConfiguredError("google");

    let payload;
    try {
      ({ payload } = await jwtVerify(identityToken, getGoogleJwks(), { issuer: GOOGLE_ISSUERS, audience: env.GOOGLE_OAUTH_NATIVE_CLIENT_ID }));
    } catch {
      throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Google identity." });
    }
    if (!payload.sub) throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Google identity." });

    const email = typeof payload.email === "string" ? payload.email : null;
    const displayName = typeof payload.name === "string" ? payload.name : (email ?? "Veynlo user");
    return this.oauthSignIn({ provider: "google", providerSubject: payload.sub, email, displayName }, deviceInfo);
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
    await this.db.insert(schema.onboardingState).values({ userId });
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

  /**
   * §5 "account recovery" — this had zero implementation before (no forgot-password flow existed at all,
   * a real gap for any password-based account: an unbuilt equivalent of the OAuth-only-deletion bug fixed
   * elsewhere this session, just for login instead of deletion). Deliberately silent on whether the email
   * matches an account, and on whether that account even has a password — an OAuth-only account has
   * nothing to reset, but saying so would let this endpoint be used to fingerprint which sign-in method an
   * email uses. The raw token only ever exists in the emailed link; only its hash is stored.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (!user || !user.passwordHash) return;

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await this.db.insert(schema.passwordResetTokens).values({
      id: generateId("passwordResetToken"),
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    });

    const resetUrl = `${loadEnv().WEB_APP_URL}/reset-password?token=${rawToken}`;
    await this.mailer.send({
      to: email,
      subject: "Reset your Veynlo password",
      text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
      html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
    });
  }

  /** Consumes a reset token exactly once, sets the new password, and revokes every existing session —
   * the same "an account credential just changed, force re-auth everywhere" posture a password change
   * should always have, not just this one. */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const now = new Date();
    const [tokenRow] = await this.db
      .select()
      .from(schema.passwordResetTokens)
      .where(and(eq(schema.passwordResetTokens.tokenHash, tokenHash), isNull(schema.passwordResetTokens.usedAt), gt(schema.passwordResetTokens.expiresAt, now)))
      .limit(1);
    if (!tokenRow) {
      throw new BadRequestException({ code: "INVALID_RESET_TOKEN", message: "This reset link is invalid or has expired." });
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.db.update(schema.users).set({ passwordHash, updatedAt: now }).where(eq(schema.users.id, tokenRow.userId));
    await this.db.update(schema.passwordResetTokens).set({ usedAt: now }).where(eq(schema.passwordResetTokens.id, tokenRow.id));
    await this.revokeAllSessions(tokenRow.userId);
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

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await this.db
      .select({
        id: schema.sessions.id,
        createdAt: schema.sessions.createdAt,
        lastSeenAt: schema.sessions.lastSeenAt,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
        platform: schema.devices.platform,
        displayName: schema.devices.displayName,
        lastActiveAt: schema.devices.lastActiveAt,
      })
      .from(schema.sessions)
      .leftJoin(schema.devices, eq(schema.devices.id, schema.sessions.deviceId))
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
    return rows.map((r) => ({ ...r, isCurrent: r.id === currentSessionId }));
  }

  /** Unlike revokeSession (used for a user's own current-session sign-out, where ownership is implicit),
   * this lets a user revoke a *different* one of their own sessions — e.g. from a device list UI — so it
   * must check ownership explicitly. Without the userId scope this would let any signed-in user revoke
   * any other user's session just by knowing/guessing its id. */
  async revokeOwnSession(userId: string, sessionId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  }

  /**
   * App Store §5.1.1(v) / Play Store User Data policy both require in-app self-service account deletion,
   * not just "contact support". Deletion itself (household reassignment/removal, cascading data delete,
   * S3 object cleanup) runs in the background (AccountDeletionJobData, worker-main.ts) since it can touch
   * a large, arbitrarily deep object graph — but everything that determines whether the user can be
   * deleted at all, and everything that makes the account immediately unusable, happens synchronously
   * here so the caller gets a definitive answer before the connection closes.
   */
  async requestDeletion(userId: string, password: string | undefined): Promise<void> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
    }
    // An OAuth-only account (Google/Microsoft sign-in) has no password at all — requiring one made
    // self-service deletion permanently impossible for every such user (a real, App-Store-blocking bug:
    // Apple/Google both require in-app account deletion to work, not just for password-based accounts).
    // The already-AuthGuard-verified session is this account's only possible reauth, same as it's the
    // only credential these accounts ever had.
    if (user.passwordHash) {
      if (!password || !(await argon2.verify(user.passwordHash, password))) {
        throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
      }
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
    const { passwordHash, ...safe } = user;
    // Never expose the hash itself — only whether one exists, so the client can decide whether to ask
    // for a password on password-confirmation flows (e.g. account deletion) at all.
    return { ...safe, hasPassword: Boolean(passwordHash) };
  }

  /** PRIV-001 privacy/consent center — see the schema comment on `users.aiProcessingEnabled` for what this actually gates. */
  async setAiProcessingEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.db.update(schema.users).set({ aiProcessingEnabled: enabled, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  }

  /** MAIL-002 "category privacy controls" — see the schema comment on `users.disabledMailCategories` for what this actually gates. */
  async setDisabledMailCategories(userId: string, categories: string[]): Promise<void> {
    await this.db.update(schema.users).set({ disabledMailCategories: categories, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  }

  /** PRIV-001 "retention policy settings beyond Documents" — see the schema comment on `users.dataRetentionDays` for what this actually gates. */
  async setDataRetentionDays(userId: string, days: number | null): Promise<void> {
    await this.db.update(schema.users).set({ dataRetentionDays: days, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  }

  /**
   * Devices & security "Passkeys" — registration ceremony, step 1: generate the challenge the browser's
   * authenticator will sign. `residentKey: "required"` asks for a discoverable credential specifically so
   * sign-in (below) can be usernameless — otherwise the server would need to know who's signing in before
   * it could tell the browser which credential IDs to look for. The challenge is stashed in Redis (not the
   * DB — it's a short-lived ceremony artifact, not a durable record) keyed by userId, since registration is
   * always for the already-signed-in caller.
   */
  async generatePasskeyRegistrationOptions(userId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new UnauthorizedException({ code: "ACCOUNT_NOT_FOUND", message: "Account not found." });

    const existing = await this.db
      .select({ credentialId: schema.passkeys.credentialId })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, userId));

    const { rpName, rpID } = webauthnRelyingParty();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.email ?? userId,
      userID: new TextEncoder().encode(userId),
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    await getRedisConnection().set(`webauthn:reg:${userId}`, options.challenge, "EX", PASSKEY_CHALLENGE_TTL_SECONDS);
    return options;
  }

  /** Registration ceremony, step 2: verify the signed challenge came back from a real authenticator and
   * persist the resulting credential. The public key is stored base64url-encoded — it's a WebAuthn
   * *public* key by design, nothing here to encrypt, same reasoning as the schema comment on this column. */
  async verifyPasskeyRegistration(userId: string, response: RegistrationResponseJSON): Promise<{ id: string }> {
    const redis = getRedisConnection();
    const challenge = await redis.get(`webauthn:reg:${userId}`);
    if (!challenge) {
      throw new BadRequestException({ code: "PASSKEY_CHALLENGE_EXPIRED", message: "That passkey setup attempt expired. Please try again." });
    }

    const { rpID, origin } = webauthnRelyingParty();
    let verified: boolean;
    let credential: { id: string; publicKey: Uint8Array; counter: number };
    try {
      const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
      verified = result.verified;
      credential = result.registrationInfo?.credential ?? { id: "", publicKey: new Uint8Array(), counter: 0 };
    } catch {
      throw new BadRequestException({ code: "PASSKEY_VERIFICATION_FAILED", message: "Couldn't verify that passkey. Please try again." });
    }
    await redis.del(`webauthn:reg:${userId}`);
    if (!verified) throw new BadRequestException({ code: "PASSKEY_VERIFICATION_FAILED", message: "Couldn't verify that passkey. Please try again." });

    const id = generateId("passkey");
    await this.db.insert(schema.passkeys).values({
      id,
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: String(credential.counter),
    });
    return { id };
  }

  async listPasskeys(userId: string) {
    return this.db
      .select({ id: schema.passkeys.id, createdAt: schema.passkeys.createdAt })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, userId))
      .orderBy(desc(schema.passkeys.createdAt));
  }

  async deletePasskey(userId: string, id: string): Promise<void> {
    await this.db.delete(schema.passkeys).where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, userId)));
  }

  /**
   * Sign-in ceremony, step 1 — deliberately usernameless (no `allowCredentials`): the whole point of a
   * resident/discoverable credential is that the browser can present a picker without the server naming
   * candidates first. There's no signed-in user yet to key the challenge by, unlike registration above, so
   * this mints a random, single-use attemptId instead and returns it alongside the options for the client
   * to echo back in step 2.
   */
  async generatePasskeyAuthenticationOptions(): Promise<{ attemptId: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
    const { rpID } = webauthnRelyingParty();
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    const attemptId = randomBytes(16).toString("hex");
    await getRedisConnection().set(`webauthn:auth:${attemptId}`, options.challenge, "EX", PASSKEY_CHALLENGE_TTL_SECONDS);
    return { attemptId, options };
  }

  /** Sign-in ceremony, step 2 — the credential id in the response is the only thing that identifies which
   * user is signing in (there was no username step), so the matching `passkeys` row is looked up by it
   * directly rather than by any caller-supplied userId. */
  async verifyPasskeyAuthentication(
    attemptId: string,
    response: AuthenticationResponseJSON,
    deviceInfo: { platform: string },
  ): Promise<SessionIssued> {
    const redis = getRedisConnection();
    const challenge = await redis.get(`webauthn:auth:${attemptId}`);
    if (!challenge) {
      throw new UnauthorizedException({ code: "PASSKEY_CHALLENGE_EXPIRED", message: "That sign-in attempt expired. Please try again." });
    }
    await redis.del(`webauthn:auth:${attemptId}`);

    const [passkey] = await this.db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, response.id)).limit(1);
    if (!passkey) throw new UnauthorizedException({ code: "PASSKEY_NOT_FOUND", message: "That passkey isn't registered with any account." });

    const { rpID, origin } = webauthnRelyingParty();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: Number(passkey.counter) },
      });
    } catch {
      throw new UnauthorizedException({ code: "PASSKEY_VERIFICATION_FAILED", message: "Couldn't verify that passkey." });
    }
    if (!verification.verified) throw new UnauthorizedException({ code: "PASSKEY_VERIFICATION_FAILED", message: "Couldn't verify that passkey." });

    await this.db
      .update(schema.passkeys)
      .set({ counter: String(verification.authenticationInfo.newCounter) })
      .where(eq(schema.passkeys.id, passkey.id));

    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, passkey.userId)).limit(1);
    if (!user || user.status === "deletion_pending" || user.status === "deleted") {
      throw new UnauthorizedException({ code: "ACCOUNT_NOT_FOUND", message: "This account is no longer available." });
    }
    await this.activatePendingHouseholdInvites(user.id, user.email);
    return this.issueSession(user.id, deviceInfo);
  }
}
