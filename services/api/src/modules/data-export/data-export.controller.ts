import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { DataExportService } from "./data-export.service";

/** PRIV-002 — self-service export of everything Veynlo has on the caller. */
@Controller("v1/data-export")
@UseGuards(AuthGuard)
export class DataExportController {
  constructor(private readonly dataExport: DataExportService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.dataExport.list(user.userId);
  }

  @Post()
  request(@CurrentUser() user: AuthenticatedUser) {
    return this.dataExport.requestExport(user.userId);
  }

  @Get(":id/download-url")
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return { url: await this.dataExport.downloadUrl(id, user.userId) };
  }
}
