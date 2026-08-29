import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ScheduleService } from "./schedule.service";
import { CreateTaskDtoSchema, type CreateTaskDto, UpdateTaskDtoSchema, type UpdateTaskDto } from "./dto";

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

  @Post("events/:id/push-to-calendar")
  pushEventToCalendar(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.pushEventToCalendar(id, user.userId);
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
}
