import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ScheduleService } from "./schedule.service";
import {
  CreateTaskDtoSchema,
  type CreateTaskDto,
  UpdateTaskDtoSchema,
  type UpdateTaskDto,
  PushEventToCalendarDtoSchema,
  type PushEventToCalendarDto,
  PushTaskDtoSchema,
  type PushTaskDto,
} from "./dto";

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

  @Post("events/:id/link-person")
  linkPersonToEvent(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.schedule.setEventPersonLink(id, user.userId, personId, true);
  }

  @Post("events/:id/unlink-person")
  unlinkPersonFromEvent(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.schedule.setEventPersonLink(id, user.userId, personId, false);
  }

  @Post("events/:id/push-to-calendar")
  @UsePipes(new ZodValidationPipe(PushEventToCalendarDtoSchema))
  pushEventToCalendar(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: PushEventToCalendarDto = {}) {
    return this.schedule.pushEventToCalendar(id, user.userId, dto);
  }

  @Post("events/:id/share")
  shareEvent(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.createShareLink(id, user.userId);
  }

  @Post("events/:id/visibility")
  async setEventVisibility(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("visibility") visibility: string) {
    if (visibility !== "private" && visibility !== "household") {
      throw new BadRequestException({ code: "INVALID_VISIBILITY", message: `"${visibility}" isn't a recognized visibility.` });
    }
    await this.schedule.setEventVisibility(id, user.userId, visibility);
    return { ok: true };
  }

  @Post("events/:id/share/revoke")
  async revokeEventShare(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.schedule.revokeShareLinks(id, user.userId);
    return { ok: true };
  }

  @Get("events/:id/grants")
  listEventGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.listEventMemberGrants(id, user.userId);
  }

  @Post("events/:id/grants")
  grantEventMember(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("granteeUserId") granteeUserId: string) {
    return this.schedule.shareEventWithMember(id, user.userId, granteeUserId);
  }

  @Post("events/:id/grants/:grantId/revoke")
  async revokeEventGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Param("grantId") grantId: string) {
    await this.schedule.revokeEventMemberAccess(id, user.userId, grantId);
    return { ok: true };
  }

  @Get("schedule/conflicts")
  conflicts(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.detectConflicts(user.userId);
  }

  @Get("tasks")
  tasks(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.tasks(user.userId);
  }

  @Post("tasks")
  @UsePipes(new ZodValidationPipe(CreateTaskDtoSchema))
  createTask(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    // No current-household concept for a single caller yet (a user can belong to more than one) — manual
    // creation is deliberately account-scoped, same as manual capture elsewhere; a real household-sharing
    // picker is a separate follow-up, not something to guess a default for here.
    return this.schedule.createTask(user.userId, null, dto);
  }

  @Patch("tasks/:id")
  @UsePipes(new ZodValidationPipe(UpdateTaskDtoSchema))
  updateTask(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateTaskDto) {
    return this.schedule.updateTask(id, user.userId, dto);
  }

  @Delete("tasks/:id")
  deleteTask(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.deleteTask(id, user.userId);
  }

  @Post("tasks/:id/complete")
  complete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.completeTask(id, user.userId);
  }

  @Post("tasks/:id/push-to-tasklist")
  @UsePipes(new ZodValidationPipe(PushTaskDtoSchema))
  pushTaskToProvider(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: PushTaskDto = {}) {
    return this.schedule.pushTaskToProvider(id, user.userId, dto);
  }
}
