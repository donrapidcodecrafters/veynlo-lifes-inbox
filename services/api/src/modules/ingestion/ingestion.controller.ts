import { BadRequestException, Body, Controller, Post, Req, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { TemporalValue } from "@veynlo/core";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IngestionService } from "./ingestion.service";
import { SafeUrlFetcher } from "./safe-url-fetcher";
import {
  IngestManualDtoSchema,
  IngestDeviceCalendarDtoSchema,
  IngestDeviceRemindersDtoSchema,
  IngestUrlDtoSchema,
  type IngestManualDto,
  type IngestDeviceCalendarDto,
  type IngestDeviceRemindersDto,
  type IngestUrlDto,
} from "./dto";

function deviceEventTemporal(iso: string, isAllDay: boolean): TemporalValue {
  if (isAllDay) return { precision: "date", instantUtc: null, date: iso.slice(0, 10), timezone: null, sourceText: null };
  return { precision: "instant", instantUtc: new Date(iso).toISOString(), date: null, timezone: null, sourceText: null };
}

/**
 * Manual/share-capture ingestion entry point (§CAP-005/006 forward + quick-text
 * capture). Also doubles as the fastest way to validate the pipeline end to
 * end in environments without live Gmail OAuth configured.
 */
@Controller("v1/ingestion")
@UseGuards(AuthGuard)
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly urlFetcher: SafeUrlFetcher,
  ) {}

  @Post("manual")
  @UsePipes(new ZodValidationPipe(IngestManualDtoSchema))
  async ingestManual(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestManualDto) {
    return this.ingestion.ingestManualText({
      ownerUserId: user.userId,
      householdId: null,
      subject: dto.subject,
      bodyText: dto.bodyText,
      fromAddress: dto.fromAddress,
    });
  }

  /**
   * §Connections/Capture "URL capture" — fetches the page server-side (see SafeUrlFetcher for the
   * SSRF-safe fetch/redirect handling), extracts its title and readable text, then reuses the exact same
   * manual-capture write path (URL capture already IS a subject+bodyText pair once fetched). Tighter
   * throttle than the global default — this endpoint makes an outbound network request per call, a more
   * abusable resource than a typical CRUD route.
   */
  @Post("url")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(IngestUrlDtoSchema))
  async ingestUrl(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestUrlDto) {
    const { title, text, finalUrl } = await this.urlFetcher.fetchReadableText(dto.url);
    return this.ingestion.ingestManualText({
      ownerUserId: user.userId,
      householdId: null,
      subject: title,
      bodyText: text,
      fromAddress: finalUrl,
      kind: "url_capture",
    });
  }

  /**
   * §Connections "generic import fallback" — upload a plain-text export (an exported reminders list,
   * notes copied from another app) and have every blank-line-separated block filed as its own capture,
   * through the exact same manual-capture pipeline. Tighter throttle than the default — a real batch
   * AI-extraction trigger, same reasoning as the URL-capture route above but for up to 200 items at once.
   */
  @Post("import")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async bulkImport(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException({ code: "NO_FILE", message: "No file was uploaded." });
    const buffer = await file.toBuffer();
    const text = buffer.toString("utf8");
    if (!text.trim()) throw new BadRequestException({ code: "EMPTY_FILE", message: "The uploaded file is empty." });
    return this.ingestion.bulkImport({ ownerUserId: user.userId, householdId: null, text });
  }

  /**
   * §Connections "Apple local calendar" — the mobile app reads the device's own Calendar app via
   * expo-calendar and pushes events here; there's no server-side OAuth token or feed URL to poll for a
   * local calendar, so this is push-from-client rather than a `connections` row this process syncs on its
   * own schedule. connectionId is null throughout (see IngestionService.ingestFeedCalendarEvent) — the
   * idempotency key falls back to scoping by ownerUserId instead.
   */
  @Post("device-calendar")
  @UsePipes(new ZodValidationPipe(IngestDeviceCalendarDtoSchema))
  async ingestDeviceCalendar(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestDeviceCalendarDto) {
    let filedCount = 0;
    for (const event of dto.events) {
      const filed = await this.ingestion.ingestFeedCalendarEvent({
        provider: "device_calendar",
        ownerUserId: user.userId,
        householdId: null,
        connectionId: null,
        uid: event.uid,
        title: event.title,
        start: deviceEventTemporal(event.startIso, event.isAllDay),
        end: event.endIso ? deviceEventTemporal(event.endIso, event.isAllDay) : null,
        isAllDay: event.isAllDay,
        location: event.location,
      });
      if (filed) filedCount += 1;
    }
    return { filedCount, totalCount: dto.events.length };
  }

  /**
   * §Connections "Apple Reminders" — same push-from-client shape as device-calendar above; EventKit
   * reminders have no OS-level equivalent on Android, so this is iOS-only in practice (the mobile client
   * simply never calls this route on Android).
   */
  @Post("device-reminders")
  @UsePipes(new ZodValidationPipe(IngestDeviceRemindersDtoSchema))
  async ingestDeviceReminders(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestDeviceRemindersDto) {
    let filedCount = 0;
    for (const reminder of dto.reminders) {
      const filed = await this.ingestion.ingestFeedTask({
        provider: "apple_reminders",
        ownerUserId: user.userId,
        householdId: null,
        connectionId: null,
        uid: reminder.uid,
        title: reminder.title,
        dueIso: reminder.dueIso,
        notes: reminder.notes,
        completed: reminder.completed,
      });
      if (filed) filedCount += 1;
    }
    return { filedCount, totalCount: dto.reminders.length };
  }
}
