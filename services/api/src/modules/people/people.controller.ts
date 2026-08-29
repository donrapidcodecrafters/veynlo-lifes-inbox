import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PeopleService } from "./people.service";
import { CreatePersonDtoSchema, type CreatePersonDto, UpdatePersonDtoSchema, type UpdatePersonDto, MergePeopleDtoSchema, type MergePeopleDto } from "./dto";

@Controller("v1/people")
@UseGuards(AuthGuard)
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.people.listPeople(user.userId);
  }

  // Must come before the ":id" route below — otherwise Nest would try to resolve "duplicate-candidates"
  // etc. as a person id.
  @Get("duplicate-candidates")
  duplicateCandidates(@CurrentUser() user: AuthenticatedUser) {
    return this.people.findDuplicatePersonCandidates(user.userId);
  }

  @Get("merge-lineage")
  mergeLineage(@CurrentUser() user: AuthenticatedUser) {
    return this.people.listPersonMergeLineage(user.userId);
  }

  @Post("merge")
  @UsePipes(new ZodValidationPipe(MergePeopleDtoSchema))
  merge(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergePeopleDto) {
    return this.people.mergePeople(dto.survivingId, dto.mergedId, user.userId);
  }

  @Post("merge-lineage/:lineageId/unmerge")
  unmerge(@CurrentUser() user: AuthenticatedUser, @Param("lineageId") lineageId: string) {
    return this.people.unmergePeople(lineageId, user.userId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.people.getPerson(id, user.userId);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(CreatePersonDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePersonDto) {
    return this.people.createPerson(user.userId, null, dto);
  }

  @Patch(":id")
  @UsePipes(new ZodValidationPipe(UpdatePersonDtoSchema))
  update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePersonDto) {
    return this.people.updatePerson(id, user.userId, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.people.deletePerson(id, user.userId);
  }
}
