import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CaregiverDayPassService } from "./caregiver-day-pass.service";
import { CreateCaregiverDayPassDtoSchema, type CreateCaregiverDayPassDto } from "./caregiver-day-pass.dto";

/** §35 SHARE-005 "Caregiver/day pass" — mirrors EmergencyBinderController's own
 * "v1/<feature>/:householdId/..." shape. */
@Controller("v1/caregiver-day-passes")
@UseGuards(AuthGuard)
export class CaregiverDayPassController {
  constructor(@Inject(CaregiverDayPassService) private readonly dayPasses: CaregiverDayPassService) {}

  @Post(":householdId")
  @UsePipes(new ZodValidationPipe(CreateCaregiverDayPassDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Body() dto: CreateCaregiverDayPassDto) {
    return this.dayPasses.create(householdId, user.userId, dto);
  }

  @Get(":householdId")
  list(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.dayPasses.list(householdId, user.userId);
  }

  @Delete(":householdId/:passId")
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Param("passId") passId: string) {
    await this.dayPasses.revoke(householdId, passId, user.userId);
    return { success: true };
  }
}
