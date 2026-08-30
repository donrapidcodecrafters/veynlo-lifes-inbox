import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SignJWT, jwtVerify } from "jose";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";
import { IdentityService, OAuthNotConfiguredError } from "./identity.service";
import {
  DeleteAccountDtoSchema,
  SignInDtoSchema,
  SignUpDtoSchema,
  ForgotPasswordDtoSchema,
  ResetPasswordDtoSchema,
  SetAiProcessingDtoSchema,
  SetDisabledMailCategoriesDtoSchema,
  SetDataRetentionDaysDtoSchema,
  RegisterPushTokenDtoSchema,
  NativeOAuthSignInDtoSchema,
  PasskeyRegisterDtoSchema,
  PasskeyAuthenticateDtoSchema,
  SetPermittedInboundSendersDtoSchema,
  type DeleteAccountDto,
  type SignInDto,
  type SignUpDto,
  type ForgotPasswordDto,
  type ResetPasswordDto,
  type SetAiProcessingDto,
  type SetDisabledMailCategoriesDto,
  type SetDataRetentionDaysDto,
  type RegisterPushTokenDto,
  type NativeOAuthSignInDto,
  type PasskeyRegisterDto,
  type PasskeyAuthenticateDto,
  type SetPermittedInboundSendersDto,
} from "./dto";

const SESSION_COOKIE = "veynlo_session";

@Controller("v1/auth")
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  // Tighter than the global 300/60s default — credential-guessing and mass account creation are the
  // realistic abuse patterns on these two routes specifically, so they get their own, much stricter caps.
  @Post("sign-up")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(SignUpDtoSchema))
  async signUp(@Body() dto: SignUpDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signUp(dto, { platform });
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  @Post("sign-in")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(SignInDtoSchema))
  async signIn(@Body() dto: SignInDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signIn(dto, { platform });
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  /**
   * §5 "account recovery" — throttled tighter than sign-in itself: this route's realistic abuse pattern is
   * mass-emailing reset links to addresses the caller doesn't own, not credential-guessing. Always returns
   * the same generic success regardless of whether the email matches an account (IdentityService.
   * requestPasswordReset is itself silent on this too) — an enumerable "no account with that email" error
   * would leak which emails have accounts here at all.
   */
  @Post("forgot-password")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(ForgotPasswordDtoSchema))
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.identity.requestPasswordReset(dto.email);
    return { success: true, message: "If that email has an account, a reset link is on its way." };
  }

  @Post("reset-password")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(ResetPasswordDtoSchema))
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.identity.resetPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  /**
   * §Account/security "Google/Microsoft sign-in" — unlike sign-up/sign-in above, these are real browser
   * navigations the whole way through (the browser leaves the SPA for Google/Microsoft, then gets
   * redirected straight back here by them), so both routes issue real HTTP redirects rather than JSON
   * bodies a full-page navigation would just render as raw text. Web-only for now: a native app would need
   * to open this in the system browser and get a deep-link handback to receive the session, which nothing
   * in this app does yet for ANY OAuth flow (see the identical, already-documented limitation on connector
   * connect) — tracked as a follow-up, not attempted here.
   */
  @Get("google/authorize")
  async googleAuthorize(@Res() res: FastifyReply) {
    const env = loadEnv();
    const state = await signOAuthState();
    try {
      const authorizationUrl = this.identity.googleAuthorizationUrl({ redirectUri: `${env.API_PUBLIC_URL}/v1/auth/google/callback`, state });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, err), 302);
    }
  }

  @Get("google/callback")
  async googleCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      await verifyOAuthState(state);
      if (!code) throw new Error("missing_code");
      const session = await this.identity.handleGoogleCallback(code, `${env.API_PUBLIC_URL}/v1/auth/google/callback`, { platform: "web" });
      setSessionCookie(res, session.token, session.expiresAt);
      return res.redirect(`${env.WEB_APP_URL}/home`, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, err), 302);
    }
  }

  @Get("microsoft/authorize")
  async microsoftAuthorize(@Res() res: FastifyReply) {
    const env = loadEnv();
    const state = await signOAuthState();
    try {
      const authorizationUrl = this.identity.microsoftAuthorizationUrl({ redirectUri: `${env.API_PUBLIC_URL}/v1/auth/microsoft/callback`, state });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, err), 302);
    }
  }

  @Get("microsoft/callback")
  async microsoftCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      await verifyOAuthState(state);
      if (!code) throw new Error("missing_code");
      const session = await this.identity.handleMicrosoftCallback(code, `${env.API_PUBLIC_URL}/v1/auth/microsoft/callback`, { platform: "web" });
      setSessionCookie(res, session.token, session.expiresAt);
      return res.redirect(`${env.WEB_APP_URL}/home`, 302);
    } catch (err) {
      return res.redirect(oauthErrorRedirect(env, err), 302);
    }
  }

  /**
   * §Account/security "Sign in with Apple"/"Sign in with Google" (native) — unlike the google/microsoft
   * authorize→callback redirect pair above, these take a POST with an already-signed identity token from
   * the mobile app's on-device auth sheet (expo-apple-authentication / native Google Sign-In) rather than
   * a browser round trip, so they respond with the same JSON session shape as sign-up/sign-in instead of a
   * redirect.
   */
  @Post("apple/sign-in")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(NativeOAuthSignInDtoSchema))
  async appleSignIn(@Body() dto: NativeOAuthSignInDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await rethrowOAuthNotConfigured(() => this.identity.verifyAppleIdentityToken(dto.identityToken, { platform }));
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  @Post("google/native-sign-in")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(NativeOAuthSignInDtoSchema))
  async googleNativeSignIn(@Body() dto: NativeOAuthSignInDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await rethrowOAuthNotConfigured(() => this.identity.verifyGoogleNativeIdentityToken(dto.identityToken, { platform }));
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  /**
   * §5 "account recovery"/Devices & security "Passkeys" — a usernameless WebAuthn sign-in, so these two
   * live here alongside the other unauthenticated sign-in routes rather than under the authed passkey
   * management routes below. See IdentityService.generatePasskeyAuthenticationOptions/
   * verifyPasskeyAuthentication for why there's no username step.
   */
  @Post("passkeys/authentication-options")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async passkeyAuthenticationOptions() {
    return this.identity.generatePasskeyAuthenticationOptions();
  }

  @Post("passkeys/authenticate")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(PasskeyAuthenticateDtoSchema))
  async passkeyAuthenticate(@Body() dto: PasskeyAuthenticateDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.verifyPasskeyAuthentication(dto.attemptId, dto.response as AuthenticationResponseJSON, { platform });
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  @Post("sign-out")
  @UseGuards(AuthGuard)
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
    return { success: true, message: "Your account is scheduled for deletion." };
  }

  @Get("me")
  @UseGuards(AuthGuard)
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

  @Post("disabled-mail-categories")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(SetDisabledMailCategoriesDtoSchema))
  async setDisabledMailCategories(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetDisabledMailCategoriesDto) {
    await this.identity.setDisabledMailCategories(user.userId, dto.categories);
    return { categories: dto.categories };
  }

  @Post("data-retention")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(SetDataRetentionDaysDtoSchema))
  async setDataRetentionDays(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetDataRetentionDaysDto) {
    await this.identity.setDataRetentionDays(user.userId, dto.days);
    return { days: dto.days };
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

  @Get("inbound-alias/permitted-senders")
  @UseGuards(AuthGuard)
  async permittedInboundSenders(@CurrentUser() user: AuthenticatedUser) {
    return { senders: await this.identity.getPermittedInboundSenders(user.userId) };
  }

  @Post("inbound-alias/permitted-senders")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(SetPermittedInboundSendersDtoSchema))
  async setPermittedInboundSenders(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetPermittedInboundSendersDto) {
    return { senders: await this.identity.setPermittedInboundSenders(user.userId, dto.senders) };
  }

  @Get("sessions")
  @UseGuards(AuthGuard)
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.listSessions(user.userId, user.sessionId);
  }

  @Post("sessions/:sessionId/revoke")
  @UseGuards(AuthGuard)
  async revokeOneSession(@CurrentUser() user: AuthenticatedUser, @Param("sessionId") sessionId: string) {
    await this.identity.revokeOwnSession(user.userId, sessionId);
    return { success: true };
  }

  @Get("passkeys")
  @UseGuards(AuthGuard)
  async listPasskeys(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.listPasskeys(user.userId);
  }

  @Post("passkeys/registration-options")
  @UseGuards(AuthGuard)
  async passkeyRegistrationOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.generatePasskeyRegistrationOptions(user.userId);
  }

  @Post("passkeys/register")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(PasskeyRegisterDtoSchema))
  async registerPasskey(@CurrentUser() user: AuthenticatedUser, @Body() dto: PasskeyRegisterDto) {
    return this.identity.verifyPasskeyRegistration(user.userId, dto.response as RegistrationResponseJSON);
  }

  @Delete("passkeys/:id")
  @UseGuards(AuthGuard)
  async deletePasskey(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.identity.deletePasskey(user.userId, id);
    return { success: true };
  }
}

function detectPlatform(req: FastifyRequest): string {
  const header = String(req.headers["x-veynlo-platform"] ?? "web");
  return ["ios", "android", "web", "macos", "windows", "extension"].includes(header) ? header : "web";
}

/** CSRF binding for the google/microsoft authorize→callback round trip — a short-lived signed nonce, not
 * tied to any user (unlike the connector-connect flow's state, there's no signed-in user yet to embed). */
async function signOAuthState(): Promise<string> {
  const env = loadEnv();
  return new SignJWT({ purpose: "oauth_signin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
}

async function verifyOAuthState(state: string): Promise<void> {
  if (!state) throw new Error("missing_state");
  await jwtVerify(state, new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
}

/** The redirect-based flows above map OAuthNotConfiguredError to a `/sign-in?error=...` redirect code via
 * oauthErrorRedirect below; these POST-based native flows return JSON like every other auth endpoint
 * instead, so it needs converting to a real HttpException here or GlobalExceptionFilter would fall through
 * to a generic, code-less 500. */
async function rethrowOAuthNotConfigured<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthNotConfiguredError) {
      throw new BadRequestException({ code: "OAUTH_NOT_CONFIGURED", message: err.message });
    }
    throw err;
  }
}

/** Maps a thrown error to a `/sign-in?error=...` code the sign-in page can show a specific message for. */
function oauthErrorRedirect(env: ReturnType<typeof loadEnv>, err: unknown): string {
  let code = "oauth_failed";
  if (err instanceof OAuthNotConfiguredError) {
    code = "oauth_not_configured";
  } else if (err && typeof err === "object" && "getResponse" in err && typeof (err as { getResponse: unknown }).getResponse === "function") {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (response && typeof response === "object" && "code" in response) code = String((response as { code: unknown }).code).toLowerCase();
  }
  return `${env.WEB_APP_URL}/sign-in?error=${encodeURIComponent(code)}`;
}

/**
 * The raw session token is only ever returned in a JSON body for non-web
 * platforms. Web relies solely on the httpOnly cookie — putting the token
 * in a body a compromised web page's JS could read would defeat the whole
 * point of httpOnly (XSS exfiltration). Native apps have no browser cookie
 * jar to rely on, so they store this in Keychain/Keystore instead.
 */
function nativeTokenPayload(platform: string, session: { token: string; expiresAt: Date }) {
  if (platform === "web") return {};
  return { token: session.token, expiresAt: session.expiresAt.toISOString() };
}

function setSessionCookie(res: FastifyReply, token: string, expiresAt: Date) {
  const env = loadEnv();
  res.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}
