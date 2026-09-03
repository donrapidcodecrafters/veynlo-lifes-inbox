import { BadRequestException, Body, Controller, Get, Inject, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { OnboardingService } from "./onboarding.service";
import {
  AdvanceStepDtoSchema,
  ConsentPreviewQuerySchema,
  HouseholdInviteOfferedDtoSchema,
  ScanStartDtoSchema,
  SetGoalDtoSchema,
  SetHistoryDepthDtoSchema,
  type AdvanceStepDto,
  type HouseholdInviteOfferedDto,
  type ScanStartDto,
  type SetGoalDto,
  type SetHistoryDepthDto,
} from "./dto";

/**
 * ONB-001/ONB-002 — the onboarding orchestration surface. Every mutation route resolves the current user's
 * `onboarding_state` row rather than trusting client-supplied ids, and every route 404s
 * (`ONBOARDING_NOT_APPLICABLE`, see OnboardingService.requireRow) for an account that predates this
 * feature and never got a row — onboarding is never retroactively forced on an existing user.
 */
@Controller("v1/onboarding")
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Get("state")
  getState(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.getState(user.userId);
  }

  @Post("goal")
  @UsePipes(new ZodValidationPipe(SetGoalDtoSchema))
  setGoal(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetGoalDto) {
    return this.onboarding.setGoal(user.userId, dto.goal);
  }

  @Get("consent-preview")
  consentPreview(@Query() query: unknown) {
    const parsed = ConsentPreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ code: "INVALID_CONNECTOR", message: "connector must be one of gmail, outlook, plaid." });
    }
    return this.onboarding.consentPreview(parsed.data.connector);
  }

  @Post("history-depth")
  @UsePipes(new ZodValidationPipe(SetHistoryDepthDtoSchema))
  setHistoryDepth(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetHistoryDepthDto) {
    return this.onboarding.setHistoryDepth(user.userId, dto.choice);
  }

  @Post("scan-start")
  @UsePipes(new ZodValidationPipe(ScanStartDtoSchema))
  startScan(@CurrentUser() user: AuthenticatedUser, @Body() dto: ScanStartDto) {
    return this.onboarding.startScan(user.userId, dto.connectionId);
  }

  @Get("scan-progress")
  scanProgress(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.scanProgress(user.userId);
  }

  @Post("advance")
  @UsePipes(new ZodValidationPipe(AdvanceStepDtoSchema))
  advance(@CurrentUser() user: AuthenticatedUser, @Body() dto: AdvanceStepDto) {
    return this.onboarding.setStep(user.userId, dto.step);
  }

  @Post("household-invite-offered")
  @UsePipes(new ZodValidationPipe(HouseholdInviteOfferedDtoSchema))
  householdInviteOffered(@CurrentUser() user: AuthenticatedUser, @Body() _dto: HouseholdInviteOfferedDto) {
    return this.onboarding.recordHouseholdInviteOffered(user.userId);
  }

  @Post("skip")
  skip(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.skip(user.userId);
  }

  @Post("complete")
  complete(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.complete(user.userId);
  }
}
