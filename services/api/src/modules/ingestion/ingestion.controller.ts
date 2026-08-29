import { Body, Controller, Post, UseGuards, UsePipes } from "@nestjs/common";
import type { TemporalValue } from "@veynlo/core";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IngestionService } from "./ingestion.service";
import { IngestManualDtoSchema, IngestDeviceCalendarDtoSchema, type IngestManualDto, type IngestDeviceCalendarDto } from "./dto";

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
  constructor(private readonly ingestion: IngestionService) {}

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
}
