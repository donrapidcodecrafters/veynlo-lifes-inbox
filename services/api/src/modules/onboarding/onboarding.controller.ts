import { Body, Controller, Get, Patch, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { OnboardingService } from "./onboarding.service";
import { UpdateOnboardingStateDtoSchema, type UpdateOnboardingStateDto } from "./dto";

@Controller("v1/onboarding")
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("state")
  getState(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.getState(user.userId);
  }

  @Patch("state")
  @UsePipes(new ZodValidationPipe(UpdateOnboardingStateDtoSchema))
  updateState(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateOnboardingStateDto) {
    return this.onboarding.updateState(user.userId, dto);
  }

  @Post("complete")
  complete(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.complete(user.userId);
  }

  @Post("skip")
  skip(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.skip(user.userId);
  }
}
