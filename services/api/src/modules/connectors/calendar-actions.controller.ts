import { Body, Controller, Delete, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { CalendarWriteBackService } from "./calendar-write-back.service";

/**
 * CAL-001 write-back — the manual-event-creation half of the flow (a discovered event's destination choice
 * goes through InboxService.addToCalendar instead, which needs InboxService's own ownership/reviewState
 * machinery). Lives in the connectors module rather than schedule/attention because it needs both
 * ScheduleService-shaped local-row access (via CalendarWriteBackService) and the calendar adapters, and
 * ConnectorsModule already sits "above" ScheduleModule in the import graph — putting it here avoids a
 * module cycle instead of having ScheduleModule import ConnectorsModule.
 */
@Controller("v1/calendar-events")
@UseGuards(AuthGuard)
export class CalendarActionsController {
  constructor(@Inject(CalendarWriteBackService) private readonly writeBack: CalendarWriteBackService) {}

  @Post(":eventId/push")
  push(@CurrentUser() user: AuthenticatedUser, @Param("eventId") eventId: string, @Body("connectionId") connectionId: string) {
    return this.writeBack.pushEvent({ eventId, ownerUserId: user.userId, connectionId });
  }

  /**
   * AUTO-006/CAL-001 — the generic delete counterpart to `push` above, and the only place (besides
   * AutomationService.undoRun) any calendar event actually gets deleted through provider-aware cleanup
   * rather than a plain `db.delete`. Works on any owned event, pushed or not — `CalendarWriteBackService.
   * deleteEvent` itself no-ops the provider call when there's nothing to clean up remotely.
   */
  @Delete(":eventId")
  delete(@CurrentUser() user: AuthenticatedUser, @Param("eventId") eventId: string) {
    return this.writeBack.deleteEvent({ eventId, ownerUserId: user.userId });
  }
}
