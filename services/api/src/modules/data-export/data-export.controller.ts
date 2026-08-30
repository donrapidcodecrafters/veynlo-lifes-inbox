import { Body, Controller, Get, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IdentityService } from "../identity/identity.service";
import { DataExportService } from "./data-export.service";
import { RequestExportDtoSchema, type RequestExportDto } from "./dto";

/** PRIV-002 — self-service export of everything Veynlo has on the caller. */
@Controller("v1/data-export")
@UseGuards(AuthGuard)
export class DataExportController {
  constructor(
    private readonly dataExport: DataExportService,
    private readonly identity: IdentityService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.dataExport.list(user.userId);
  }

  /** A full export of everything Veynlo has on this user is exactly the kind of sensitive, hard-to-undo
   * data egress that warrants the same step-up password reauth as account deletion, not just the standing
   * session AuthGuard already checks on every request. */
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(RequestExportDtoSchema))
  async request(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestExportDto) {
    await this.identity.verifyPassword(user.userId, dto.password);
    return this.dataExport.requestExport(user.userId);
  }

  @Get(":id/download-url")
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return { url: await this.dataExport.downloadUrl(id, user.userId) };
  }
}
