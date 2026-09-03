import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AssetsService } from "./assets.service";
import {
  CreateMaintenanceRecordDtoSchema,
  CreatePropertyProfileDtoSchema,
  CreateVehicleProfileDtoSchema,
  UpdatePropertyProfileDtoSchema,
  UpdateVehicleProfileDtoSchema,
  CreateOdometerObservationDtoSchema,
  CreateTireDtoSchema,
  RecordTireRotationDtoSchema,
  ReplaceTireDtoSchema,
  CreateHomeAssetDtoSchema,
  UpdateHomeAssetDtoSchema,
  DecodeVinDtoSchema,
  CreateMaintenanceRuleDtoSchema,
  UpdateMaintenanceRuleDtoSchema,
  CompleteMaintenanceRuleDtoSchema,
  CreateMaintenanceRuleFromTemplateDtoSchema,
  CreateRegistrationRecordDtoSchema,
  UpdateRegistrationRecordDtoSchema,
  RenewRegistrationRecordDtoSchema,
  MergeVehiclesDtoSchema,
  MergePropertiesDtoSchema,
  type MergeVehiclesDto,
  type MergePropertiesDto,
  type CreateMaintenanceRecordDto,
  type CreatePropertyProfileDto,
  type CreateVehicleProfileDto,
  type UpdatePropertyProfileDto,
  type UpdateVehicleProfileDto,
  type CreateOdometerObservationDto,
  type CreateTireDto,
  type RecordTireRotationDto,
  type ReplaceTireDto,
  type CreateHomeAssetDto,
  type UpdateHomeAssetDto,
  type DecodeVinDto,
  type CreateMaintenanceRuleDto,
  type UpdateMaintenanceRuleDto,
  type CompleteMaintenanceRuleDto,
  type CreateMaintenanceRuleFromTemplateDto,
  type CreateRegistrationRecordDto,
  type UpdateRegistrationRecordDto,
  type RenewRegistrationRecordDto,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";

/** Phase 2 §52.2 "Home/property and vehicle profiles; service/warranty/maintenance history." */
@Controller("v1")
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly assets: AssetsService) {}

  @Get("properties")
  listProperties(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.listProperties(user.userId);
  }

  @Post("properties")
  @UsePipes(new ZodValidationPipe(CreatePropertyProfileDtoSchema))
  createProperty(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePropertyProfileDto) {
    return this.assets.createProperty(user.userId, dto);
  }

  // §40.1/40.2 — surfaced before :id so it isn't shadowed by the generic "properties/:id" route below
  // (same ordering reasoning as PeopleController's own merge-candidates/merge-lineage routes).
  @Get("properties/merge-candidates")
  findPropertyMergeCandidates(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.findPropertyMergeCandidates(user.userId);
  }

  @Get("properties/merge-lineage")
  listPropertyMergeLineage(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.listPropertyMergeLineage(user.userId);
  }

  @Post("properties/merge")
  @UsePipes(new ZodValidationPipe(MergePropertiesDtoSchema))
  mergeProperties(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergePropertiesDto) {
    return this.assets.mergeProperties(dto.survivingPropertyId, dto.mergedPropertyId, user.userId);
  }

  @Post("properties/merge-lineage/:lineageId/unmerge")
  unmergeProperties(@CurrentUser() user: AuthenticatedUser, @Param("lineageId") lineageId: string) {
    return this.assets.unmergeProperties(lineageId, user.userId);
  }

  @Get("properties/:id")
  async propertyDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const result = await this.assets.propertyDetail(id, user.userId);
    if (!result) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
    return result;
  }

  @Put("properties/:id")
  @UsePipes(new ZodValidationPipe(UpdatePropertyProfileDtoSchema))
  async updateProperty(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePropertyProfileDto) {
    await this.assets.updateProperty(id, user.userId, dto);
    return { success: true };
  }

  @Delete("properties/:id")
  async deleteProperty(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.deleteProperty(id, user.userId);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — mirrors documents.controller.ts's
  // grants/share-links routes exactly, generalized via SharingService.
  @Post("properties/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createPropertyGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.assets.createPropertyGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get("properties/:id/grants")
  listPropertyGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listPropertyGrants(id, user.userId);
  }

  // SHARE-001 "preview exactly what recipient will see" — same reasoning as ListsController's own.
  @Get("properties/:id/share-preview")
  propertySharePreview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.propertySharePreview(id, user.userId);
  }

  @Delete("properties/grants/:grantId")
  async revokePropertyGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.assets.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post("properties/:id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createPropertyShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.assets.createPropertyShareLink(id, user.userId, dto);
  }

  @Get("properties/:id/share-links")
  listPropertyShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listPropertyShareLinks(id, user.userId);
  }

  @Delete("properties/share-links/:linkId")
  async revokePropertyShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.assets.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get("properties/:id/access-log")
  listPropertyAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listPropertyAccessEvents(id, user.userId);
  }

  @Get("vehicles")
  listVehicles(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.listVehicles(user.userId);
  }

  @Post("vehicles")
  @UsePipes(new ZodValidationPipe(CreateVehicleProfileDtoSchema))
  createVehicle(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVehicleProfileDto) {
    return this.assets.createVehicle(user.userId, dto);
  }

  // §40.1/40.2 — surfaced before :id so it isn't shadowed by the generic "vehicles/:id" route below.
  @Get("vehicles/merge-candidates")
  findVehicleMergeCandidates(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.findVehicleMergeCandidates(user.userId);
  }

  @Get("vehicles/merge-lineage")
  listVehicleMergeLineage(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.listVehicleMergeLineage(user.userId);
  }

  @Post("vehicles/merge")
  @UsePipes(new ZodValidationPipe(MergeVehiclesDtoSchema))
  mergeVehicles(@CurrentUser() user: AuthenticatedUser, @Body() dto: MergeVehiclesDto) {
    return this.assets.mergeVehicles(dto.survivingVehicleId, dto.mergedVehicleId, user.userId);
  }

  @Post("vehicles/merge-lineage/:lineageId/unmerge")
  unmergeVehicles(@CurrentUser() user: AuthenticatedUser, @Param("lineageId") lineageId: string) {
    return this.assets.unmergeVehicles(lineageId, user.userId);
  }

  @Get("vehicles/:id")
  async vehicleDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const result = await this.assets.vehicleDetail(id, user.userId);
    if (!result) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    return result;
  }

  @Put("vehicles/:id")
  @UsePipes(new ZodValidationPipe(UpdateVehicleProfileDtoSchema))
  async updateVehicle(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateVehicleProfileDto) {
    await this.assets.updateVehicle(id, user.userId, dto);
    return { success: true };
  }

  @Delete("vehicles/:id")
  async deleteVehicle(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.deleteVehicle(id, user.userId);
    return { success: true };
  }

  // --- VIN decode (VEH-001) ------------------------------------------------------------------------------

  /** Standalone — used by the "add a vehicle" form before any vehicle exists yet. Query param (not a body)
   * since this is conceptually a read/lookup, mirroring GET-shaped external lookups elsewhere in this app;
   * kept as POST anyway (not GET) since it makes an outbound third-party call on every invocation and
   * shouldn't be treated as cacheable/safely-repeatable by an intermediary. */
  @Post("vehicles/vin-decode")
  @UsePipes(new ZodValidationPipe(DecodeVinDtoSchema))
  decodeVinStandalone(@CurrentUser() _user: AuthenticatedUser, @Body() dto: DecodeVinDto) {
    return this.assets.decodeVinStandalone(dto);
  }

  /** Applies a decode to an existing vehicle — fills empty make/model/year, always stores the raw decoded
   * attributes. `vin` in the body is optional; omitted, this decodes whatever VIN is already on file. */
  @Post("vehicles/:id/vin-decode")
  decodeVinForVehicle(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: { vin?: string }) {
    return this.assets.applyVinDecode(id, user.userId, body?.vin);
  }

  @Post("vehicles/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createVehicleGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.assets.createVehicleGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get("vehicles/:id/grants")
  listVehicleGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listVehicleGrants(id, user.userId);
  }

  @Get("vehicles/:id/share-preview")
  vehicleSharePreview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.vehicleSharePreview(id, user.userId);
  }

  @Delete("vehicles/grants/:grantId")
  async revokeVehicleGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.assets.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post("vehicles/:id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createVehicleShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.assets.createVehicleShareLink(id, user.userId, dto);
  }

  @Get("vehicles/:id/share-links")
  listVehicleShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listVehicleShareLinks(id, user.userId);
  }

  @Delete("vehicles/share-links/:linkId")
  async revokeVehicleShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.assets.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get("vehicles/:id/access-log")
  listVehicleAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.listVehicleAccessEvents(id, user.userId);
  }

  @Post("maintenance-records")
  @UsePipes(new ZodValidationPipe(CreateMaintenanceRecordDtoSchema))
  createMaintenanceRecord(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMaintenanceRecordDto) {
    return this.assets.createMaintenanceRecord(user.userId, dto);
  }

  // --- Odometer / tires (VEH-001/VEH-007) ---------------------------------------------------------------

  @Post("odometer-observations")
  @UsePipes(new ZodValidationPipe(CreateOdometerObservationDtoSchema))
  recordOdometerObservation(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOdometerObservationDto) {
    return this.assets.recordOdometerObservation(user.userId, dto);
  }

  @Post("tires")
  @UsePipes(new ZodValidationPipe(CreateTireDtoSchema))
  createTire(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTireDto) {
    return this.assets.createTire(user.userId, dto);
  }

  @Post("tires/:id/rotate")
  @UsePipes(new ZodValidationPipe(RecordTireRotationDtoSchema))
  async recordTireRotation(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: RecordTireRotationDto) {
    await this.assets.recordTireRotation(id, user.userId, dto);
    return { success: true };
  }

  @Post("tires/:id/replace")
  @UsePipes(new ZodValidationPipe(ReplaceTireDtoSchema))
  async replaceTire(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: ReplaceTireDto) {
    await this.assets.replaceTire(id, user.userId, dto);
    return { success: true };
  }

  // --- Home assets (HOMEOS-008) --------------------------------------------------------------------------

  @Post("home-assets")
  @UsePipes(new ZodValidationPipe(CreateHomeAssetDtoSchema))
  createHomeAsset(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateHomeAssetDto) {
    return this.assets.createHomeAsset(user.userId, dto);
  }

  @Put("home-assets/:id")
  @UsePipes(new ZodValidationPipe(UpdateHomeAssetDtoSchema))
  async updateHomeAsset(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateHomeAssetDto) {
    await this.assets.updateHomeAsset(id, user.userId, dto);
    return { success: true };
  }

  @Delete("home-assets/:id")
  async deleteHomeAsset(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.deleteHomeAsset(id, user.userId);
    return { success: true };
  }

  // --- Maintenance rules (HOMEOS-004/VEH-003) -------------------------------------------------------------

  @Get("vehicles/:id/maintenance-rule-templates")
  listVehicleMaintenanceTemplates(@CurrentUser() _user: AuthenticatedUser, @Param("id") _id: string) {
    return this.assets.listVehicleMaintenanceTemplates();
  }

  @Get("home-assets/:id/maintenance-rule-templates")
  listHomeMaintenanceTemplates(@CurrentUser() _user: AuthenticatedUser, @Param("id") _id: string) {
    return this.assets.listHomeMaintenanceTemplates();
  }

  @Post("maintenance-rules")
  @UsePipes(new ZodValidationPipe(CreateMaintenanceRuleDtoSchema))
  createMaintenanceRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMaintenanceRuleDto) {
    return this.assets.createMaintenanceRule(user.userId, dto);
  }

  @Post("maintenance-rules/from-template")
  @UsePipes(new ZodValidationPipe(CreateMaintenanceRuleFromTemplateDtoSchema))
  createMaintenanceRuleFromTemplate(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMaintenanceRuleFromTemplateDto) {
    return this.assets.createMaintenanceRuleFromTemplate(user.userId, dto);
  }

  @Put("maintenance-rules/:id")
  @UsePipes(new ZodValidationPipe(UpdateMaintenanceRuleDtoSchema))
  async updateMaintenanceRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateMaintenanceRuleDto) {
    await this.assets.updateMaintenanceRule(id, user.userId, dto);
    return { success: true };
  }

  @Delete("maintenance-rules/:id")
  async deleteMaintenanceRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.deleteMaintenanceRule(id, user.userId);
    return { success: true };
  }

  @Post("maintenance-rules/:id/complete")
  @UsePipes(new ZodValidationPipe(CompleteMaintenanceRuleDtoSchema))
  async completeMaintenanceRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CompleteMaintenanceRuleDto) {
    await this.assets.completeMaintenanceRule(id, user.userId, dto);
    return { success: true };
  }

  // --- Registration / inspection / emissions records (VEH-004) --------------------------------------------

  @Post("registration-records")
  @UsePipes(new ZodValidationPipe(CreateRegistrationRecordDtoSchema))
  createRegistrationRecord(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRegistrationRecordDto) {
    return this.assets.createRegistrationRecord(user.userId, dto);
  }

  @Put("registration-records/:id")
  @UsePipes(new ZodValidationPipe(UpdateRegistrationRecordDtoSchema))
  async updateRegistrationRecord(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateRegistrationRecordDto) {
    await this.assets.updateRegistrationRecord(id, user.userId, dto);
    return { success: true };
  }

  @Delete("registration-records/:id")
  async deleteRegistrationRecord(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.deleteRegistrationRecord(id, user.userId);
    return { success: true };
  }

  @Post("registration-records/:id/renew")
  @UsePipes(new ZodValidationPipe(RenewRegistrationRecordDtoSchema))
  async renewRegistrationRecord(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: RenewRegistrationRecordDto) {
    await this.assets.renewRegistrationRecord(id, user.userId, dto);
    return { success: true };
  }

  // --- Recall monitoring (VEH-006/HOMEOS-008) -------------------------------------------------------------

  @Post("vehicles/:id/check-recalls")
  checkVehicleRecalls(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.checkVehicleRecallsNow(id, user.userId);
  }

  @Post("home-assets/:id/check-recalls")
  checkHomeAssetRecalls(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.assets.checkHomeAssetRecallsNow(id, user.userId);
  }

  @Post("recall-matches/:id/confirm")
  async confirmRecallMatch(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.confirmRecallMatch(id, user.userId);
    return { success: true };
  }

  @Post("recall-matches/:id/resolve")
  async resolveRecallMatch(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assets.resolveRecallMatch(id, user.userId);
    return { success: true };
  }
}
