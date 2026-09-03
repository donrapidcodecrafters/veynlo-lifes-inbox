import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { ConnectorsService } from "./connectors.service";
import { GoogleCalendarAdapter, type WriteBackEventInput } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";

/**
 * CAL-001 "write-back capability" — the single place both `POST /v1/calendar-events/:id/push` (a manually
 * created/edited event) and InboxService.addToCalendar (a discovered event's destination choice) go to
 * actually push a local `calendar_events` row to a connected, write-back-enabled provider calendar.
 * Deliberately its own service rather than living on either adapter: it owns the "create vs. update"
 * decision and the local-row bookkeeping (`providerEventId`/`writeBackConnectionId`/`writeBackStatus`),
 * neither of which either adapter needs to know about — they just expose `createEvent`/`updateEvent`.
 */
@Injectable()
export class CalendarWriteBackService {
  private readonly logger = new Logger(CalendarWriteBackService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(GoogleCalendarAdapter) private readonly googleCalendar: GoogleCalendarAdapter,
    @Inject(MicrosoftCalendarAdapter) private readonly microsoftCalendar: MicrosoftCalendarAdapter,
  ) {}

  private toWriteBackInput(event: typeof schema.calendarEvents.$inferSelect): WriteBackEventInput {
    return {
      title: event.title,
      location: event.location,
      isAllDay: event.isAllDay,
      startInstantUtc: event.start.precision === "instant" ? event.start.instantUtc : null,
      startDate: event.start.precision === "date" ? event.start.date : null,
      endInstantUtc: event.end && event.end.precision === "instant" ? event.end.instantUtc : null,
      endDate: event.end && event.end.precision === "date" ? event.end.date : null,
    };
  }

  /**
   * Pushes `eventId` (a row the caller has already verified is owned by `ownerUserId`) to `connectionId`.
   * Validation failures (wrong provider, write-back not enabled, event not found) throw immediately — those
   * are the caller's mistake to fix, not a transient provider failure. An actual provider-call failure
   * (network, revoked token, rate limit) is deliberately swallowed: it's logged and the local
   * `calendar_events` row is flagged `writeBackStatus: "failed"`, but the row itself — and the local event
   * the user is looking at — is left completely intact. A write-back push is additive to what's already a
   * complete, useful local event; losing it because a Google API call timed out would be strictly worse
   * than just telling the user "saved, but couldn't sync to Google Calendar yet."
   */
  async pushEvent(params: { eventId: string; ownerUserId: string; connectionId: string }): Promise<{ pushed: boolean }> {
    const [event] = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.id, params.eventId), eq(schema.calendarEvents.ownerUserId, params.ownerUserId)))
      .limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event not found." });

    const connection = await this.connectors.getOwned(params.connectionId, params.ownerUserId);
    if (connection.provider !== "google_calendar" && connection.provider !== "microsoft_calendar") {
      throw new BadRequestException({ code: "UNSUPPORTED_PROVIDER", message: "This connection can't receive pushed events." });
    }
    if (!connection.writeBackEnabled) {
      throw new BadRequestException({ code: "WRITE_BACK_DISABLED", message: "Turn on write-back for this calendar before pushing events to it." });
    }

    const input = this.toWriteBackInput(event);
    const adapter = connection.provider === "google_calendar" ? this.googleCalendar : this.microsoftCalendar;
    try {
      if (event.writeBackConnectionId === connection.id && event.providerEventId) {
        await adapter.updateEvent(connection.id, event.providerEventId, input);
        await this.db.update(schema.calendarEvents).set({ writeBackStatus: "pushed", updatedAt: new Date() }).where(eq(schema.calendarEvents.id, event.id));
      } else {
        const { providerEventId } = await adapter.createEvent(connection.id, input);
        await this.db
          .update(schema.calendarEvents)
          .set({ providerEventId, writeBackConnectionId: connection.id, writeBackStatus: "pushed", updatedAt: new Date() })
          .where(eq(schema.calendarEvents.id, event.id));
      }
      return { pushed: true };
    } catch (err) {
      this.logger.error(`Write-back push failed for event ${event.id} to connection ${connection.id}: ${String(err)}`);
      await this.db.update(schema.calendarEvents).set({ writeBackStatus: "failed", updatedAt: new Date() }).where(eq(schema.calendarEvents.id, event.id));
      return { pushed: false };
    }
  }

  /**
   * AUTO-006/CAL-001 "an event pushed to a connected calendar must not be silently orphaned there once its
   * local row is deleted" — the delete counterpart to `pushEvent`, and the single place BOTH the generic
   * `DELETE /v1/calendar-events/:eventId` endpoint (`CalendarActionsController`) and
   * `AutomationService.undoRun` go to delete a `calendar_events` row. Same "local deletion is the real
   * boundary, provider-side is defense-in-depth" stance this session already established for connector-token
   * revocation: a best-effort provider-side delete is attempted FIRST (log-and-continue on failure — a
   * network blip, an already-revoked token, or the event having already been deleted/moved on the provider
   * side must never block the user's own explicit local delete), then the local row itself is removed
   * unconditionally. Only attempts the provider call when the row actually carries both
   * `providerEventId`/`writeBackConnectionId` — an event that was never pushed (or whose push failed before
   * either was set) has nothing to clean up remotely.
   */
  async deleteEvent(params: { eventId: string; ownerUserId: string }): Promise<{ deleted: boolean }> {
    const [event] = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.id, params.eventId), eq(schema.calendarEvents.ownerUserId, params.ownerUserId)))
      .limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event not found." });

    if (event.providerEventId && event.writeBackConnectionId) {
      const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, event.writeBackConnectionId)).limit(1);
      const adapter = connection?.provider === "google_calendar" ? this.googleCalendar : connection?.provider === "microsoft_calendar" ? this.microsoftCalendar : null;
      if (connection && adapter) {
        try {
          await adapter.deleteEvent(connection.id, event.providerEventId);
        } catch (err) {
          this.logger.error(`Provider-side delete failed for event ${event.id} on connection ${connection.id} — deleting the local row anyway: ${String(err)}`);
        }
      }
    }

    await this.db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, event.id));
    return { deleted: true };
  }
}
