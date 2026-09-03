import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, ServiceUnavailableException, UseGuards, UsePipes } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { detectPlatform, type ClientPlatform } from "../../common/platform";
import { loadEnv } from "../../config/env";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter, ConnectorNotConfiguredError } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import { GoogleContactsAdapter } from "./google-contacts.adapter";
import { MicrosoftContactsAdapter } from "./microsoft-contacts.adapter";
import { GoogleDriveAdapter } from "./google-drive.adapter";
import { OneDriveAdapter } from "./onedrive.adapter";
import { DropboxAdapter } from "./dropbox.adapter";
import { GoogleTasksAdapter } from "./google-tasks.adapter";
import { MicrosoftToDoAdapter } from "./microsoft-todo.adapter";
import { PlaidAdapter } from "./plaid.adapter";
import { IcsConnectDtoSchema, type IcsConnectDto, PlaidExchangeDtoSchema, type PlaidExchangeDto } from "./dto";

/**
 * Deliberately no class-level `@UseGuards(AuthGuard)` — the four OAuth `*Callback` routes below must NOT
 * require an ambient Veynlo session. They're hit by the browser Google/Microsoft redirects, and for a
 * native client that browser is the system browser opened via `Linking.openURL`, which shares no cookie
 * jar or bearer token with the app's own authenticated fetch client. A class-level guard would 401 every
 * real native OAuth callback before it ever reached `verifyConnectState` — confirmed live: an unauthenticated
 * `curl` against `gmail/callback` returned 401 from AuthGuard, never reaching the handler at all. The
 * signed, 10-minute-lived OAuth `state` (see signConnectState/verifyConnectState) is what actually proves
 * the callback belongs to a real, recent authorize call for a specific user — the same "no ambient session
 * needed, state is the trust boundary" design identity.controller.ts's own Google/Microsoft sign-in
 * callbacks already use. Every other route below is guarded individually instead.
 */
@Controller("v1/connectors")
export class ConnectorsController {
  constructor(
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(GmailAdapter) private readonly gmail: GmailAdapter,
    @Inject(OutlookAdapter) private readonly outlook: OutlookAdapter,
    @Inject(IcsAdapter) private readonly ics: IcsAdapter,
    @Inject(GoogleCalendarAdapter) private readonly googleCalendar: GoogleCalendarAdapter,
    @Inject(MicrosoftCalendarAdapter) private readonly microsoftCalendar: MicrosoftCalendarAdapter,
    @Inject(GoogleContactsAdapter) private readonly googleContacts: GoogleContactsAdapter,
    @Inject(MicrosoftContactsAdapter) private readonly microsoftContacts: MicrosoftContactsAdapter,
    @Inject(GoogleDriveAdapter) private readonly googleDrive: GoogleDriveAdapter,
    @Inject(OneDriveAdapter) private readonly oneDrive: OneDriveAdapter,
    @Inject(DropboxAdapter) private readonly dropbox: DropboxAdapter,
    @Inject(GoogleTasksAdapter) private readonly googleTasks: GoogleTasksAdapter,
    @Inject(MicrosoftToDoAdapter) private readonly microsoftToDo: MicrosoftToDoAdapter,
    @Inject(PlaidAdapter) private readonly plaid: PlaidAdapter,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.connectors.listForUser(user.userId);
  }

  @Get("gmail/authorize")
  @UseGuards(AuthGuard)
  async gmailAuthorize(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query("historyDepthDays") historyDepthDays?: string,
    @Query("onboarding") onboarding?: string,
  ) {
    if (!this.gmail.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Gmail isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "email");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req), {
      historyDepthDays: parseHistoryDepthDays(historyDepthDays),
      fromOnboarding: onboarding === "true",
    });
    const authorizationUrl = this.gmail.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  /**
   * A real browser navigation the whole way through (Google redirects the browser straight back here),
   * so this must issue a real HTTP redirect — returning JSON here (as this route used to) would just
   * render as raw text in the browser instead of landing the user back on the Connections page. For a
   * native client, "the Connections page" is the app's own `veynlo://connections` deep link, not
   * `WEB_APP_URL` — see connectorRedirectUrl's doc comment for why the platform has to travel through the
   * signed OAuth state rather than being read off this request (Google/Microsoft's redirect back here
   * carries no headers this app controls).
   */
  @Get("gmail/callback")
  async gmailCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    let fromOnboarding = false;
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      fromOnboarding = Boolean(verified.fromOnboarding);
      const { connectionId } = await this.gmail.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`,
        ownerUserId: verified.userId,
        householdId: null,
        requestedHistoryDepthDays: verified.historyDepthDays,
      });
      // ONB-001 — an OAuth connect started from the onboarding wizard lands back on /onboarding (with the
      // new connectionId, so the wizard can start its bounded scan) instead of /connections.
      return res.redirect(oauthReturnRedirect(env, platform, fromOnboarding, `connected=gmail&connectionId=${connectionId}`), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err, fromOnboarding), 302);
    }
  }

  @Get("outlook/authorize")
  @UseGuards(AuthGuard)
  async outlookAuthorize(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query("historyDepthDays") historyDepthDays?: string,
    @Query("onboarding") onboarding?: string,
  ) {
    if (!this.outlook.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Outlook isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "email");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req), {
      historyDepthDays: parseHistoryDepthDays(historyDepthDays),
      fromOnboarding: onboarding === "true",
    });
    const authorizationUrl = this.outlook.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("outlook/callback")
  async outlookCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    let fromOnboarding = false;
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      fromOnboarding = Boolean(verified.fromOnboarding);
      const { connectionId } = await this.outlook.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`,
        ownerUserId: verified.userId,
        householdId: null,
        requestedHistoryDepthDays: verified.historyDepthDays,
      });
      return res.redirect(oauthReturnRedirect(env, platform, fromOnboarding, `connected=outlook&connectionId=${connectionId}`), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err, fromOnboarding), 302);
    }
  }

  @Get("google-calendar/authorize")
  @UseGuards(AuthGuard)
  async googleCalendarAuthorize(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query("writeBack") writeBack?: string,
    @Query("reconnectId") reconnectId?: string,
  ) {
    if (!this.googleCalendar.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Google Calendar isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    // CAL-001 write-back reauthorize flow: `reconnectId` (an existing google_calendar connection this user
    // already owns) skips the connector-quota check below — this is a scope UPGRADE on a connection that
    // already counts against the quota, not a new one.
    if (reconnectId) await this.connectors.assertOwnership(reconnectId, user.userId);
    else await this.entitlements.assertConnectorQuota(user.userId, "calendar");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req), { reauthConnectionId: reconnectId, writeBack: writeBack === "true" });
    const authorizationUrl = this.googleCalendar.authorizationUrl({ redirectUri, state, writeBack: writeBack === "true" });
    return { authorizationUrl };
  }

  @Get("google-calendar/callback")
  async googleCalendarCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.googleCalendar.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`,
        ownerUserId: verified.userId,
        householdId: null,
        reauthConnectionId: verified.reauthConnectionId,
        grantedWriteBack: verified.writeBack,
      });
      return res.redirect(connectorRedirectUrl(env, platform, verified.writeBack ? "connected=google_calendar&writeBack=1" : "connected=google_calendar"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("microsoft-calendar/authorize")
  @UseGuards(AuthGuard)
  async microsoftCalendarAuthorize(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Query("writeBack") writeBack?: string,
    @Query("reconnectId") reconnectId?: string,
  ) {
    if (!this.microsoftCalendar.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Microsoft Calendar isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    if (reconnectId) await this.connectors.assertOwnership(reconnectId, user.userId);
    else await this.entitlements.assertConnectorQuota(user.userId, "calendar");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/microsoft-calendar/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req), { reauthConnectionId: reconnectId, writeBack: writeBack === "true" });
    const authorizationUrl = this.microsoftCalendar.authorizationUrl({ redirectUri, state, writeBack: writeBack === "true" });
    return { authorizationUrl };
  }

  @Get("microsoft-calendar/callback")
  async microsoftCalendarCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.microsoftCalendar.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/microsoft-calendar/callback`,
        ownerUserId: verified.userId,
        householdId: null,
        reauthConnectionId: verified.reauthConnectionId,
        grantedWriteBack: verified.writeBack,
      });
      return res.redirect(connectorRedirectUrl(env, platform, verified.writeBack ? "connected=microsoft_calendar&writeBack=1" : "connected=microsoft_calendar"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  /** CAL-001 write-back toggle — see ConnectorsService.setWriteBack's doc comment for the scope-upgrade
   * contract. `enabled: true` on a connection whose scopes lack write access throws WRITE_SCOPE_REQUIRED
   * (409); the client is expected to fall back to the reconnect flow above. */
  @Patch(":connectionId/write-back")
  @UseGuards(AuthGuard)
  async setWriteBack(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string, @Body("enabled") enabled: boolean) {
    await this.connectors.setWriteBack(connectionId, user.userId, Boolean(enabled));
    return { success: true };
  }

  // §14 "Contacts, People & Relationships" (PEO-001). Deliberately no `assertConnectorQuota` call here —
  // Contacts is Core-tier, not gated behind a plan's connector-count cap the way email/calendar/storage/
  // financial connections are (see EntitlementsService.assertConnectorQuota's own category list, which
  // doesn't include "people").
  @Get("google-contacts/authorize")
  @UseGuards(AuthGuard)
  async googleContactsAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.googleContacts.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Google Contacts isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-contacts/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.googleContacts.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-contacts/callback")
  async googleContactsCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.googleContacts.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-contacts/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=google_contacts"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("microsoft-contacts/authorize")
  @UseGuards(AuthGuard)
  async microsoftContactsAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.microsoftContacts.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Microsoft Contacts isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/microsoft-contacts/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.microsoftContacts.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("microsoft-contacts/callback")
  async microsoftContactsCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.microsoftContacts.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/microsoft-contacts/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=microsoft_contacts"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("google-drive/authorize")
  @UseGuards(AuthGuard)
  async googleDriveAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.googleDrive.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Google Drive isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "storage");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-drive/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.googleDrive.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-drive/callback")
  async googleDriveCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.googleDrive.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-drive/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=google_drive"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("onedrive/authorize")
  @UseGuards(AuthGuard)
  async oneDriveAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.oneDrive.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "OneDrive isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "storage");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/onedrive/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.oneDrive.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("onedrive/callback")
  async oneDriveCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.oneDrive.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/onedrive/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=onedrive"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("dropbox/authorize")
  @UseGuards(AuthGuard)
  async dropboxAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.dropbox.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Dropbox isn't configured on this deployment yet. Set DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "storage");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/dropbox/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.dropbox.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("dropbox/callback")
  async dropboxCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.dropbox.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/dropbox/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=dropbox"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("google-tasks/authorize")
  @UseGuards(AuthGuard)
  async googleTasksAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.googleTasks.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Google Tasks isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "calendar");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-tasks/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.googleTasks.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-tasks/callback")
  async googleTasksCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.googleTasks.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-tasks/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=google_tasks"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  @Get("microsoft-todo/authorize")
  @UseGuards(AuthGuard)
  async microsoftToDoAuthorize(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    if (!this.microsoftToDo.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Microsoft To Do isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "calendar");
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/microsoft-todo/callback`;
    const state = await signConnectState(user.userId, detectPlatform(req));
    const authorizationUrl = this.microsoftToDo.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("microsoft-todo/callback")
  async microsoftToDoCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    let platform: ClientPlatform = "web";
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const verified = await verifyConnectState(state);
      platform = verified.platform;
      await this.microsoftToDo.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/microsoft-todo/callback`,
        ownerUserId: verified.userId,
        householdId: null,
      });
      return res.redirect(connectorRedirectUrl(env, platform, "connected=microsoft_todo"), 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, platform, err), 302);
    }
  }

  /** Called right before rendering Plaid's Link widget client-side — see PlaidAdapter's own doc comment
   * on why Plaid has no `/authorize` redirect route the way every OAuth connector above does. */
  @Post("plaid/link-token")
  @UseGuards(AuthGuard)
  async plaidLinkToken(@CurrentUser() user: AuthenticatedUser) {
    if (!this.plaid.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Bank connections aren't configured on this deployment yet. Set PLAID_CLIENT_ID and PLAID_SECRET to enable it.",
      });
    }
    await this.entitlements.assertConnectorQuota(user.userId, "financial");
    return this.plaid.createLinkToken(user.userId);
  }

  @Post("plaid/exchange")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(PlaidExchangeDtoSchema))
  async plaidExchange(@CurrentUser() user: AuthenticatedUser, @Body() dto: PlaidExchangeDto) {
    const { connectionId } = await this.plaid.exchangePublicToken({
      publicToken: dto.publicToken,
      ownerUserId: user.userId,
      householdId: null,
      requestedHistoryDepthDays: dto.historyDepthDays,
    });
    return { connectionId };
  }

  @Post("ics/connect")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(IcsConnectDtoSchema))
  async icsConnect(@CurrentUser() user: AuthenticatedUser, @Body() dto: IcsConnectDto) {
    await this.entitlements.assertConnectorQuota(user.userId, "calendar");
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
  @UseGuards(AuthGuard)
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") connectionId: string,
    @Body("deleteDerivedData") deleteDerivedData?: boolean,
    @Body("password") password?: string,
  ) {
    await this.connectors.disconnect(connectionId, user.userId, Boolean(deleteDerivedData), password);
    return { success: true };
  }

  /** PRIV-001 "per-source AI-processing toggle" — `enabled: null` clears the override back to inheriting
   * the account-wide setting; true/false pins this connection. See ConnectorsService.setAiProcessingOverride. */
  @Patch(":connectionId/ai-processing")
  @UseGuards(AuthGuard)
  async setAiProcessing(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") connectionId: string,
    @Body("enabled") enabled: boolean | null,
  ) {
    await this.connectors.setAiProcessingOverride(connectionId, user.userId, enabled);
    return { success: true, enabled };
  }

  /** PRIV-001 "pause/resume a connection without disconnecting it." */
  @Patch(":connectionId/pause")
  @UseGuards(AuthGuard)
  async setPaused(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string, @Body("paused") paused: boolean) {
    await this.connectors.setPaused(connectionId, user.userId, Boolean(paused));
    return { success: true, paused: Boolean(paused) };
  }

  /** PRIV-001 "exclude specific senders" — simple per-connection list management. */
  @Get(":connectionId/exclusions")
  @UseGuards(AuthGuard)
  async listExclusions(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string) {
    return this.connectors.listExclusions(connectionId, user.userId);
  }

  @Post(":connectionId/exclusions")
  @UseGuards(AuthGuard)
  async addExclusion(@CurrentUser() user: AuthenticatedUser, @Param("connectionId") connectionId: string, @Body("excludedSenderDomain") excludedSenderDomain: string) {
    return this.connectors.addExclusion(connectionId, user.userId, String(excludedSenderDomain ?? ""));
  }

  @Delete(":connectionId/exclusions/:exclusionId")
  @UseGuards(AuthGuard)
  async removeExclusion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("connectionId") connectionId: string,
    @Param("exclusionId") exclusionId: string,
  ) {
    await this.connectors.removeExclusion(connectionId, user.userId, exclusionId);
    return { success: true };
  }
}

/**
 * Signs the requesting client's platform into the OAuth state alongside the user id — the callback runs
 * on a request from Google/Microsoft, not the original client, so this is the only channel the platform
 * can travel through to reach the redirect decision below. CAL-001 write-back extends this with two more
 * fields for the SAME reason: `reconnectId`/`writeBack` are client-supplied query params on the `/authorize`
 * request, and the callback must not trust an unsigned copy of them coming back from Google/Microsoft — the
 * signed state is what actually proves "this reconnect was for write-back, for connection X, initiated by
 * a request this user's own session made within the last 10 minutes," not anything in the callback's own
 * query string.
 */
/** Parses the `historyDepthDays` query param `/authorize` routes accept (a plain string over HTTP), same
 * defensive "ignore anything that isn't a sane non-negative integer rather than 500" posture as every
 * other query-param parse in this controller — an absent/invalid value just falls back to the plan's full
 * allowance (resolveHistoricalBackfillDays's existing default when no override is passed at all). */
function parseHistoryDepthDays(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

async function signConnectState(
  userId: string,
  platform: ClientPlatform,
  extra?: { reauthConnectionId?: string; writeBack?: boolean; historyDepthDays?: number; fromOnboarding?: boolean },
): Promise<string> {
  const env = loadEnv();
  return new SignJWT({
    sub: userId,
    platform,
    reauthConnectionId: extra?.reauthConnectionId,
    writeBack: extra?.writeBack,
    // ONB-002 — the onboarding (or Connections page) historical-depth choice, signed into the state so the
    // callback can trust it came from this user's own recent `/authorize` request rather than an
    // unsigned query param an attacker could tack onto the callback URL.
    historyDepthDays: extra?.historyDepthDays,
    // ONB-001 — whether this connect was started from the onboarding wizard, so the callback can send the
    // browser back to /onboarding (with the resulting connectionId) instead of /connections.
    fromOnboarding: extra?.fromOnboarding,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.SESSION_JWT_SECRET));
}

async function verifyConnectState(state: string): Promise<{
  userId: string;
  platform: ClientPlatform;
  reauthConnectionId?: string;
  writeBack?: boolean;
  historyDepthDays?: number;
  fromOnboarding?: boolean;
}> {
  try {
    const verified = await jwtVerify(state, new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET), { algorithms: ["HS256"] });
    const payload = verified.payload as {
      sub?: string;
      platform?: string;
      reauthConnectionId?: string;
      writeBack?: boolean;
      historyDepthDays?: number;
      fromOnboarding?: boolean;
    };
    if (!payload.sub) throw new Error("missing sub");
    const platform: ClientPlatform = (["ios", "android", "web", "macos", "windows", "extension"] as const).includes(
      payload.platform as ClientPlatform,
    )
      ? (payload.platform as ClientPlatform)
      : "web";
    return {
      userId: payload.sub,
      platform,
      reauthConnectionId: payload.reauthConnectionId,
      writeBack: payload.writeBack,
      historyDepthDays: payload.historyDepthDays,
      fromOnboarding: payload.fromOnboarding,
    };
  } catch {
    throw new BadRequestException({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or expired." });
  }
}

/**
 * §AUTH "OAuth connect from mobile opens the system browser and finishes there rather than deep-linking
 * back into the app" — the one remaining piece was always the server picking a web URL unconditionally.
 * A native client's "Connections page" is its own `veynlo://connections` deep link (already a registered
 * scheme — the iOS Share Extension's capture handoff proved iOS recognizes and opens it); web keeps using
 * `WEB_APP_URL` exactly as before. expo-router auto-maps `app/connections.tsx` to this path under the
 * scheme, so no separate native route registration is needed beyond the app already existing.
 */
function connectorRedirectUrl(env: ReturnType<typeof loadEnv>, platform: ClientPlatform, query: string): string {
  const base = platform === "web" ? `${env.WEB_APP_URL}/connections` : "veynlo://connections";
  return `${base}?${query}`;
}

/** ONB-001 — same shape as connectorRedirectUrl above, but for the two connectors onboarding can trigger
 * (Gmail/Outlook): a connect started from the onboarding wizard returns to `/onboarding` (native:
 * `veynlo://onboarding`) instead of `/connections`, carrying the same query string (`connected=<provider>
 * &connectionId=<id>`) so the wizard can read the new connection id straight off the URL and kick off its
 * bounded scan, with no extra round trip to list connections and guess which one is new. */
function oauthReturnRedirect(env: ReturnType<typeof loadEnv>, platform: ClientPlatform, fromOnboarding: boolean, query: string): string {
  if (!fromOnboarding) return connectorRedirectUrl(env, platform, query);
  const base = platform === "web" ? `${env.WEB_APP_URL}/onboarding` : "veynlo://onboarding";
  return `${base}?${query}`;
}

/** Maps a thrown error to a `?error=...` code the Connections page (web or native) can show a specific
 * message for. `fromOnboarding` routes the same error back to the onboarding wizard instead, so an
 * abandoned/failed OAuth grant mid-onboarding (ONB-001's own "user abandons OAuth" edge case) surfaces on
 * the step the user was actually on rather than bouncing them to a different page. */
function connectorErrorRedirect(env: ReturnType<typeof loadEnv>, platform: ClientPlatform, err: unknown, fromOnboarding = false): string {
  let code = "connector_failed";
  if (err instanceof ConnectorNotConfiguredError) {
    code = "connector_not_configured";
  } else if (err && typeof err === "object" && "getResponse" in err && typeof (err as { getResponse: unknown }).getResponse === "function") {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (response && typeof response === "object" && "code" in response) code = String((response as { code: unknown }).code).toLowerCase();
  }
  return oauthReturnRedirect(env, platform, fromOnboarding, `error=${encodeURIComponent(code)}`);
}
