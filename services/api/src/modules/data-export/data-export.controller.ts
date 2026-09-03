import { Body, Controller, Get, Inject, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { UserThrottlerGuard } from "../../common/user-throttler.guard";
import { DataExportService } from "./data-export.service";
import { RequestExportDtoSchema, type RequestExportDto } from "./dto";

/** PRIV-002 — self-service export of everything Veynlo has on the caller. */
@Controller("v1/data-export")
@UseGuards(AuthGuard)
export class DataExportController {
  constructor(@Inject(DataExportService) private readonly dataExport: DataExportService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.dataExport.list(user.userId);
  }

  // §28.8 "per-user quotas for ... export" — a full-account export is a real, if modest, worker/S3 cost
  // per job; nothing previously bounded how many a user could enqueue back-to-back. UserThrottlerGuard
  // (not the global IP-based one) so this is a genuine per-user quota, not a shared-IP bucket that could
  // 429 a brand-new user's first-ever request just because someone else on the same network used theirs.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @UseGuards(UserThrottlerGuard)
  @Post()
  @UsePipes(new ZodValidationPipe(RequestExportDtoSchema))
  request(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestExportDto) {
    return this.dataExport.requestExport(user.userId, dto.password, dto.selectedCategories);
  }

  @Get(":id/download-url")
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return { url: await this.dataExport.downloadUrl(id, user.userId) };
  }
}
