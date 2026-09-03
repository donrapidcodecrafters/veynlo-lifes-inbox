import { Body, Controller, Inject, Param, Post, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CaregiverDayPassService } from "./caregiver-day-pass.service";
import { AccessCaregiverDayPassDtoSchema, type AccessCaregiverDayPassDto } from "./caregiver-day-pass.dto";

/** §35 SHARE-005 — unauthenticated redemption, same posture as PublicShareController (see its own doc
 * comment): a caregiver/house-sitter is not expected to have a Veynlo account at all. Same tight rate
 * limit as PublicShareController for the identical reason (a passcode is brute-forceable given enough
 * requests, even against a high-entropy token). */
@Controller("v1/day-passes")
export class CaregiverDayPassPublicController {
  constructor(@Inject(CaregiverDayPassService) private readonly dayPasses: CaregiverDayPassService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":token/access")
  @UsePipes(new ZodValidationPipe(AccessCaregiverDayPassDtoSchema))
  access(@Param("token") token: string, @Body() dto: AccessCaregiverDayPassDto) {
    return this.dayPasses.access(token, dto.passcode);
  }
}
