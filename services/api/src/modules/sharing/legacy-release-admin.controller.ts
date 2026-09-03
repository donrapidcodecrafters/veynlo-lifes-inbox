import { Controller, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../admin/admin.guard";
import { SuperAdminGuard } from "../admin/super-admin.guard";
import { CurrentAdmin } from "../admin/current-admin.decorator";
import type { AuthenticatedAdmin } from "../admin/admin.guard";
import { LegacyReleaseService } from "./legacy-release.service";

/**
 * §35 SHARE-006 "carefully verified process... multi-party verification" — the manual admin-operated
 * release path (see LegacyReleaseService's own doc comment for why this is manual, not an automatic
 * inactivity-triggered cron). Two distinct required actions, two distinct required roles: any admin
 * operator may start the waiting period, but only a superadmin may finalize it once elapsed.
 */
@Controller("v1/admin/legacy-release")
@UseGuards(AdminGuard)
export class LegacyReleaseAdminController {
  constructor(@Inject(LegacyReleaseService) private readonly legacyRelease: LegacyReleaseService) {}

  @Post(":id/initiate")
  initiate(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.legacyRelease.initiateRelease(id, admin.id);
  }

  @Post(":id/finalize")
  @UseGuards(SuperAdminGuard)
  finalize(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.legacyRelease.finalizeRelease(id, admin.id);
  }
}
