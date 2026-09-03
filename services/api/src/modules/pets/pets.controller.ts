import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PetsService } from "./pets.service";
import {
  CreatePetProfileDtoSchema,
  UpdatePetProfileDtoSchema,
  CreatePetVaccinationDtoSchema,
  CreateRefillReminderDtoSchema,
  MergePetsDtoSchema,
  type CreatePetProfileDto,
  type UpdatePetProfileDto,
  type CreatePetVaccinationDto,
  type CreateRefillReminderDto,
  type MergePetsDto,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";
import { z } from "zod";

const MarkRefillHandledDtoSchema = z.object({ nextRefillDateIso: z.string().min(1) });
type MarkRefillHandledDto = z.infer<typeof MarkRefillHandledDtoSchema>;

const AssignToPetDtoSchema = z.object({ petProfileId: z.string().min(1) });
type AssignToPetDto = z.infer<typeof AssignToPetDtoSchema>;

/** PET-001..PET-005 (spec ch.28 "Pets") — see PetsService's own doc comment for the full shape. */
@Controller("v1")
@UseGuards(AuthGuard)
export class PetsController {
  constructor(@Inject(PetsService) private readonly pets: PetsService) {}

  @Get("pets")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.pets.list(user.userId);
  }

  @Post("pets")
  @UsePipes(new ZodValidationPipe(CreatePetProfileDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePetProfileDto) {
    return this.pets.create(user.userId, dto);
  }

  // §40.1/40.2 — surfaced before :id so it isn't shadowed by the generic "pets/:id" route below (same
  // ordering reasoning as PeopleController's own merge-candidates/merge-lineage routes).
  @Get("pets/merge-candidates")
  findMergeCandidates(@CurrentUser() user: AuthenticatedUser) {
    return this.pets.findPetMergeCandidates(user.userId);
  }

  @Get("pets/merge-lineage")
  listMergeLineage(@CurrentUser() user: AuthenticatedUser) {
    return this.pets.listPetMergeLineage(user.userId);
  }

  @Post("pets/merge")
  @UsePipes(new ZodValidationPipe(MergePetsDtoSchema))
  merge(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergePetsDto) {
    return this.pets.mergePets(dto.survivingPetId, dto.mergedPetId, user.userId);
  }

  @Post("pets/merge-lineage/:lineageId/unmerge")
  unmerge(@CurrentUser() user: AuthenticatedUser, @Param("lineageId") lineageId: string) {
    return this.pets.unmergePets(lineageId, user.userId);
  }

  @Get("pets/:id")
  async detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const result = await this.pets.detail(id, user.userId);
    if (!result) throw new NotFoundException({ code: "PET_NOT_FOUND", message: "Pet not found." });
    return result;
  }

  @Patch("pets/:id")
  @UsePipes(new ZodValidationPipe(UpdatePetProfileDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePetProfileDto) {
    await this.pets.update(id, user.userId, dto);
    return { success: true };
  }

  @Delete("pets/:id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.pets.remove(id, user.userId);
    return { success: true };
  }

  @Post("pets/:id/vaccinations")
  @UsePipes(new ZodValidationPipe(CreatePetVaccinationDtoSchema))
  addVaccination(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreatePetVaccinationDto) {
    return this.pets.addVaccination(id, user.userId, dto);
  }

  // PET-004 "don't guess" pet-identity matching — the assign side of extractPetVaccination filing an
  // unassigned candidate when it couldn't confidently tell which household pet an email concerned.
  @Get("pet-vaccinations/unassigned")
  unassignedVaccinations(@CurrentUser() user: AuthenticatedUser) {
    return this.pets.unassignedVaccinations(user.userId);
  }

  @Post("pet-vaccinations/:id/assign")
  @UsePipes(new ZodValidationPipe(AssignToPetDtoSchema))
  async assignVaccination(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AssignToPetDto) {
    await this.pets.assignVaccination(id, dto.petProfileId, user.userId);
    return { success: true };
  }

  // PET-002 equivalent for a discovered vet/grooming calendar event filed with no pet resolved.
  @Post("pet-events/:id/assign")
  @UsePipes(new ZodValidationPipe(AssignToPetDtoSchema))
  async assignEvent(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AssignToPetDto) {
    await this.pets.assignEvent(id, dto.petProfileId, user.userId);
    return { success: true };
  }

  @Post("pets/:id/refill-reminders")
  @UsePipes(new ZodValidationPipe(CreateRefillReminderDtoSchema))
  addRefillReminder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateRefillReminderDto) {
    return this.pets.addRefillReminder(id, user.userId, dto);
  }

  // "pet-refill-reminders", not "refill-reminders" — refillReminders is a shared table (see its own schema
  // doc comment) with a separate Health Logistics endpoint surface for its dependent-scoped rows; a shared
  // route prefix here would either collide with that controller's routes or (worse) let this pets-only
  // endpoint reach a human family member's medication row. PetsService's own access checks additionally
  // reject any row that isn't pet-scoped, but the route split is the first, simpler line of defense.
  @Post("pet-refill-reminders/:id/mark-handled")
  @UsePipes(new ZodValidationPipe(MarkRefillHandledDtoSchema))
  async markRefillHandled(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MarkRefillHandledDto) {
    await this.pets.markRefillHandled(id, user.userId, dto.nextRefillDateIso);
    return { success: true };
  }

  @Post("pet-refill-reminders/:id/mark-picked-up")
  async markRefillPickedUp(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.pets.markRefillPickedUp(id, user.userId);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — mirrors assets.controller.ts's
  // properties/vehicles grants/share-links routes exactly, generalized via SharingService.
  @Post("pets/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.pets.createGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get("pets/:id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.pets.listGrants(id, user.userId);
  }

  // SHARE-001 "preview exactly what recipient will see" — same reasoning as ListsController's own.
  @Get("pets/:id/share-preview")
  sharePreview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.pets.sharePreview(id, user.userId);
  }

  @Delete("pets/grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.pets.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post("pets/:id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.pets.createShareLink(id, user.userId, dto);
  }

  @Get("pets/:id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.pets.listShareLinks(id, user.userId);
  }

  @Delete("pets/share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.pets.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get("pets/:id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.pets.listAccessEvents(id, user.userId);
  }
}
