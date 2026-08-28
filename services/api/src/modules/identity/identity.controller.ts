import { Body, Controller, Get, Post, Req, Res, UseGuards, UsePipes } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";
import { IdentityService } from "./identity.service";
import {
  DeleteAccountDtoSchema,
  SignInDtoSchema,
  SignUpDtoSchema,
  type DeleteAccountDto,
  type SignInDto,
  type SignUpDto,
} from "./dto";

const SESSION_COOKIE = "veynlo_session";

@Controller("v1/auth")
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post("sign-up")
  @UsePipes(new ZodValidationPipe(SignUpDtoSchema))
  async signUp(@Body() dto: SignUpDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signUp(dto, { platform });
    setSessionCookie(res, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }

  @Post("sign-in")
  @UsePipes(new ZodValidationPipe(SignInDtoSchema))
  async signIn(@Body() dto: SignInDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.identity.signIn(dto, { platform });
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

  @Get("sessions")
  @UseGuards(AuthGuard)
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.identity.listSessions(user.userId);
  }
}

function detectPlatform(req: FastifyRequest): string {
  const header = String(req.headers["x-veynlo-platform"] ?? "web");
  return ["ios", "android", "web", "macos", "windows", "extension"].includes(header) ? header : "web";
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
