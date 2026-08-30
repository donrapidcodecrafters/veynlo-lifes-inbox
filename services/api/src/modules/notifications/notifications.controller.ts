import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { NotificationsService } from "./notifications.service";
import { AcknowledgeNotificationDtoSchema, type AcknowledgeNotificationDto } from "./dto";

@Controller("v1")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get("notifications")
  list(@CurrentUser() user: AuthenticatedUser, @Query("before") before?: string) {
    return this.notifications.list(user.userId, before);
  }

  @Post("notifications/:id/ack")
  @UsePipes(new ZodValidationPipe(AcknowledgeNotificationDtoSchema))
  acknowledge(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AcknowledgeNotificationDto) {
    return this.notifications.acknowledge(id, user.userId, dto.action);
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
