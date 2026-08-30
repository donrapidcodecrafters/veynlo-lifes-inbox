import { Controller, Get, Put, Body, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { NotificationsService } from "./notifications.service";

@Controller("v1")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get("notifications")
  list(@CurrentUser() user: AuthenticatedUser, @Query("before") before?: string) {
    return this.notifications.list(user.userId, before);
  }

  @Get("notification-preferences")
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.userId);
  }

  @Put("notification-preferences")
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body() patch: Record<string, unknown>) {
    return this.notifications.updatePreferences(user.userId, patch);
  }
}
