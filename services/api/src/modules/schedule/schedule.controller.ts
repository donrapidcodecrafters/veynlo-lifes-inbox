import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ScheduleService } from "./schedule.service";
import {
  AssignTaskDtoSchema,
  CreateTaskDtoSchema,
  CreateEventDtoSchema,
  SetTaskRecurrenceDtoSchema,
  SetEventRecurrenceDtoSchema,
  SetEventReminderDtoSchema,
  SetEventVehicleDtoSchema,
  type AssignTaskDto,
  type CreateTaskDto,
  type CreateEventDto,
  type SetTaskRecurrenceDto,
  type SetEventRecurrenceDto,
  type SetEventReminderDto,
  type SetEventVehicleDto,
} from "./dto";

@Controller("v1")
@UseGuards(AuthGuard)
export class ScheduleController {
  constructor(@Inject(ScheduleService) private readonly schedule: ScheduleService) {}

  @Get("events")
  events(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.upcomingEvents(user.userId);
  }

  @Get("events/:id")
  eventDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.eventDetail(id, user.userId);
  }

  @Post("events")
  @UsePipes(new ZodValidationPipe(CreateEventDtoSchema))
  createEvent(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEventDto) {
    return this.schedule.createEvent(user.userId, dto);
  }

  @Put("events/:id/recurrence")
  @UsePipes(new ZodValidationPipe(SetEventRecurrenceDtoSchema))
  async setEventRecurrence(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetEventRecurrenceDto) {
    await this.schedule.setEventRecurrence(id, user.userId, dto.recurrenceRule);
    return { success: true };
  }

  @Put("events/:id/reminder")
  @UsePipes(new ZodValidationPipe(SetEventReminderDtoSchema))
  async setEventReminder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetEventReminderDto) {
    await this.schedule.setEventReminder(id, user.userId, dto.reminderMinutesBefore);
    return { success: true };
  }

  // CAL-003 "double-booked shared assets" — set/clear which vehicle this event is "using." Returns any
  // vehicle_double_booked conflicts the change just turned up, same immediate-feedback shape createEvent
  // already returns for true-overlap conflicts.
  @Put("events/:id/vehicle")
  @UsePipes(new ZodValidationPipe(SetEventVehicleDtoSchema))
  setEventVehicle(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetEventVehicleDto) {
    return this.schedule.setEventVehicle(id, user.userId, dto.vehicleProfileId);
  }

  // CAL-003 — conflict listing/resolve. Not nested under /events since a conflict names *two* events, not
  // one, and the Life page's conflict banner needs to list them independently of any single event page.
  @Get("schedule-conflicts")
  unresolvedConflicts(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.unresolvedConflicts(user.userId);
  }

  @Post("schedule-conflicts/:id/resolve")
  async resolveConflict(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.schedule.resolveConflict(id, user.userId);
    return { success: true };
  }

  @Get("tasks")
  tasks(@CurrentUser() user: AuthenticatedUser) {
    return this.schedule.tasks(user.userId);
  }

  @Post("tasks")
  @UsePipes(new ZodValidationPipe(CreateTaskDtoSchema))
  createTask(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.schedule.createTask(user.userId, dto);
  }

  @Post("tasks/:id/complete")
  complete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.schedule.completeTask(id, user.userId);
  }

  @Put("tasks/:id/recurrence")
  @UsePipes(new ZodValidationPipe(SetTaskRecurrenceDtoSchema))
  async setTaskRecurrence(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetTaskRecurrenceDto) {
    await this.schedule.setTaskRecurrence(id, user.userId, dto.recurrenceRule);
    return { success: true };
  }

  @Put("tasks/:id/assign")
  @UsePipes(new ZodValidationPipe(AssignTaskDtoSchema))
  async assign(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AssignTaskDto) {
    await this.schedule.assignTask(id, user.userId, dto.assignedToUserId, dto.assignmentNotes);
    return { success: true };
  }

  @Post("tasks/:id/accept")
  async accept(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.schedule.acceptAssignment(id, user.userId);
    return { success: true };
  }

  @Post("tasks/:id/decline")
  async decline(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.schedule.declineAssignment(id, user.userId);
    return { success: true };
  }
}
