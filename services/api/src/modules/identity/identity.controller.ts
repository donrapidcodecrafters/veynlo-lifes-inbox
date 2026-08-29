import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SignJWT, jwtVerify } from "jose";
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
  SetAiProcessingDtoSchema,
  RegisterPushTokenDtoSchema,
  type DeleteAccountDto,
  type SignInDto,
  type SignUpDto,
  type SetAiProcessingDto,
  type RegisterPushTokenDto,
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

  @Post("sessions/:sessionId/revoke")
  @UseGuards(AuthGuard)
  async revokeOneSession(@CurrentUser() user: AuthenticatedUser, @Param("sessionId") sessionId: string) {
    await this.identity.revokeOwnSession(user.userId, sessionId);
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
