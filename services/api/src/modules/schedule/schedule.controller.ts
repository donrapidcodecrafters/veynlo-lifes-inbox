import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ScheduleService } from "./schedule.service";

@Controller("v1")
@UseGuards(AuthGuard)
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get("events")
  events(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.upcomingEvents(user.userId);
  }

  @Get("events/:id")
  eventDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.eventDetail(id, user.userId);
  }

  @Get("tasks")
  tasks(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.tasks(user.userId);
  }

  @Post("tasks/:id/complete")
  complete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.completeTask(id, user.userId);
  }
}
