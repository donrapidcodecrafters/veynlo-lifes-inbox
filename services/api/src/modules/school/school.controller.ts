import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SchoolService } from "./school.service";
import {
  CreateSchoolDtoSchema,
  CreateSchoolSourceDtoSchema,
  AssignChildDtoSchema,
  CorrectSchoolDtoSchema,
  AdvanceFormStateDtoSchema,
  CreatePermissionFormDtoSchema,
  type CreateSchoolDto,
  type CreateSchoolSourceDto,
  type AssignChildDto,
  type CorrectSchoolDto,
  type AdvanceFormStateDto,
  type CreatePermissionFormDto,
} from "./dto";

/** §25 "School, Children & Activities" — SCH-001/002/005/006/007. */
@Controller("v1/school")
@UseGuards(AuthGuard)
export class SchoolController {
  constructor(@Inject(SchoolService) private readonly school: SchoolService) {}

  @Get("schools")
  listSchools(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listSchools(user.userId);
  }

  @Post("schools")
  @UsePipes(new ZodValidationPipe(CreateSchoolDtoSchema))
  createSchool(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSchoolDto) {
    return this.school.createSchool(user.userId, dto);
  }

  @Get("sources")
  listSources(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listSchoolSources(user.userId);
  }

  @Post("sources")
  @UsePipes(new ZodValidationPipe(CreateSchoolSourceDtoSchema))
  createSource(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSchoolSourceDto) {
    return this.school.createSchoolSource(user.userId, dto);
  }

  @Post("sources/:id/unsubscribe")
  async unsubscribeSource(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.school.unsubscribeSchoolSource(id, user.userId);
    return { success: true };
  }

  @Post("sources/:id/resync")
  async resyncSource(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.school.resyncSchoolSource(id, user.userId);
    return { success: true };
  }

  @Get("events")
  listEvents(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listSchoolEvents(user.userId);
  }

  @Put("events/:id/assign-child")
  @UsePipes(new ZodValidationPipe(AssignChildDtoSchema))
  async assignChild(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AssignChildDto) {
    await this.school.assignChild(id, user.userId, dto.dependentId);
    return { success: true };
  }

  // SCH-001 "correct school" — see CorrectSchoolDtoSchema's own doc comment.
  @Put("events/:id/correct-school")
  @UsePipes(new ZodValidationPipe(CorrectSchoolDtoSchema))
  async correctSchool(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CorrectSchoolDto) {
    await this.school.correctSchoolEvent(id, user.userId, dto.schoolId);
    return { success: true };
  }

  @Get("events/:id/prep-tasks")
  prepTasks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.school.prepTasksForEvent(id, user.userId);
  }

  @Get("forms")
  listForms(@CurrentUser() user: AuthenticatedUser) {
    return this.school.listPermissionForms(user.userId);
  }

  @Post("forms")
  @UsePipes(new ZodValidationPipe(CreatePermissionFormDtoSchema))
  createForm(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePermissionFormDto) {
    return this.school.createPermissionForm(user.userId, dto);
  }

  // SCH-001 "correct school" — the form-side counterpart to events/:id/correct-school above.
  @Put("forms/:id/correct-school")
  @UsePipes(new ZodValidationPipe(CorrectSchoolDtoSchema))
  async correctFormSchool(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CorrectSchoolDto) {
    await this.school.correctPermissionFormSchool(id, user.userId, dto.schoolId);
    return { success: true };
  }

  @Put("forms/:id/state")
  @UsePipes(new ZodValidationPipe(AdvanceFormStateDtoSchema))
  async advanceFormState(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AdvanceFormStateDto) {
    await this.school.advanceFormState(id, user.userId, dto.state);
    return { success: true };
  }

  // Family transport conflicts (school-relevant slice of CAL-003) — read here; resolution reuses the
  // existing generic POST /v1/schedule-conflicts/:id/resolve (ConflictService.resolveConflict already
  // handles the "school_transport" kind's household-membership authorization — see its own doc comment).
  @Get("conflicts")
  transportConflicts(@CurrentUser() user: AuthenticatedUser) {
    return this.school.unresolvedTransportConflicts(user.userId);
  }
}
