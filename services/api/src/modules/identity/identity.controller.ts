import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { AllowDuringDeletion } from "../../common/allow-during-deletion.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { detectPlatform, coercePlatform, type ClientPlatform } from "../../common/platform";
import { loadEnv } from "../../config/env";
import { IdentityService, OAuthNotConfiguredError } from "./identity.service";
import {
  DeleteAccountDtoSchema,
  SignInDtoSchema,
  SignUpDtoSchema,
  SetAiProcessingDtoSchema,
  RegisterPushTokenDtoSchema,
  RefreshSessionDtoSchema,
  ForgotPasswordDtoSchema,
  ResetPasswordDtoSchema,
  type DeleteAccountDto,
  type SignInDto,
  type SignUpDto,
  type SetAiProcessingDto,
  type RegisterPushTokenDto,
  type RefreshSessionDto,
  type ForgotPasswordDto,
  type ResetPasswordDto,
} from "./dto";

const SESSION_COOKIE = "veynlo_session";

@Controller("v1/auth")
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  /**
   * "Pre-launch private testing distribution" (docs/ROADMAP.md) — public (no auth) so the sign-up page
   * can decide, before the visitor has an account, whether to render the invite-code field at all. Only
   * exposes the boolean itself, never any invite detail.
   */
  @Get("config")
  authConfig() {
    return { signUpRequiresInvite: loadEnv().SIGNUP_REQUIRES_INVITE };
  }

  // Tighter than the global 300/60s default — credential-guessing and mass account creation are the
  // realistic abuse patterns on these two routes specifically, so they get their own, much stricter caps.
  @Post("sign-up")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(SignUpDtoSchema))
  async signUp(@Body() dto: SignUpDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signUp(dto, { platform });
    setSessionCookie(res, platform, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  @Post("sign-in")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(SignInDtoSchema))
  async signIn(@Body() dto: SignInDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signIn(dto, { platform });
    setSessionCookie(res, platform, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  /**
   * §28.9 "rate-limit ... forgot-password ... recovery endpoints." Always returns the same generic
   * response regardless of whether the email matched a real account — see
   * `IdentityService.forgotPassword`'s doc comment on why enumeration protection lives there, not here.
   */
  @Post("forgot-password")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(ForgotPasswordDtoSchema))
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.identity.forgotPassword(dto.email);
    return { success: true, message: "If that email is registered, a password reset link has been sent." };
  }

  @Post("reset-password")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(ResetPasswordDtoSchema))
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.identity.resetPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  /**
   * §AUTH rotating refresh-token flow — native (bearer-token) clients only; the web cookie flow has no
   * client-side refresh token to present and keeps working exactly as before. Same throttle tier as
   * sign-in: a refresh token is a credential, and this endpoint is the realistic guessing/replay target
   * for it.
   */
  @Post("refresh")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(RefreshSessionDtoSchema))
  async refresh(@Body() dto: RefreshSessionDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.refreshSession(dto.refreshToken);
    setSessionCookie(res, platform, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  /**
   * §Account/security "Google/Microsoft sign-in" — unlike sign-up/sign-in above, these are real browser
   * navigations the whole way through (the browser leaves the SPA for Google/Microsoft, then gets
   * redirected straight back here by them), so both routes issue real HTTP redirects rather than JSON
   * bodies a full-page navigation would just render as raw text. A native client opens `authorize` in the
   * system browser via `Linking.openURL` (no custom headers possible on that navigation, unlike an
   * authenticated in-app fetch — hence `?platform=` as a query param here, via `coercePlatform`, rather
   * than `detectPlatform`'s header) and gets the session back via a `veynlo://auth-callback` deep link
   * carrying the bearer token, the same "no ambient session, no shared keychain across processes" handback
   * connectors.controller.ts's own OAuth connect flow already established.
   */
  @Get("google/authorize")
  async googleAuthorize(@Query("platform") platformParam: string | undefined, @Res() res: FastifyReply) {
    const env = loadEnv();
    const platform = coercePlatform(platformParam);
    const state = await signOAuthState(platform);
    try {
      const authorizationUrl = this.identity.googleAuthorizationUrl({ redirectUri: `${env.API_PUBLIC_URL}/v1/auth/google/callback`, state });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("google/callback")
  async googleCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      const verified = await verifyOAuthState(state);
      platform = verified.platform;
      if (!code) throw new Error("missing_code");
      const session = await this.identity.handleGoogleCallback(code, `${env.API_PUBLIC_URL}/v1/auth/google/callback`, { platform });
      return this.finishOAuthSignIn(res, env, platform, session);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("microsoft/authorize")
  async microsoftAuthorize(@Query("platform") platformParam: string | undefined, @Res() res: FastifyReply) {
    const env = loadEnv();
    const platform = coercePlatform(platformParam);
    const state = await signOAuthState(platform);
    try {
      const authorizationUrl = this.identity.microsoftAuthorizationUrl({ redirectUri: `${env.API_PUBLIC_URL}/v1/auth/microsoft/callback`, state });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("microsoft/callback")
  async microsoftCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      const verified = await verifyOAuthState(state);
      platform = verified.platform;
      if (!code) throw new Error("missing_code");
      const session = await this.identity.handleMicrosoftCallback(code, `${env.API_PUBLIC_URL}/v1/auth/microsoft/callback`, { platform });
      return this.finishOAuthSignIn(res, env, platform, session);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("apple/authorize")
  async appleAuthorize(@Query("platform") platformParam: string | undefined, @Res() res: FastifyReply) {
    const env = loadEnv();
    const platform = coercePlatform(platformParam);
    const state = await signOAuthState(platform);
    try {
      const authorizationUrl = this.identity.appleAuthorizationUrl({ redirectUri: `${env.API_PUBLIC_URL}/v1/auth/apple/callback`, state });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  // POST, not GET — see appleAuthorizationUrl's doc comment on `response_mode=form_post`. Apple's own
  // redirect back here is still a real browser navigation regardless of HTTP method, so the same
  // deep-link-for-native handback applies.
  @Post("apple/callback")
  async appleCallback(@Body() body: { code?: string; state?: string; user?: string }, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      const verified = await verifyOAuthState(body.state ?? "");
      platform = verified.platform;
      if (!body.code) throw new Error("missing_code");
      const session = await this.identity.handleAppleCallback(body.code, `${env.API_PUBLIC_URL}/v1/auth/apple/callback`, body.user, { platform });
      return this.finishOAuthSignIn(res, env, platform, session);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, platform, err), 302);
    }
  }

  /** Shared by all three providers' callbacks: web keeps its httpOnly cookie + SPA redirect exactly as
   * before; any native platform gets a bearer token instead, handed back via `veynlo://auth-callback` the
   * same way connectors.controller.ts's own callback routes hand back a connector result — see
   * `nativeTokenPayload`'s doc comment for why the token only ever travels this way for non-web clients. */
  private finishOAuthSignIn(res: FastifyReply, env: ReturnType<typeof loadEnv>, platform: ClientPlatform, session: { token: string; refreshToken: string; expiresAt: Date }) {
    if (platform === "web") {
      setSessionCookie(res, "web", session.token, session.expiresAt);
      return res.redirect(`${env.WEB_APP_URL}/home`, 302);
    }
    const params = new URLSearchParams({ token: session.token, refreshToken: session.refreshToken, expiresAt: session.expiresAt.toISOString() });
    return res.redirect(`veynlo://auth-callback?${params.toString()}`, 302);
  }

  @Post("sign-out")
  @UseGuards(AuthGuard)
  @AllowDuringDeletion() // a deletion-pending account can still sign itself out
  async signOut(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: FastifyReply) {
    await this.identity.revokeSession(user.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { success: true };
  }

  @Post("sign-out-everywhere")
  @UseGuards(AuthGuard)
  async signOutEverywhere(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: FastifyReply) {
    await this.identity.revokeAllSessions(user.userId);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { success: true };
  }

  @Post("delete-account")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(DeleteAccountDtoSchema))
  async deleteAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.identity.requestDeletion(user.userId, dto.password);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return {
      success: true,
      message: "Your account is scheduled for deletion in 14 days. Sign back in any time before then to cancel it.",
    };
  }

  /** PRIV-002 grace period — sign back in during the 14-day window and cancel here; see
   * IdentityService.cancelDeletion's doc comment. Marked `@AllowDuringDeletion()` since this is the one
   * mutating route a `deletion_pending` session specifically needs to reach. */
  @Post("cancel-deletion")
  @UseGuards(AuthGuard)
  @AllowDuringDeletion()
  async cancelDeletion(@CurrentUser() user: AuthenticatedUser) {
    await this.identity.cancelDeletion(user.userId);
    return { success: true, message: "Account deletion cancelled. Your account is active again." };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  @AllowDuringDeletion() // the deletion-pending UI needs this to read `status`/`scheduledDeletionAt` and show the countdown/cancel option
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.me(user.userId);
  }

  @Post("ai-processing")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(SetAiProcessingDtoSchema))
  async setAiProcessing(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetAiProcessingDto) {
    await this.identity.setAiProcessingEnabled(user.userId, dto.enabled);
    return { enabled: dto.enabled };
  }

  @Post("push-token")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(RegisterPushTokenDtoSchema))
  async registerPushToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterPushTokenDto) {
    await this.identity.registerPushToken(user.sessionId, dto.pushToken);
    return { success: true };
  }

  @Get("inbound-alias")
  @UseGuards(AuthGuard)
  async inboundAlias(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.inboundAliasInfo(user.userId);
  }

  @Post("inbound-alias/rotate")
  @UseGuards(AuthGuard)
  async rotateInboundAlias(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.rotateInboundAlias(user.userId);
  }

  @Get("sessions")
  @UseGuards(AuthGuard)
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.listSessions(user.userId, user.sessionId);
  }

  // §28.9 "revoke-one" control — sign-out (above) only ever revokes the caller's own current session;
  // this lets a user kill one *other* listed device/session (e.g. a lost phone) without also signing
  // themselves out of the session they're using right now to do it.
  @Post("sessions/:sessionId/revoke")
  @UseGuards(AuthGuard)
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param("sessionId") sessionId: string) {
    await this.identity.revokeSessionById(sessionId, user.userId);
    return { success: true };
  }
}

/** CSRF binding for the google/microsoft authorize→callback round trip — a short-lived signed nonce, not
 * tied to any user (unlike the connector-connect flow's state, there's no signed-in user yet to embed).
 * Carries the requesting client's platform through the same way connectors.controller.ts's own
 * `signConnectState` does — the callback runs on a request FROM Google/Microsoft/Apple, not the original
 * client, so this is the only channel platform can travel through to reach the redirect decision. */
async function signOAuthState(platform: ClientPlatform): Promise<string> {
  const env = loadEnv();
  return new SignJWT({ purpose: "oauth_signin", platform })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
}

async function verifyOAuthState(state: string): Promise<{ platform: ClientPlatform }> {
  if (!state) throw new Error("missing_state");
  const verified = await jwtVerify(state, new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET), { algorithms: ["HS256"] });
  return { platform: coercePlatform((verified.payload as { platform?: string }).platform) };
}

/** Maps a thrown error to an `?error=...` code the sign-in page (web or native) can show a specific
 * message for — web keeps its `/sign-in` page redirect; native gets the same `veynlo://auth-callback`
 * deep link every other outcome of this flow uses, just with `error=` instead of a token. */
function oauthErrorRedirect(env: ReturnType<typeof loadEnv>, platform: ClientPlatform, err: unknown): string {
  let code = "oauth_failed";
  if (err instanceof OAuthNotConfiguredError) {
    code = "oauth_not_configured";
  } else if (err && typeof err === "object" && "getResponse" in err && typeof (err as { getResponse: unknown }).getResponse === "function") {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (response && typeof response === "object" && "code" in response) code = String((response as { code: unknown }).code).toLowerCase();
  }
  if (platform === "web") return `${env.WEB_APP_URL}/sign-in?error=${encodeURIComponent(code)}`;
  return `veynlo://auth-callback?error=${encodeURIComponent(code)}`;
}

/**
 * The raw session token is only ever returned in a JSON body for non-web
 * platforms. Web relies solely on the httpOnly cookie — putting the token
 * in a body a compromised web page's JS could read would defeat the whole
 * point of httpOnly (XSS exfiltration). Native apps have no browser cookie
 * jar to rely on, so they store this in Keychain/Keystore instead.
 */
export function nativeTokenPayload(platform: string, session: { token: string; expiresAt: Date; refreshToken: string }) {
  if (platform === "web") return {};
  return { token: session.token, expiresAt: session.expiresAt.toISOString(), refreshToken: session.refreshToken };
}

/**
 * §CSRF "a request is cookie-authenticated only if a session cookie is actually present." Only the web
 * client should ever receive one — native/extension clients authenticate with a bearer token
 * (`nativeTokenPayload` above already makes exactly this distinction for the response body). This used to
 * set the cookie unconditionally regardless of platform: a browser extension's background-script fetch,
 * granted elevated cross-origin cookie behavior by its own `host_permissions` manifest entry, would
 * silently pick up and store this cookie even though the extension only ever intended to use the bearer
 * token — then every subsequent state-changing request got classified as cookie-authenticated by
 * `csrf.ts`'s `assertCsrfSafe` and 403'd, since the extension (correctly, per the bearer-is-CSRF-exempt
 * design) never sends the CSRF header. Net effect: the extension's "Save this page"/"Save selection"
 * actions were completely broken after the very first sign-in, for every real user, in real Chrome — found
 * live via a real Playwright-driven extension load, not caught by any prior curl-based verification (a raw
 * HTTP replay has no persistent cookie jar and can't reproduce a browser's automatic cookie storage).
 */
export function setSessionCookie(res: FastifyReply, platform: string, token: string, expiresAt: Date) {
  if (platform !== "web") return;
  const env = loadEnv();
  res.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}
