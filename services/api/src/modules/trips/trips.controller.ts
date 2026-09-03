import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TripsService } from "./trips.service";
import {
  CreateTripDtoSchema,
  type CreateTripDto,
  UpdateTripDtoSchema,
  type UpdateTripDto,
  SetTripTravelerDtoSchema,
  type SetTripTravelerDto,
  MergeTripsDtoSchema,
  type MergeTripsDto,
  CreateManualTripSegmentDtoSchema,
  type CreateManualTripSegmentDto,
  CreateTravelCreditDtoSchema,
  type CreateTravelCreditDto,
  AddSegmentToCalendarDtoSchema,
  type AddSegmentToCalendarDto,
  SetSegmentCheckInReminderDtoSchema,
  type SetSegmentCheckInReminderDto,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";

@Controller("v1/trips")
@UseGuards(AuthGuard)
export class TripsController {
  constructor(@Inject(TripsService) private readonly trips: TripsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.trips.listTrips(user.userId);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(CreateTripDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTripDto) {
    return this.trips.createManualTrip(user.userId, dto);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.trips.tripDetail(id, user.userId);
  }

  @Put(":id")
  @UsePipes(new ZodValidationPipe(UpdateTripDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateTripDto) {
    await this.trips.updateTrip(id, user.userId, dto);
    return { success: true };
  }

  @Post(":id/travelers")
  @UsePipes(new ZodValidationPipe(SetTripTravelerDtoSchema))
  async addTraveler(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetTripTravelerDto) {
    await this.trips.setTraveler(id, user.userId, dto.travelerUserId, true);
    return { success: true };
  }

  @Delete(":id/travelers/:travelerUserId")
  async removeTraveler(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Param("travelerUserId") travelerUserId: string) {
    await this.trips.setTraveler(id, user.userId, travelerUserId, false);
    return { success: true };
  }

  /** TRIP-001 "Confirm trip merge" — merges `sourceTripId` (in the body) into `:id`; see
   * TripsService.mergeTrips's own doc comment. */
  @Post(":id/merge")
  @UsePipes(new ZodValidationPipe(MergeTripsDtoSchema))
  merge(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MergeTripsDto) {
    return this.trips.mergeTrips(id, dto.sourceTripId, user.userId);
  }

  @Post(":id/segments")
  @UsePipes(new ZodValidationPipe(CreateManualTripSegmentDtoSchema))
  addSegment(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateManualTripSegmentDto) {
    return this.trips.addManualSegment(id, user.userId, dto);
  }

  // --- Segment actions: "Open confirmation" / "Add calendar" / "Set check-in reminder" ----------------

  /** "Open confirmation" — the original email's subject/snippet/date this segment was extracted from. */
  @Get("segments/:segmentId/evidence")
  segmentEvidence(@CurrentUser() user: AuthenticatedUser, @Param("segmentId") segmentId: string) {
    return this.trips.segmentEvidence(segmentId, user.userId);
  }

  @Post("segments/:segmentId/calendar")
  @UsePipes(new ZodValidationPipe(AddSegmentToCalendarDtoSchema))
  addSegmentToCalendar(@CurrentUser() user: AuthenticatedUser, @Param("segmentId") segmentId: string, @Body() dto: AddSegmentToCalendarDto) {
    return this.trips.addSegmentToCalendar(segmentId, user.userId, dto);
  }

  @Put("segments/:segmentId/check-in-reminder")
  @UsePipes(new ZodValidationPipe(SetSegmentCheckInReminderDtoSchema))
  async setSegmentCheckInReminder(@CurrentUser() user: AuthenticatedUser, @Param("segmentId") segmentId: string, @Body() dto: SetSegmentCheckInReminderDto) {
    await this.trips.setSegmentCheckInReminder(segmentId, user.userId, dto);
    return { success: true };
  }

  // --- Travel credits (TRIP-007) -----------------------------------------------------------------------

  @Get("credits/all")
  listCredits(@CurrentUser() user: AuthenticatedUser) {
    return this.trips.listTravelCredits(user.userId);
  }

  @Post("credits")
  @UsePipes(new ZodValidationPipe(CreateTravelCreditDtoSchema))
  createCredit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTravelCreditDto) {
    return this.trips.createTravelCredit(user.userId, dto);
  }

  @Post("credits/:creditId/redeem")
  async redeemCredit(@CurrentUser() user: AuthenticatedUser, @Param("creditId") creditId: string) {
    await this.trips.redeemTravelCredit(creditId, user.userId);
    return { success: true };
  }

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) --------------------------------------------

  @Post(":id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.trips.createResourceGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays);
  }

  @Get(":id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.trips.listResourceGrants(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.trips.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post(":id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.trips.createShareLink(id, user.userId, dto);
  }

  @Get(":id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.trips.listShareLinks(id, user.userId);
  }

  @Delete("share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.trips.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get(":id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.trips.listAccessEvents(id, user.userId);
  }
}
