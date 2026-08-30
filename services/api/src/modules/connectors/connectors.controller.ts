import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Res, ServiceUnavailableException, UseGuards, UsePipes } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { loadEnv } from "../../config/env";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { BillingService } from "../billing/billing.service";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter, ConnectorNotConfiguredError } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import { GoogleTasksAdapter } from "./google-tasks.adapter";
import { MicrosoftTodoAdapter } from "./microsoft-todo.adapter";
import { IcsConnectDtoSchema, type IcsConnectDto } from "./dto";

@Controller("v1/connectors")
@UseGuards(AuthGuard)
export class ConnectorsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly billing: BillingService,
    private readonly gmail: GmailAdapter,
    private readonly outlook: OutlookAdapter,
    private readonly ics: IcsAdapter,
    private readonly googleCalendar: GoogleCalendarAdapter,
    private readonly microsoftCalendar: MicrosoftCalendarAdapter,
    private readonly googleTasks: GoogleTasksAdapter,
    private readonly microsoftTodo: MicrosoftTodoAdapter,
  ) {}

  /**
   * §46 entitlement enforcement — connector counts were the clearest unenforced quota: `PLAN_CATALOG`
   * defines `email_connections_max`/`calendar_connections_max` for every plan, but nothing anywhere
   * checked either before this. Checked at the *authorize* step (before generating an OAuth redirect) so a
   * user hitting their cap never wastes a full OAuth round-trip only to be rejected at the callback; the
   * one POST-based connect flow (ICS) checks at the same point, right before actually connecting.
   */
  private async assertConnectionQuota(userId: string, capability: "email_connections_max" | "calendar_connections_max", providers: string[]) {
    const max = await this.billing.getCapability(userId, capability);
    if (max === null) return; // unlimited
    const current = await this.connectors.countActiveConnections(userId, providers);
    if (current >= (max as number)) {
      throw new ForbiddenException({
        code: "PLAN_LIMIT_REACHED",
        message: `Your plan allows up to ${max} ${capability === "email_connections_max" ? "email" : "calendar"} connection${max === 1 ? "" : "s"}. Upgrade your plan or disconnect one to add another.`,
      });
    }
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.connectors.listForUser(user.userId);
  }

  @Get("gmail/authorize")
  async gmailAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.gmail.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Gmail isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.assertConnectionQuota(user.userId, "email_connections_max", ["gmail", "outlook"]);
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.gmail.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  /**
   * A real browser navigation the whole way through (Google redirects the browser straight back here),
   * so this must issue a real HTTP redirect — returning JSON here (as this route used to) would just
   * render as raw text in the browser instead of landing the user back on the Connections page.
   */
  @Get("gmail/callback")
  async gmailCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.gmail.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/gmail/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=gmail`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Get("outlook/authorize")
  async outlookAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.outlook.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Outlook isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.assertConnectionQuota(user.userId, "email_connections_max", ["gmail", "outlook"]);
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.outlook.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("outlook/callback")
  async outlookCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.outlook.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/outlook/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=outlook`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Get("google-calendar/authorize")
  async googleCalendarAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.googleCalendar.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Google Calendar isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.assertConnectionQuota(user.userId, "calendar_connections_max", ["google_calendar", "microsoft_calendar", "ics"]);
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.googleCalendar.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-calendar/callback")
  async googleCalendarCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.googleCalendar.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-calendar/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=google_calendar`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Get("microsoft-calendar/authorize")
  async microsoftCalendarAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.microsoftCalendar.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message:
          "Microsoft Calendar isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    await this.assertConnectionQuota(user.userId, "calendar_connections_max", ["google_calendar", "microsoft_calendar", "ics"]);
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/microsoft-calendar/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.microsoftCalendar.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("microsoft-calendar/callback")
  async microsoftCalendarCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.microsoftCalendar.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/microsoft-calendar/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=microsoft_calendar`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Get("google-tasks/authorize")
  async googleTasksAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.googleTasks.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Google Tasks isn't configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/google-tasks/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.googleTasks.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("google-tasks/callback")
  async googleTasksCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.googleTasks.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/google-tasks/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=google_tasks`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Get("microsoft-todo/authorize")
  async microsoftTodoAuthorize(@CurrentUser() user: AuthenticatedUser, @Query("historyDepthDays") historyDepthDaysRaw?: string) {
    if (!this.microsoftTodo.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "Microsoft To Do isn't configured on this deployment yet. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET to enable it.",
      });
    }
    const env = loadEnv();
    const redirectUri = `${env.API_PUBLIC_URL}/v1/connectors/microsoft-todo/callback`;
    const state = await signConnectState(user.userId, parseHistoryDepthDays(historyDepthDaysRaw));
    const authorizationUrl = this.microsoftTodo.authorizationUrl({ redirectUri, state });
    return { authorizationUrl };
  }

  @Get("microsoft-todo/callback")
  async microsoftTodoCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: FastifyReply) {
    const env = loadEnv();
    try {
      if (!code || !state) throw new BadRequestException({ code: "MISSING_OAUTH_PARAMS", message: "Missing code or state." });
      const { userId, historyDepthDays } = await verifyConnectState(state);
      await this.microsoftTodo.handleCallback({
        code,
        redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/microsoft-todo/callback`,
        ownerUserId: userId,
        householdId: null,
        historyDepthDays,
      });
      return res.redirect(`${env.WEB_APP_URL}/connections?connected=microsoft_todo`, 302);
    } catch (err) {
      return res.redirect(connectorErrorRedirect(env, err), 302);
    }
  }

  @Post("ics/connect")
  @UsePipes(new ZodValidationPipe(IcsConnectDtoSchema))
  async icsConnect(@CurrentUser() user: AuthenticatedUser, @Body() dto: IcsConnectDto) {
    await this.assertConnectionQuota(user.userId, "calendar_connections_max", ["google_calendar", "microsoft_calendar", "ics"]);
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

// ONB-002 "build my history" — the spec's fuller range includes an unlimited/"where provider capability
// allows" option; this previously capped at 1 year with nothing beyond it. 3650 (10 years) stands in for
// "unlimited" rather than a sentinel value (e.g. -1) that would need special-casing in every adapter's
// `Date.now() - historyDepthDays * 86_400_000` window math — a large-but-finite bound is simpler and just
// as effective, since no real mailbox has messages older than the account itself anyway.
const VALID_HISTORY_DEPTH_DAYS = [0, 30, 90, 182, 365, 3650] as const;

function parseHistoryDepthDays(raw: string | undefined): number {
  const parsed = Number(raw);
  return (VALID_HISTORY_DEPTH_DAYS as readonly number[]).includes(parsed) ? parsed : 90;
}

async function signConnectState(userId: string, historyDepthDays: number): Promise<string> {
  return new SignJWT({ sub: userId, historyDepthDays })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
}

async function verifyConnectState(state: string): Promise<{ userId: string; historyDepthDays: number }> {
  try {
    const verified = await jwtVerify(state, new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
    const payload = verified.payload as { sub?: string; historyDepthDays?: number };
    if (!payload.sub) throw new Error("missing sub");
    return { userId: payload.sub, historyDepthDays: payload.historyDepthDays ?? 90 };
  } catch {
    throw new BadRequestException({ code: "INVALID_OAUTH_STATE", message: "OAuth state is invalid or expired." });
  }
}

/** Maps a thrown error to a `/connections?error=...` code the Connections page can show a specific message for. */
function connectorErrorRedirect(env: ReturnType<typeof loadEnv>, err: unknown): string {
  let code = "connector_failed";
  if (err instanceof ConnectorNotConfiguredError) {
    code = "connector_not_configured";
  } else if (err && typeof err === "object" && "getResponse" in err && typeof (err as { getResponse: unknown }).getResponse === "function") {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (response && typeof response === "object" && "code" in response) code = String((response as { code: unknown }).code).toLowerCase();
  }
  return `${env.WEB_APP_URL}/connections?error=${encodeURIComponent(code)}`;
}
