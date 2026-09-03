import { Body, Controller, Get, Inject, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PreferencesService } from "./preferences.service";
import {
  UpdateHomeModulePreferencesDtoSchema,
  type UpdateHomeModulePreferencesDto,
  UpdateCategoryPreferenceDtoSchema,
  type UpdateCategoryPreferenceDto,
  UpdatePersonalizationPreferencesDtoSchema,
  type UpdatePersonalizationPreferencesDto,
  RevealFinancialPrivacyDtoSchema,
  type RevealFinancialPrivacyDto,
} from "./dto";

@Controller("v1")
@UseGuards(AuthGuard)
export class PreferencesController {
  constructor(@Inject(PreferencesService) private readonly preferences: PreferencesService) {}

  // PERS-002 Home customization
  @Get("home-module-preferences")
  getHomeModulePreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.getHomeModulePreferences(user.userId);
  }

  @Put("home-module-preferences")
  @UsePipes(new ZodValidationPipe(UpdateHomeModulePreferencesDtoSchema))
  updateHomeModulePreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateHomeModulePreferencesDto) {
    return this.preferences.updateHomeModulePreferences(user.userId, dto);
  }

  // PERS-003 Category preferences
  @Get("category-preferences")
  listCategoryPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.listCategoryPreferences(user.userId);
  }

  @Put("category-preferences")
  @UsePipes(new ZodValidationPipe(UpdateCategoryPreferenceDtoSchema))
  updateCategoryPreference(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateCategoryPreferenceDto) {
    return this.preferences.updateCategoryPreference(user.userId, dto);
  }

  // PERS-004/PERS-005 Personalization (naming/language + AI tone)
  @Get("personalization-preferences")
  getPersonalizationPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.getPersonalizationPreferences(user.userId);
  }

  @Put("personalization-preferences")
  @UsePipes(new ZodValidationPipe(UpdatePersonalizationPreferencesDtoSchema))
  updatePersonalizationPreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePersonalizationPreferencesDto) {
    return this.preferences.updatePersonalizationPreferences(user.userId, dto);
  }

  // FIN-007 "biometric reveal option" — web's step-up counterpart to mobile's on-device biometric unlock.
  @Post("financial-privacy/reveal")
  @UsePipes(new ZodValidationPipe(RevealFinancialPrivacyDtoSchema))
  revealFinancialPrivacy(@CurrentUser() user: AuthenticatedUser, @Body() dto: RevealFinancialPrivacyDto) {
    return this.preferences.revealFinancialPrivacy(user.userId, dto.password);
  }
}
