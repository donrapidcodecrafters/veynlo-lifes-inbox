import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { LegacyReleaseService } from "./legacy-release.service";
import {
  CreateLegacyReleaseConfigDtoSchema,
  type CreateLegacyReleaseConfigDto,
  ConfirmLegacyReleaseConfigDtoSchema,
  type ConfirmLegacyReleaseConfigDto,
} from "./legacy-release.dto";

/** §35 SHARE-006 "Future trusted delegate / legacy release" — owner-facing setup/revocation. See
 * LegacyReleaseService's own doc comment for the full lifecycle and what's deliberately NOT automated. */
@Controller("v1/legacy-release")
@UseGuards(AuthGuard)
export class LegacyReleaseController {
  constructor(@Inject(LegacyReleaseService) private readonly legacyRelease: LegacyReleaseService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateLegacyReleaseConfigDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLegacyReleaseConfigDto) {
    return this.legacyRelease.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.legacyRelease.list(user.userId);
  }

  /** The explicit, step-up-password-gated "arm" confirmation — see LegacyReleaseService.confirm's own doc
   * comment on why a draft alone does nothing. */
  @Post(":id/confirm")
  @UsePipes(new ZodValidationPipe(ConfirmLegacyReleaseConfigDtoSchema))
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: ConfirmLegacyReleaseConfigDto) {
    return this.legacyRelease.confirm(id, user.userId, dto.password);
  }

  @Post(":id/cancel-pending-release")
  cancelPendingRelease(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.legacyRelease.cancelPendingRelease(id, user.userId);
  }

  @Delete(":id")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.legacyRelease.revoke(id, user.userId);
  }
}
