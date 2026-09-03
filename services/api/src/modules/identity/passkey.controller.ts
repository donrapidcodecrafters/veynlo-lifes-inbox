import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { detectPlatform } from "../../common/platform";
import { PasskeyService } from "./passkey.service";
import { nativeTokenPayload, setSessionCookie } from "./identity.controller";
import {
  PasskeyRegistrationVerifyDtoSchema,
  type PasskeyRegistrationVerifyDto,
  PasskeyAuthenticationOptionsDtoSchema,
  type PasskeyAuthenticationOptionsDto,
  PasskeyAuthenticationVerifyDtoSchema,
  type PasskeyAuthenticationVerifyDto,
} from "./passkey.dto";

/**
 * AUTH-001 "create passkey" / "Sign in with ... passkey" — real WebAuthn ceremonies (see PasskeyService's
 * own doc comment). Split into its own controller/service rather than folded into IdentityController/
 * IdentityService directly: the ceremony shape (options → verify, twice over) is genuinely distinct from
 * every other auth method here, and keeping it separate means IdentityService's already-large surface
 * doesn't grow further — the two integration points back into it (issueSessionForExternalAuth, and reusing
 * `identity.controller.ts`'s cookie/native-token helpers) are deliberately thin.
 */
@Controller("v1/auth/passkeys")
export class PasskeyController {
  constructor(@Inject(PasskeyService) private readonly passkeys: PasskeyService) {}

  @Get()
  @UseGuards(AuthGuard)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeys.listPasskeys(user.userId);
  }

  @Delete(":id")
  @UseGuards(AuthGuard)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.passkeys.removePasskey(id, user.userId);
    return { success: true };
  }

  /** "Add a passkey" — must already be signed in via some other method the first time (there's nothing to
   * authenticate against yet on a brand-new account); registering a second/third passkey works the same
   * way once at least one sign-in method exists. */
  @Post("registration-options")
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async registrationOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeys.registrationOptions(user.userId);
  }

  @Post("registration-verify")
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(PasskeyRegistrationVerifyDtoSchema))
  async registrationVerify(@CurrentUser() user: AuthenticatedUser, @Body() dto: PasskeyRegistrationVerifyDto) {
    return this.passkeys.verifyRegistration(user.userId, dto.response, dto.challengeToken, dto.label);
  }

  /** "Sign in with a passkey" step 1 — deliberately public; this is how a session gets created in the
   * first place. Same throttle tier as sign-in/refresh (a credential-guessing surface). */
  @Post("authentication-options")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(PasskeyAuthenticationOptionsDtoSchema))
  async authenticationOptions(@Body() dto: PasskeyAuthenticationOptionsDto) {
    return this.passkeys.authenticationOptions(dto.email);
  }

  @Post("authentication-verify")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(PasskeyAuthenticationVerifyDtoSchema))
  async authenticationVerify(@Body() dto: PasskeyAuthenticationVerifyDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const platform = detectPlatform(req);
    const session = await this.passkeys.verifyAuthentication(dto.response, dto.challengeToken, { platform });
    setSessionCookie(res, platform, session.token, session.expiresAt);
    return { userId: session.userId, ...nativeTokenPayload(platform, session) };
  }
}
