import { Body, Controller, Get, Inject, Param, Put, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { verifySignedDeepLink } from "../../common/signed-deep-link";
import { WidgetsService } from "./widgets.service";
import { WidgetKindParamSchema, SetWidgetPreferenceDtoSchema, LogAppIntentDtoSchema, ResolveDeepLinkQuerySchema, type SetWidgetPreferenceDto, type LogAppIntentDto } from "./dto";

/**
 * §36 "deep links use signed/internal routes" — a SEPARATE, deliberately unauthenticated controller (no
 * `AuthGuard`), mirroring `PublicShareController`'s own "resource-neutral, token-proves-authorization"
 * shape. Resolving a `createSignedDeepLink`-minted token never returns resource content, only the route to
 * open — the token itself already encodes and HMAC-proves which resource it was minted for, and the app's
 * own normal authorization runs again once that route actually loads the real object. This is exactly what
 * lets a LOCKED device's widget tap hand off into the app without a full interactive sign-in round trip
 * first (§36's own "Locked device" edge case) — requiring a session here would defeat that entirely.
 */
@Controller("v1/widgets")
export class WidgetDeepLinkController {
  @Get("resolve")
  resolveDeepLink(@Query() query: unknown) {
    const { token } = ResolveDeepLinkQuerySchema.parse(query);
    const resource = verifySignedDeepLink(token);
    if (!resource) return { valid: false as const };
    return { valid: true as const, resourceType: resource.resourceType, resourceId: resource.resourceId };
  }
}

/**
 * §36 SYS-001..008 "minimal authorized projection APIs" — real endpoints a future WidgetKit/Glance/App
 * Intents/watchOS/Wear OS/Live-Activities implementation would call. Every projection route (today-summary/
 * next-trip/deliveries) sits behind the SAME `AuthGuard` every other authenticated route in this app uses
 * (a native widget extension shares the app's own Keychain/Keystore-stored session via App Group, the same
 * mechanism this session's iOS share extension already relies on) — there's no separate "widget token"
 * mechanism to build here, since the spec's "signed/internal routes" line is specifically about DEEP LINKS
 * (see resolveDeepLink below and common/signed-deep-link.ts), not the projection query itself.
 */
@Controller("v1/widgets")
@UseGuards(AuthGuard)
export class WidgetsController {
  constructor(@Inject(WidgetsService) private readonly widgets: WidgetsService) {}

  @Get("preferences")
  listPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.widgets.listPreferences(user.userId);
  }

  @Put("preferences/:widgetKind")
  @UsePipes(new ZodValidationPipe(SetWidgetPreferenceDtoSchema))
  async setPreference(@CurrentUser() user: AuthenticatedUser, @Param("widgetKind") widgetKindRaw: string, @Body() dto: SetWidgetPreferenceDto) {
    const { widgetKind } = WidgetKindParamSchema.parse({ widgetKind: widgetKindRaw });
    await this.widgets.setPreference(user.userId, widgetKind, dto);
    return { ok: true };
  }

  @Get("today-summary")
  todaySummary(@CurrentUser() user: AuthenticatedUser) {
    return this.widgets.todaySummary(user.userId);
  }

  @Get("next-trip")
  nextTrip(@CurrentUser() user: AuthenticatedUser) {
    return this.widgets.nextTrip(user.userId);
  }

  @Get("deliveries")
  deliveries(@CurrentUser() user: AuthenticatedUser) {
    return this.widgets.deliveries(user.userId);
  }

  /**
   * SYS-003/004 "Expose safe intents... mutating actions declare confirmation behavior" — logs one App
   * Intent/Android system action/wearable action invocation for the spec's own "shortcut success... wearable
   * action completion" analytics signal. Purely an audit write; it never performs the underlying mutation
   * itself (a real native client calls the actual domain endpoint — e.g. `POST /v1/schedule/tasks/:id/
   * complete` — separately and reports the outcome here).
   */
  @Put("app-intents")
  @UsePipes(new ZodValidationPipe(LogAppIntentDtoSchema))
  logAppIntent(@CurrentUser() user: AuthenticatedUser, @Body() dto: LogAppIntentDto) {
    return this.widgets.logAppIntent(user.userId, dto);
  }
}
