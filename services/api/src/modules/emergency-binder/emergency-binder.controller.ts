import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { EmergencyBinderService } from "./emergency-binder.service";
import { UnlockEmergencyBinderDtoSchema, UpdateEmergencyBinderSettingsDtoSchema, type UnlockEmergencyBinderDto, type UpdateEmergencyBinderSettingsDto } from "./dto";

/** Phase 2 §52.2 "emergency binder" — see emergency-binder.service.ts's own doc comment for the full shape. */
@Controller("v1/emergency-binder")
@UseGuards(AuthGuard)
export class EmergencyBinderController {
  constructor(@Inject(EmergencyBinderService) private readonly binder: EmergencyBinderService) {}

  @Get(":householdId/settings")
  getSettings(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.binder.getSettings(householdId, user.userId);
  }

  @Patch(":householdId/settings")
  @UsePipes(new ZodValidationPipe(UpdateEmergencyBinderSettingsDtoSchema))
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Body() dto: UpdateEmergencyBinderSettingsDto) {
    return this.binder.updateSettings(householdId, user.userId, dto);
  }

  // POST, not GET, deliberately: unlocking the full aggregated packet takes a password in the body (§28.9
  // step-up), same shape as data-export's requestExport/connectors' disconnect — a GET can't cleanly carry
  // a request body across every client/proxy this app runs behind.
  @Post(":householdId/unlock")
  @UsePipes(new ZodValidationPipe(UnlockEmergencyBinderDtoSchema))
  unlock(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Body() dto: UnlockEmergencyBinderDto) {
    return this.binder.getBinder(householdId, user.userId, dto.password);
  }
}
