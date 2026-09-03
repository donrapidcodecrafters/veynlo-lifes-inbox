import { BadRequestException, ConflictException, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as argon2 from "argon2";
import { SignJWT, createRemoteJWKSet, jwtVerify, importPKCS8 } from "jose";
import { google } from "googleapis";
import { generateId } from "@veynlo/core";
// Server-only Node util (bare `node:crypto` import) — imported from its own subpath, never through the
// main `@veynlo/core` barrel, so a client bundle that imports anything else from that barrel never
// transitively pulls this in. See packages/core/src/index.ts's own doc comment for the live bug this fixes.
import { generateOpaqueToken, hashOpaqueToken } from "@veynlo/core/dist/util/token";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured, isAppleSignInConfigured, isInboundEmailConfigured } from "../../config/env";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { MailerService } from "../notifications/mailer.service";
import { OnboardingService } from "../onboarding/onboarding.service";
import { AnalyticsService, toAnalyticsPlatform } from "../analytics/analytics.service";
import type { SignInDto, SignUpDto } from "./dto";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days; short-lived-enough with server-side revocation as the real control
const REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days from original sign-in, never extended by a refresh

// PRIV-002 "grace period if used" — 14 days: long enough to cover someone who deleted their account in a
// moment of frustration or by mistake and comes back the next time they happen to open the app (weekly-
// brief cadence is 7 days — see QueueProducerService.scheduleRecurringNotificationDispatch — so this
// spans at least one of those), short enough that "scheduled for deletion" doesn't mean indefinitely.
const DELETION_GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

// Thin, semantically-named wrappers around the shared opaque-token helper (also used by
// household.service.ts's invite-accept flow) — kept as local names since call sites throughout this file
// read as "refresh token" specifically, even though the underlying generation/hashing is generic.
const generateRefreshToken = generateOpaqueToken;
const hashRefreshToken = hashOpaqueToken;

const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OIDC_SCOPES = "openid email profile";

// §28.8 "validate JWT ... signature" — Microsoft's id_token used to be decoded with no signature check at
// all (only Google's used real verification, via googleapis' verifyIdToken). Fixed 2026-08-31: the
// "common" multi-tenant JWKS endpoint publishes the keys needed to verify any Microsoft/Outlook personal
// or work/school account's id_token regardless of which tenant issued it — the documented approach for a
// multi-tenant app that isn't restricted to one specific organization. `createRemoteJWKSet` caches the
// key set and handles rotation (re-fetches on an unrecognized `kid`) internally.
const MICROSOFT_JWKS = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));

const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

export class OAuthNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} sign-in is not configured on this deployment (missing OAuth client credentials).`);
    this.name = "OAuthNotConfiguredError";
  }
}

/** An opaque routing token — deliberately not the userId itself, so a leaked/spammed alias can be
 * rotated without exposing the internal id in an externally-forwarded address. */
function generateInboundAlias(): string {
  return `u-${randomBytes(8).toString("hex")}`;
}

export interface SessionIssued {
  token: string;
  expiresAt: Date;
  userId: string;
  refreshToken: string;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    private readonly mailer: MailerService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    // §48 product analytics — optional/trailing (like `memories`/`documents`/etc. in IngestionService's own
    // constructor) so the many existing tests across other modules that construct IdentityService
    // positionally (emergency-binder, preferences, sharing, identity-records, health-logistics,
    // notifications, widgets — not just this module's own tests) don't all need updating for an
    // analytics-only concern. `this.analytics?.track(...)` below is simply a no-op when undefined.
    @Inject(AnalyticsService) private readonly analytics?: AnalyticsService,
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
    const userValues = {
      id: userId,
      email: dto.email,
      displayName: dto.displayName,
      timezone: dto.timezone,
      passwordHash,
      status: "active" as const,
      inboundEmailAlias: generateInboundAlias(),
    };

    // "Pre-launch private testing distribution" (docs/ROADMAP.md). Default OFF (see env.ts) — this branch
    // never runs, and sign-up behaves exactly as it always has, unless a deployment explicitly opts in.
    if (loadEnv().SIGNUP_REQUIRES_INVITE) {
      if (!dto.inviteCode) {
        throw new BadRequestException({ code: "INVITE_CODE_REQUIRED", message: "An invite code is required to sign up." });
      }
      const codeHash = hashRefreshToken(dto.inviteCode); // same sha256(raw)-hex scheme AdminService uses to hash it at creation

      await this.db.transaction(async (tx) => {
        // Serializes concurrent redemption attempts of the SAME code — same TOCTOU discipline as
        // household.service.ts's invite() (pg_advisory_xact_lock) — so two requests racing to redeem a
        // single-use code can't both read it as "not yet redeemed" before either's UPDATE commits.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${codeHash}))`);

        const [invite] = await tx.select().from(schema.signupInvites).where(eq(schema.signupInvites.codeHash, codeHash)).limit(1);
        if (!invite) {
          throw new BadRequestException({ code: "INVALID_INVITE_CODE", message: "This invite code is invalid." });
        }
        if (invite.revokedAt) {
          throw new BadRequestException({ code: "INVITE_REVOKED", message: "This invite code has been revoked." });
        }
        if (invite.redeemedAt) {
          throw new BadRequestException({ code: "INVITE_ALREADY_REDEEMED", message: "This invite code has already been used." });
        }
        if (invite.expiresAt && invite.expiresAt < new Date()) {
          throw new BadRequestException({ code: "INVITE_EXPIRED", message: "This invite code has expired." });
        }
        if (invite.email && invite.email !== dto.email) {
          throw new BadRequestException({ code: "INVITE_EMAIL_MISMATCH", message: "This invite code is bound to a different email address." });
        }

        // The user row has to exist before this UPDATE runs — redeemedByUserId's FK is checked per-
        // statement, not deferred to commit, so it can't point at a not-yet-inserted row even inside the
        // same transaction.
        await tx.insert(schema.users).values(userValues);
        await tx.update(schema.signupInvites).set({ redeemedAt: new Date(), redeemedByUserId: userId }).where(eq(schema.signupInvites.id, invite.id));
      });
    } else {
      await this.db.insert(schema.users).values(userValues);
    }

    await this.db.insert(schema.identityLinks).values({
      id: generateId("identityLink"),
      userId,
      provider: "email",
      providerSubject: dto.email,
    });
    await this.db.insert(schema.notificationPreferences).values({ userId });
    // ONB-001 "value-first onboarding" — created here, at account creation, never lazily on read (see
    // OnboardingService.initializeForNewUser's doc comment on why that matters for pre-existing accounts).
    await this.onboarding.initializeForNewUser(userId);
    await this.recordAuditEvent("user", userId, "user.sign_up", "user", userId, "success");
    // §48.1 Activation "install→signup" — the very first product event a real account can ever have.
    await this.analytics?.track("signup_completed", { userId, platform: toAnalyticsPlatform(deviceInfo.platform) });

    return this.issueSession(userId, deviceInfo);
  }

  async signIn(dto: SignInDto, deviceInfo: { platform: string; displayName?: string }): Promise<SessionIssued> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, dto.email)).limit(1);
    if (!user || !user.passwordHash) {
      await this.recordAuditEvent("system", null, "user.sign_in", "user", dto.email, "failure");
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.recordAuditEvent("user", user.id, "user.sign_in", "user", user.id, "failure");
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
    }
    if (user.status === "deleted") {
      // Correct credentials, but re-authenticating into an account whose data is actively being torn down
      // in the background would just create a new session for it — reject rather than race it.
      await this.recordAuditEvent("user", user.id, "user.sign_in", "user", user.id, "denied");
      throw new UnauthorizedException({ code: "ACCOUNT_DELETED", message: "This account has been deleted." });
    }
    // PRIV-002 "grace period if used" — unlike `deleted` above, a `deletion_pending` account is
    // DELIBERATELY allowed to sign in: the grace period only means anything if the user can get back in to
    // cancel it. AuthGuard's own `deletion_pending` branch is what actually restricts the resulting
    // session to the small allowlist of routes that matters (cancel-deletion, `/me`, sign-out) — this
    // method just needs to not reject the sign-in itself.
    if (user.status === "suspended") {
      // Without this, a suspended user could still complete sign-in and receive a brand-new session — it
      // would immediately fail on their very next request (AuthGuard's own "suspended" check), but there's
      // no reason to let it succeed here just to fail one request later, and "Incorrect email or password"
      // (the alternative if this check didn't exist and something else rejected silently) would be a
      // actively misleading error for a suspended account to see.
      await this.recordAuditEvent("user", user.id, "user.sign_in", "user", user.id, "denied");
      throw new UnauthorizedException({ code: "ACCOUNT_SUSPENDED", message: "This account has been suspended." });
    }
    await this.recordAuditEvent("user", user.id, "user.sign_in", "user", user.id, "success");
    return this.issueSession(user.id, deviceInfo);
  }

  /**
   * §45 "least privilege... audited access" already covers admin actions (AdminService.recordAccess) and
   * account deletion (worker-main.ts); sign-in itself had zero audit trail anywhere — found live via a
   * real audit that a failed-credentials brute-force attempt against a real account left no trace at all.
   * A failed attempt with no matching account still gets a row (actorType "system", since there's no real
   * user to attribute it to) — the attempted email as `resourceId` is deliberate here despite the *error
   * message* to the caller staying generic (§28.8, no account-enumeration signal) — this trail is
   * admin/security-facing, not user-facing, and knowing which address was targeted is the point.
   */
  private async recordAuditEvent(
    actorType: "user" | "system",
    actorId: string | null,
    action: string,
    resourceType: string,
    resourceId: string,
    result: "success" | "failure" | "denied",
  ): Promise<void> {
    await this.db.insert(schema.auditEvents).values({ id: generateId("auditEvent"), actorType, actorId, action, resourceType, resourceId, result });
  }

  /**
   * §28.9 "no security questions; account recovery must not be weaker than normal authentication" — this
   * was a real, previously-missing gap: a user with a local password and no way to recover it if
   * forgotten had no path back into their account short of deleting and recreating it. Always behaves
   * identically whether or not the email matches a real, password-having, active account — the response
   * (and timing/shape) must not let a caller distinguish "sent" from "no such account" (§28.8 "return
   * generic authorization errors where detail would help enumerate accounts").
   */
  async forgotPassword(email: string): Promise<void> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (!user || !user.passwordHash || user.status !== "active") {
      return;
    }

    const rawToken = generateRefreshToken(); // same high-entropy (32 random bytes, base64url) shape as a session refresh token
    await this.db.insert(schema.passwordResetTokens).values({
      id: generateId("passwordResetToken"),
      userId: user.id,
      tokenHash: hashRefreshToken(rawToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour — short-lived per §28.9
    });

    const resetUrl = `${loadEnv().WEB_APP_URL}/reset-password?token=${rawToken}`;
    try {
      await this.mailer.send({
        to: email,
        subject: "Reset your Veynlo password",
        text: `Someone requested a password reset for this Veynlo account. If this was you, reset your password here (link expires in 1 hour): ${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your password hasn't changed.`,
        html: `<p>Someone requested a password reset for this Veynlo account.</p><p>If this was you, <a href="${resetUrl}">reset your password</a> (link expires in 1 hour).</p><p>If you didn't request this, you can safely ignore this email — your password hasn't changed.</p>`,
      });
    } catch (err) {
      // Deliberately swallowed, not rethrown — the caller must see the same generic response either way
      // (see this method's doc comment on why), so a transient SMTP failure is an ops concern (logged),
      // not something that should leak "this email exists but sending failed" back to the requester.
      this.logger.error(`Failed to send password-reset email: ${String(err)}`);
    }
  }

  /**
   * The reset token is single-use (`usedAt`) and hashed at rest (only ever compared by hash, same as a
   * refresh token). On success, every existing session is revoked — a password reset is exactly the
   * moment an account may have just been recovered from a real compromise, so anything an attacker was
   * already signed into stops working immediately rather than surviving the reset.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashRefreshToken(token);
    const [resetToken] = await this.db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.tokenHash, tokenHash)).limit(1);
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
      throw new BadRequestException({ code: "INVALID_RESET_TOKEN", message: "This reset link is invalid or has expired. Please request a new one." });
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, resetToken.userId));
    await this.db.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, resetToken.id));
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, resetToken.userId), isNull(schema.sessions.revokedAt)));
  }

  /**
   * AUTH-001 "create passkey" — a passkey sign-in is just another way to establish the SAME session
   * mechanism email/OAuth sign-in already use, not a parallel auth system (see PasskeyService.
   * verifyAuthentication, the only external caller of this thin public wrapper around the otherwise-
   * private `issueSession`). Kept separate from `issueSession` itself rather than just widening its
   * visibility, so every other private helper on this class stays private and this one intentional
   * cross-module entry point is easy to find.
   */
  async issueSessionForExternalAuth(userId: string, deviceInfo: { platform: string; displayName?: string }): Promise<SessionIssued> {
    return this.issueSession(userId, deviceInfo);
  }

  private async issueSession(
    userId: string,
    deviceInfo: { platform: string; displayName?: string },
  ): Promise<SessionIssued> {
    const deviceId = generateId("device");
    await this.db.insert(schema.devices).values({
      id: deviceId,
      userId,
      platform: deviceInfo.platform,
      displayName: deviceInfo.displayName ?? null,
      trusted: false,
    });

    // §35 SHARE-006 legacy-release inactivity trigger — a fresh sign-in is unambiguously real activity;
    // see auth.guard.ts's own doc comment for the other two touchpoints (ordinary authenticated requests,
    // token refresh) that keep this current between sign-ins.
    await this.db.update(schema.users).set({ lastActiveAt: new Date() }).where(eq(schema.users.id, userId));

    const sessionId = generateId("session");
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshToken = generateRefreshToken();
    await this.db.insert(schema.sessions).values({
      id: sessionId,
      userId,
      deviceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS * 1000),
      expiresAt,
    });

    const token = await this.signAccessToken(userId, sessionId, expiresAt);

    return { token, expiresAt, userId, refreshToken };
  }

  private async signAccessToken(userId: string, sessionId: string, expiresAt: Date): Promise<string> {
    return new SignJWT({ sub: userId, sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
  }

  /**
   * §AUTH "rotating refresh-token flow" — mobile clients hold a long-lived (60-day absolute cap) refresh
   * token alongside the short-er-lived access-token session so they aren't forced to re-authenticate with
   * a password every 14 days, without making the access token itself effectively permanent. Every call
   * rotates: the presented token is invalidated and a new one issued, extending the *access* token's
   * expiry but never the refresh chain's absolute cap.
   *
   * Reuse detection: `previousRefreshTokenHash` holds exactly the token this call just rotated away. If a
   * later call presents THAT token again, it can only mean one of two things — a client retried a
   * response it never actually received (the new token was issued but lost in transit), or someone is
   * replaying a stolen, already-superseded token. Both are treated the same conservative way: the session
   * is revoked outright rather than silently re-honored, because there's no reliable way from the server
   * side to tell a lost-response retry from a real theft, and staying logged in is not worth the risk of
   * quietly ignoring the second case. A legitimate client that lost its response will simply need to sign
   * in again — the cost of a false positive here is an extra sign-in, not a silent security hole.
   */
  async refreshSession(presentedToken: string): Promise<SessionIssued> {
    const presentedHash = hashRefreshToken(presentedToken);
    const [session] = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.refreshTokenHash, presentedHash))
      .limit(1);

    if (!session) {
      const [reused] = await this.db
        .select({ id: schema.sessions.id, revokedAt: schema.sessions.revokedAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.previousRefreshTokenHash, presentedHash))
        .limit(1);
      if (reused && !reused.revokedAt) {
        await this.db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, reused.id));
      }
      throw new UnauthorizedException({ code: "INVALID_REFRESH_TOKEN", message: "This session can no longer be refreshed. Please sign in again." });
    }
    if (session.revokedAt) {
      throw new UnauthorizedException({ code: "SESSION_REVOKED", message: "This session was revoked. Please sign in again." });
    }
    if (!session.refreshExpiresAt || session.refreshExpiresAt < new Date()) {
      throw new UnauthorizedException({ code: "REFRESH_EXPIRED", message: "This session has expired. Please sign in again." });
    }

    const newRefreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshedAt = new Date();
    await this.db
      .update(schema.sessions)
      .set({
        refreshTokenHash: hashRefreshToken(newRefreshToken),
        previousRefreshTokenHash: presentedHash,
        expiresAt,
        lastSeenAt: refreshedAt,
      })
      .where(eq(schema.sessions.id, session.id));
    // §35 SHARE-006 legacy-release inactivity trigger — see auth.guard.ts's own doc comment; a token
    // refresh is real activity regardless of how the ordinary-request throttle in that guard is timed.
    await this.db.update(schema.users).set({ lastActiveAt: refreshedAt }).where(eq(schema.users.id, session.userId));

    const token = await this.signAccessToken(session.userId, session.id, expiresAt);
    return { token, expiresAt, userId: session.userId, refreshToken: newRefreshToken };
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

    // Real signature verification against Microsoft's own published keys (see MICROSOFT_JWKS above) —
    // `audience` confirms the token was actually issued for *this* app's client id, not merely signed by
    // Microsoft for some other application. `issuer` isn't pinned to one value here because this is a
    // multi-tenant "sign in with any Microsoft account" flow (`common` endpoint) — the real issuer varies
    // per tenant (`https://login.microsoftonline.com/{tid}/v2.0`), which is expected, not a gap.
    let payload: { sub?: string; oid?: string; email?: string; preferred_username?: string; name?: string };
    try {
      const verified = await jwtVerify(json.id_token, MICROSOFT_JWKS, { audience: env.MICROSOFT_OAUTH_CLIENT_ID });
      payload = verified.payload as typeof payload;
    } catch (err) {
      this.logger.warn(`Microsoft id_token verification failed: ${String(err)}`);
      throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Microsoft identity." });
    }
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

  isAppleSignInConfigured(): boolean {
    return isAppleSignInConfigured();
  }

  /**
   * Apple's authorize step, unlike Google/Microsoft's, always responds via a top-level POST back to
   * `redirectUri` (`response_mode=form_post`) rather than a GET with query params whenever `name`/`email`
   * scopes are requested — Apple's own requirement, not a choice made here — so the controller's Apple
   * callback route must accept a POST with a form body, not a GET with query params like the other two.
   */
  appleAuthorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isAppleSignInConfigured()) throw new OAuthNotConfiguredError("apple");
    const env = loadEnv();
    const url = new URL(APPLE_AUTHORIZE_URL);
    url.searchParams.set("client_id", env.APPLE_CLIENT_ID!);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("scope", "name email");
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  /**
   * Apple doesn't accept a static `client_secret` string — it requires a short-lived ES256-signed JWT
   * minted fresh per request (`iss`=Team ID, `sub`=the Services ID/client_id, signed with the private key
   * from the .p8 downloaded once when the Sign in with Apple key was created in the Apple Developer
   * portal). A 5-minute expiry is deliberately short: Apple allows up to 6 months, but there's no reason
   * to mint one that outlives the single token-exchange call it's used for.
   */
  private async generateAppleClientSecret(): Promise<string> {
    const env = loadEnv();
    const privateKey = await importPKCS8(env.APPLE_PRIVATE_KEY!, "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
      .setIssuer(env.APPLE_TEAM_ID!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience(APPLE_ISSUER)
      .setSubject(env.APPLE_CLIENT_ID!)
      .sign(privateKey);
  }

  /**
   * `appleUser` is the raw value of Apple's separate `user` form field — a JSON string Apple sends ONLY on
   * the very first authorization for a given Apple ID + this app (never on a repeat sign-in), containing
   * `{ name: { firstName, lastName }, email }`. There is no other point at which a display name is ever
   * available for an Apple sign-in, so it's captured here or not at all.
   */
  async handleAppleCallback(code: string, redirectUri: string, appleUser: string | undefined, deviceInfo: { platform: string }): Promise<SessionIssued> {
    if (!this.isAppleSignInConfigured()) throw new OAuthNotConfiguredError("apple");
    const env = loadEnv();
    const clientSecret = await this.generateAppleClientSecret();
    const body = new URLSearchParams({
      client_id: env.APPLE_CLIENT_ID!,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const response = await fetch(APPLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) {
      throw new UnauthorizedException({ code: "OAUTH_TOKEN_EXCHANGE_FAILED", message: "Couldn't complete Apple sign-in." });
    }
    const json = (await response.json()) as { id_token?: string };
    if (!json.id_token) throw new UnauthorizedException({ code: "OAUTH_NO_ID_TOKEN", message: "Apple didn't return an identity token." });

    let payload: { sub?: string; email?: string };
    try {
      const verified = await jwtVerify(json.id_token, APPLE_JWKS, { audience: env.APPLE_CLIENT_ID, issuer: APPLE_ISSUER });
      payload = verified.payload as typeof payload;
    } catch (err) {
      this.logger.warn(`Apple id_token verification failed: ${String(err)}`);
      throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Apple identity." });
    }
    if (!payload.sub) throw new UnauthorizedException({ code: "OAUTH_INVALID_TOKEN", message: "Couldn't verify your Apple identity." });

    let displayName = payload.email ?? "Veynlo user";
    if (appleUser) {
      try {
        const parsed = JSON.parse(appleUser) as { name?: { firstName?: string; lastName?: string } };
        const fullName = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(" ");
        if (fullName) displayName = fullName;
      } catch {
        // Malformed `user` field — fall back to the email-derived name above rather than failing sign-in over it.
      }
    }

    return this.oauthSignIn({ provider: "apple", providerSubject: payload.sub, email: payload.email ?? null, displayName }, deviceInfo);
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
    rawParams: { provider: string; providerSubject: string; email: string | null; displayName: string },
    deviceInfo: { platform: string },
  ): Promise<SessionIssued> {
    // Real bug found via live audit: an unnormalized OAuth-provider email (case varies by provider) could
    // both fail to match an existing password account AND create a second, differently-cased duplicate —
    // same root cause as NormalizedEmailSchema fixes for the DTO-driven paths below.
    const params = { ...rawParams, email: rawParams.email ? rawParams.email.trim().toLowerCase() : null };
    const [link] = await this.db
      .select()
      .from(schema.identityLinks)
      .where(and(eq(schema.identityLinks.provider, params.provider), eq(schema.identityLinks.providerSubject, params.providerSubject)))
      .limit(1);

    if (link) {
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, link.userId)).limit(1);
      if (!user) throw new UnauthorizedException({ code: "ACCOUNT_NOT_FOUND", message: "This sign-in method isn't linked to an account anymore." });
      // PRIV-002 — same "deletion_pending can sign in, deleted can't" split as the password path above.
      if (user.status === "deleted") {
        throw new UnauthorizedException({ code: "ACCOUNT_DELETED", message: "This account has been deleted." });
      }
      // Same reasoning as the password-sign-in path's identical check above — an OAuth sign-in must not
      // hand a suspended account a fresh session either.
      if (user.status === "suspended") {
        throw new UnauthorizedException({ code: "ACCOUNT_SUSPENDED", message: "This account has been suspended." });
      }
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
    // ONB-001 — same first-run onboarding row as password sign-up above; a brand-new account is a brand-
    // new account regardless of which auth method created it.
    await this.onboarding.initializeForNewUser(userId);

    return this.issueSession(userId, deviceInfo);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
  }

  /** §28.9 "Maintain a user-visible session/device list and provide revoke-one and revoke-all controls" —
   * revoke-all already existed; this is the missing revoke-one-by-id, scoped to the requesting user so one
   * account can never revoke another's session by guessing/enumerating an ID. Silently no-ops if the id
   * doesn't belong to this user or is already revoked, same "idempotent, no information leak" posture as
   * revokeAllSessions above. */
  async revokeSessionById(sessionId: string, requestingUserId: string): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, requestingUserId), isNull(schema.sessions.revokedAt)));
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

  /**
   * Round-3 audit fix: `currentSessionId` marks which row is the caller's OWN session, via `isCurrent`
   * below. Found live during a real two-"device" security-page walkthrough: every row here rendered as an
   * identical "Web browser" / same-second timestamp card (this repo's dev environment issues every session
   * a bare `devices` row with no `displayName`, and two browser contexts on the same OS both get
   * `platform: "web"`), with nothing distinguishing "the session you're looking at this page from" from
   * any other — the exact device list this method's own doc comment says a revoke-one control needs to
   * avoid being ("a device/session list nobody can actually tell apart"). A user genuinely signed in twice
   * on the same platform (two tabs, a laptop + desktop browser, an incognito window) had no way to tell
   * which row was safe to leave alone vs. which was the "other" device they meant to kick.
   */
  async listSessions(userId: string, currentSessionId: string) {
    // Joined with devices for a real "iPhone" / "Chrome on Mac"-shaped label — the session row alone has
    // no human-readable identity, and a device/session list nobody can actually tell apart isn't a usable
    // revoke-one control (§28.9).
    const rows = await this.db
      .select({
        id: schema.sessions.id,
        deviceId: schema.sessions.deviceId,
        createdAt: schema.sessions.createdAt,
        lastSeenAt: schema.sessions.lastSeenAt,
        expiresAt: schema.sessions.expiresAt,
        revokedAt: schema.sessions.revokedAt,
        platform: schema.devices.platform,
        displayName: schema.devices.displayName,
      })
      .from(schema.sessions)
      .leftJoin(schema.devices, eq(schema.devices.id, schema.sessions.deviceId))
      .where(eq(schema.sessions.userId, userId));
    return rows.map((row) => ({ ...row, isCurrent: row.id === currentSessionId }));
  }

  /**
   * §28.9 "Step-up/recent authentication required for: ... export all data ... connect/disconnect
   * financial/email accounts ..." — the shared re-verification check for exactly that class of action.
   * Deliberately a no-op for an OAuth-only account (`passwordHash` null): this app has no MFA/passkeys, so
   * a password is the only step-up factor available, and an account that never had one has nothing to
   * re-verify — its actual auth boundary is the OAuth provider plus this session, both already enforced by
   * `AuthGuard` before this ever runs. Requiring a password from an account that can't have one would lock
   * every OAuth-only user out of the action entirely, not add security.
   */
  async verifyStepUpPassword(userId: string, password: string | undefined): Promise<void> {
    const [user] = await this.db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user?.passwordHash) return;
    if (!password) {
      throw new UnauthorizedException({ code: "PASSWORD_REQUIRED", message: "Re-enter your password to continue." });
    }
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
    }
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
    if (!user) throw new UnauthorizedException({ code: "INVALID_CREDENTIALS", message: "Incorrect password." });
    // Same step-up check every other sensitive action uses (§28.9) — a no-op for an OAuth-only account,
    // which previously made self-service deletion permanently impossible for those users (see dto.ts).
    await this.verifyStepUpPassword(userId, password);
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

    // PRIV-002 "grace period if used" — previously this enqueued the destructive worker with NO delay at
    // all (`deletedAt` was set, but nothing about the job's timing respected it), contradicting the spec's
    // own "grace period if used" framing. Now: the account becomes immediately inaccessible for anything
    // except the small `@AllowDuringDeletion()` allowlist (AuthGuard's own doc comment), the actual
    // destructive job doesn't fire until `scheduledDeletionAt`, and IdentityService.cancelDeletion can
    // pull it back before then.
    const scheduledDeletionAt = new Date(Date.now() + DELETION_GRACE_PERIOD_MS);
    await this.db
      .update(schema.users)
      .set({ status: "deletion_pending", deletedAt: new Date(), scheduledDeletionAt })
      .where(eq(schema.users.id, userId));
    await this.revokeAllSessions(userId);
    await this.queue.enqueueAccountDeletion({ userId }, DELETION_GRACE_PERIOD_MS);
  }

  /**
   * PRIV-002 "grace period if used" — the cancel half. Works any time before `scheduledDeletionAt`
   * (in practice, any time the account is still `deletion_pending` at all — once the worker actually runs
   * it flips status to "deleted"/removes the row, so a `deletion_pending` account by definition hasn't been
   * torn down yet). Idempotent-ish: called on an account that isn't currently pending deletion just no-ops
   * rather than erroring, since a double-click or a stale page reload retrying this is a real, harmless
   * case, not a bug worth surfacing to the user.
   */
  async cancelDeletion(userId: string): Promise<void> {
    const [user] = await this.db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user || user.status !== "deletion_pending") return;
    await this.db
      .update(schema.users)
      .set({ status: "active", scheduledDeletionAt: null, deletedAt: null })
      .where(eq(schema.users.id, userId));
    // The actual safety property this whole feature is for: the destructive worker job must never fire for
    // an account that cancelled in time. Removing the still-delayed BullMQ job (rather than relying solely
    // on the DB flip above) means the test for this can assert against the queue's own state, not just the
    // row — see queue-producer.interface.ts's `cancelAccountDeletion` doc comment for what happens if the
    // job already started.
    await this.queue.cancelAccountDeletion(userId);
    await this.recordAuditEvent("user", userId, "user.cancel_deletion", "user", userId, "success");
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
