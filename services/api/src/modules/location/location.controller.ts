import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { LocationService } from "./location.service";
import {
  CreatePlaceDtoSchema,
  UpdatePlaceDtoSchema,
  ExtractPlaceCandidateDtoSchema,
  CreateGeofenceDtoSchema,
  UpdateGeofenceDtoSchema,
  CreateContextRuleDtoSchema,
  UpdateContextRuleDtoSchema,
  RecordGeofenceEventDtoSchema,
  UpsertLocationPermissionStateDtoSchema,
  EstimateTravelTimeDtoSchema,
  type CreatePlaceDto,
  type UpdatePlaceDto,
  type ExtractPlaceCandidateDto,
  type CreateGeofenceDto,
  type UpdateGeofenceDto,
  type CreateContextRuleDto,
  type UpdateContextRuleDto,
  type RecordGeofenceEventDto,
  type UpsertLocationPermissionStateDto,
  type EstimateTravelTimeDto,
} from "./dto";

/** Phase 3 §30 "Location & Context" (LOC-001/002/003/004/005 buildable subset). */
@Controller("v1")
@UseGuards(AuthGuard)
export class LocationController {
  constructor(@Inject(LocationService) private readonly location: LocationService) {}

  @Get("places")
  listPlaces(@CurrentUser() user: AuthenticatedUser) {
    return this.location.listPlaces(user.userId);
  }

  @Post("places")
  @UsePipes(new ZodValidationPipe(CreatePlaceDtoSchema))
  createPlace(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePlaceDto) {
    return this.location.createPlace(user.userId, dto);
  }

  @Post("places/extract")
  @UsePipes(new ZodValidationPipe(ExtractPlaceCandidateDtoSchema))
  extractPlaceCandidate(@Body() dto: ExtractPlaceCandidateDto) {
    return { candidate: this.location.extractPlaceCandidate(dto.text) };
  }

  @Patch("places/:id")
  @UsePipes(new ZodValidationPipe(UpdatePlaceDtoSchema))
  updatePlace(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePlaceDto) {
    return this.location.updatePlace(id, user.userId, dto);
  }

  @Delete("places/:id")
  async deletePlace(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.location.deletePlace(id, user.userId);
    return { success: true };
  }

  @Get("geofences")
  listGeofences(@CurrentUser() user: AuthenticatedUser) {
    return this.location.listGeofences(user.userId);
  }

  @Post("geofences")
  @UsePipes(new ZodValidationPipe(CreateGeofenceDtoSchema))
  createGeofence(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateGeofenceDto) {
    return this.location.createGeofence(user.userId, dto);
  }

  @Patch("geofences/:id")
  @UsePipes(new ZodValidationPipe(UpdateGeofenceDtoSchema))
  updateGeofence(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateGeofenceDto) {
    return this.location.updateGeofence(id, user.userId, dto);
  }

  @Delete("geofences/:id")
  async deleteGeofence(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.location.deleteGeofence(id, user.userId);
    return { success: true };
  }

  @Get("context-rules")
  listContextRules(@CurrentUser() user: AuthenticatedUser) {
    return this.location.listContextRules(user.userId);
  }

  @Post("context-rules")
  @UsePipes(new ZodValidationPipe(CreateContextRuleDtoSchema))
  createContextRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContextRuleDto) {
    return this.location.createContextRule(user.userId, dto);
  }

  @Patch("context-rules/:id")
  @UsePipes(new ZodValidationPipe(UpdateContextRuleDtoSchema))
  updateContextRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateContextRuleDto) {
    return this.location.updateContextRule(id, user.userId, dto);
  }

  @Delete("context-rules/:id")
  async deleteContextRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.location.deleteContextRule(id, user.userId);
    return { success: true };
  }

  // Called by the mobile app's background geofence-event handler — see LocationService.recordGeofenceEvent's
  // doc comment for why this is the only device-fed write path in this module and what it does and doesn't store.
  @Post("geofence-events")
  @UsePipes(new ZodValidationPipe(RecordGeofenceEventDtoSchema))
  recordGeofenceEvent(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordGeofenceEventDto) {
    return this.location.recordGeofenceEvent(user.userId, dto);
  }

  @Get("geofence-events")
  listGeofenceEvents(@CurrentUser() user: AuthenticatedUser, @Query("limit") limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.location.listGeofenceEvents(user.userId, parsed && Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get("location-permission-state")
  getPermissionState(@CurrentUser() user: AuthenticatedUser) {
    return this.location.getPermissionState(user.userId);
  }

  @Put("location-permission-state")
  @UsePipes(new ZodValidationPipe(UpsertLocationPermissionStateDtoSchema))
  upsertPermissionState(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpsertLocationPermissionStateDto) {
    return this.location.upsertPermissionState(user.userId, dto);
  }

  @Post("travel-estimates")
  @UsePipes(new ZodValidationPipe(EstimateTravelTimeDtoSchema))
  estimateTravelTime(@CurrentUser() user: AuthenticatedUser, @Body() dto: EstimateTravelTimeDto) {
    return this.location.estimateTravelTime(user.userId, dto);
  }
}
