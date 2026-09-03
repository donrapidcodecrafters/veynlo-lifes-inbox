import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto } from "../sharing/dto";
import { PeopleService } from "./people.service";
import {
  CreatePersonDtoSchema,
  type CreatePersonDto,
  UpdatePersonDtoSchema,
  type UpdatePersonDto,
  SetRelationshipLabelDtoSchema,
  type SetRelationshipLabelDto,
  SetPersonVisibilityDtoSchema,
  type SetPersonVisibilityDto,
  AddAliasDtoSchema,
  type AddAliasDto,
  AddPersonNoteDtoSchema,
  type AddPersonNoteDto,
  AddImportantDateDtoSchema,
  type AddImportantDateDto,
  AddPersonRelationshipDtoSchema,
  type AddPersonRelationshipDto,
  CreateOrganizationDtoSchema,
  type CreateOrganizationDto,
  LinkRelatedEntityDtoSchema,
  type LinkRelatedEntityDto,
  MergePeopleDtoSchema,
  type MergePeopleDto,
} from "./dto";

/** §14 "Contacts, People & Relationships" (PEO-001..005) — see PeopleService's own doc comment for the full shape. */
@Controller("v1")
@UseGuards(AuthGuard)
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly people: PeopleService) {}

  @Get("people")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.people.list(user.userId);
  }

  @Post("people")
  @UsePipes(new ZodValidationPipe(CreatePersonDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePersonDto) {
    return this.people.create(user.userId, dto);
  }

  // PEO-002 — surfaced before :id so it isn't shadowed by the generic "people/:id" route below.
  @Get("people/merge-candidates")
  findMergeCandidates(@CurrentUser() user: AuthenticatedUser) {
    return this.people.findMergeCandidates(user.userId);
  }

  @Get("people/merge-lineage")
  listMergeLineage(@CurrentUser() user: AuthenticatedUser) {
    return this.people.listMergeLineage(user.userId);
  }

  @Post("people/merge")
  @UsePipes(new ZodValidationPipe(MergePeopleDtoSchema))
  merge(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergePeopleDto) {
    return this.people.mergePeople(dto.survivingPersonId, dto.mergedPersonId, user.userId);
  }

  @Post("people/merge-lineage/:lineageId/unmerge")
  unmerge(@CurrentUser() user: AuthenticatedUser, @Param("lineageId") lineageId: string) {
    return this.people.unmergePeople(lineageId, user.userId);
  }

  @Get("organizations")
  listOrganizations(@CurrentUser() user: AuthenticatedUser) {
    return this.people.listOrganizations(user.userId);
  }

  @Post("organizations")
  @UsePipes(new ZodValidationPipe(CreateOrganizationDtoSchema))
  createOrganization(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.people.createOrganization(user.userId, dto);
  }

  @Get("people/:id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.people.detail(id, user.userId);
  }

  @Patch("people/:id")
  @UsePipes(new ZodValidationPipe(UpdatePersonDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePersonDto) {
    await this.people.update(id, user.userId, dto);
    return { success: true };
  }

  @Delete("people/:id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.people.remove(id, user.userId);
    return { success: true };
  }

  @Patch("people/:id/visibility")
  @UsePipes(new ZodValidationPipe(SetPersonVisibilityDtoSchema))
  async setVisibility(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetPersonVisibilityDto) {
    await this.people.setVisibility(id, user.userId, dto.visibility);
    return { success: true };
  }

  @Patch("people/:id/relationship-label")
  @UsePipes(new ZodValidationPipe(SetRelationshipLabelDtoSchema))
  async setRelationshipLabel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetRelationshipLabelDto) {
    await this.people.setRelationshipLabel(id, user.userId, dto.relationshipLabel);
    return { success: true };
  }

  @Post("people/:id/relationship-label/confirm")
  async confirmSuggestedRelationshipLabel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.people.confirmSuggestedRelationshipLabel(id, user.userId);
    return { success: true };
  }

  @Post("people/:id/record-contact")
  async recordContact(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.people.recordContact(id, user.userId);
    return { success: true };
  }

  @Post("people/:id/aliases")
  @UsePipes(new ZodValidationPipe(AddAliasDtoSchema))
  addAlias(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddAliasDto) {
    return this.people.addAlias(id, user.userId, dto);
  }

  @Delete("people/aliases/:aliasId")
  async removeAlias(@CurrentUser() user: AuthenticatedUser, @Param("aliasId") aliasId: string) {
    await this.people.removeAlias(aliasId, user.userId);
    return { success: true };
  }

  @Post("people/:id/notes")
  @UsePipes(new ZodValidationPipe(AddPersonNoteDtoSchema))
  addNote(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddPersonNoteDto) {
    return this.people.addNote(id, user.userId, dto);
  }

  @Delete("people/notes/:noteId")
  async removeNote(@CurrentUser() user: AuthenticatedUser, @Param("noteId") noteId: string) {
    await this.people.removeNote(noteId, user.userId);
    return { success: true };
  }

  @Post("people/:id/important-dates")
  @UsePipes(new ZodValidationPipe(AddImportantDateDtoSchema))
  addImportantDate(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddImportantDateDto) {
    return this.people.addImportantDate(id, user.userId, dto);
  }

  @Delete("people/important-dates/:dateId")
  async removeImportantDate(@CurrentUser() user: AuthenticatedUser, @Param("dateId") dateId: string) {
    await this.people.removeImportantDate(dateId, user.userId);
    return { success: true };
  }

  @Post("people/:id/relationships")
  @UsePipes(new ZodValidationPipe(AddPersonRelationshipDtoSchema))
  addRelationship(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddPersonRelationshipDto) {
    return this.people.addRelationship(id, user.userId, dto);
  }

  @Delete("people/relationships/:relationshipId")
  async removeRelationship(@CurrentUser() user: AuthenticatedUser, @Param("relationshipId") relationshipId: string) {
    await this.people.removeRelationship(relationshipId, user.userId);
    return { success: true };
  }

  @Post("people/:id/linked-entities")
  @UsePipes(new ZodValidationPipe(LinkRelatedEntityDtoSchema))
  async linkEntity(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: LinkRelatedEntityDto) {
    await this.people.linkEntity(id, user.userId, dto.entityId);
    return { success: true };
  }

  @Delete("people/:id/linked-entities/:entityId")
  async unlinkEntity(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Param("entityId") entityId: string) {
    await this.people.unlinkEntity(id, user.userId, entityId);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001) — mirrors PetsController's grants routes.
  @Post("people/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.people.createGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get("people/:id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.people.listGrants(id, user.userId);
  }

  @Delete("people/grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.people.revokeGrant(grantId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant (people has no public-link
   * sharing mode — see PeopleService's own sharing-section doc comment). */
  @Get("people/:id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.people.listAccessEvents(id, user.userId);
  }
}
