import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PeopleService } from "./people.service";
import { CreatePersonDtoSchema, type CreatePersonDto, UpdatePersonDtoSchema, type UpdatePersonDto } from "./dto";

@Controller("v1/people")
@UseGuards(AuthGuard)
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.people.listPeople(user.userId);
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
