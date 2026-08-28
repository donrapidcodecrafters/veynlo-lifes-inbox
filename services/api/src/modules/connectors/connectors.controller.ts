import { BadRequestException, Body, Controller, Get, Param, Post, Query, ServiceUnavailableException, UseGuards, UsePipes } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { loadEnv } from "../../config/env";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter, ConnectorNotConfiguredError } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { IcsConnectDtoSchema, type IcsConnectDto } from "./dto";

@Controller("v1/connectors")
@UseGuards(AuthGuard)
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly gmail: GmailAdapter,
    private readonly outlook: OutlookAdapter,
    private readonly ics: IcsAdapter,
    private readonly googleCalendar: GoogleCalendarAdapter,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.connectors.listForUser(user.userId);
  }

  @Get("gmail/authorize")
  async gmailAuthorize(@CurrentUser() user: AuthenticatedUser) {
    if (!this.gmail.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Gmail isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`;
    const state = await new SignJWT({ sub: user.userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
    const authorizationUrl = this.gmail.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("gmail/callback")
  async gmailCallback(@Query("code") code: string, @Query("state") state: string) {
    if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
    const env = loadEnv();
    let userId: string;
    try {
      const verified = await jwtVerify(state, new TextEncoder().encode(env.SESSION_JWT_SECRET));
      userId = (verified.payload as { sub: string }).sub;
    } catch {
      throw new BadRequestException({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or expired." });
    }
    try {
      const result = await this.gmail.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`,
        ownerUserId: userId,
        householdId: null,
      });
      return { connectionId: result.connectionId, redirectTo: `${env.WEB_APP_URL}/connections?connected=gmail` };
    } catch (err) {
      if (err instanceof ConnectorNotConfiguredError) {
        throw new ServiceUnavailableException({ code: "CONNECTOR_NOT_CONFIGURED", message: err.message });
      }
      throw err;
    }
  }

  @Get("outlook/authorize")
  async outlookAuthorize(@CurrentUser() user: AuthenticatedUser) {
    if (!this.outlook.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Outlook isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`;
    const state = await new SignJWT({ sub: user.userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
    const authorizationUrl = this.outlook.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("outlook/callback")
  async outlookCallback(@Query("code") code: string, @Query("state") state: string) {
    if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
    const env = loadEnv();
    let userId: string;
    try {
      const verified = await jwtVerify(state, new TextEncoder().encode(env.SESSION_JWT_SECRET));
      userId = (verified.payload as { sub: string }).sub;
    } catch {
      throw new BadRequestException({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or expired." });
    }
    try {
      const result = await this.outlook.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`,
        ownerUserId: userId,
        householdId: null,
      });
      return { connectionId: result.connectionId, redirectTo: `${env.WEB_APP_URL}/connections?connected=outlook` };
    } catch (err) {
      if (err instanceof ConnectorNotConfiguredError) {
        throw new ServiceUnavailableException({ code: "CONNECTOR_NOT_CONFIGURED", message: err.message });
      }
      throw err;
    }
  }

  @Get("google-calendar/authorize")
  async googleCalendarAuthorize(@CurrentUser() user: AuthenticatedUser) {
    if (!this.googleCalendar.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Google Calendar isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`;
    const state = await new SignJWT({ sub: user.userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
    const authorizationUrl = this.googleCalendar.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-calendar/callback")
  async googleCalendarCallback(@Query("code") code: string, @Query("state") state: string) {
    if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
    const env = loadEnv();
    let userId: string;
    try {
      const verified = await jwtVerify(state, new TextEncoder().encode(env.SESSION_JWT_SECRET));
      userId = (verified.payload as { sub: string }).sub;
    } catch {
      throw new BadRequestException({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or expired." });
    }
    try {
      const result = await this.googleCalendar.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`,
        ownerUserId: userId,
        householdId: null,
      });
      return { connectionId: result.connectionId, redirectTo: `${env.WEB_APP_URL}/connections?connected=google_calendar` };
    } catch (err) {
      if (err instanceof ConnectorNotConfiguredError) {
        throw new ServiceUnavailableException({ code: "CONNECTOR_NOT_CONFIGURED", message: err.message });
      }
      throw err;
    }
  }

  @Post("ics/connect")
  @UsePipes(new ZodValidationPipe(IcsConnectDtoSchema))
  async icsConnect(@CurrentUser() user: AuthenticatedUser, @Body() dto: IcsConnectDto) {
    try {
      const result = await this.ics.connect({ dto, ownerUserId: user.userId, householdId: null });
      return { connectionId: result.connectionId };
    } catch {
      throw new BadRequestException({
        code: "ICS_FEED_UNREACHABLE",
        message: "Couldn't read that calendar feed. Check the URL (and credentials, if it needs them) and try again.",
      });
    }
  }

  @Post(":connectionId/disconnect")
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") connectionId: string,
    @Body("deleteDerivedData") deleteDerivedData?: boolean,
  ) {
    await this.connectors.disconnect(connectionId, user.userId, Boolean(deleteDerivedData));
    return { success: true };
  }
}
