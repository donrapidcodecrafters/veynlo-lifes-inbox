import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";
import { UpdateNotificationPreferencesDtoSchema, type UpdateNotificationPreferencesDto } from "./dto";

@Controller("v1")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get("notifications")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.list(user.userId);
  }

  /**
   * Marks a notification opened. Called from a push tap, and from tapping its row in the in-app list.
   *
   * POST rather than PATCH on the notification: this records an event that happened, it does not let a
   * client set the timestamp, and there is nothing else about a notification a client may change.
   */
  @Post("notifications/:id/opened")
  markOpened(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.notifications.markOpened(id, user.userId);
  }

  @Get("notification-preferences")
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.userId);
  }

  @Put("notification-preferences")
  @UsePipes(new ZodValidationPipe(UpdateNotificationPreferencesDtoSchema))
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body() patch: UpdateNotificationPreferencesDto) {
    return this.notifications.updatePreferences(user.userId, patch);
  }
}
