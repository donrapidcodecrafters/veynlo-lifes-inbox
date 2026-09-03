import { Module } from "@nestjs/common";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { IdentityModule } from "../identity/identity.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";

@Module({
  // IdentityModule — AdminService.suspendUser/forceLogoutUser call IdentityService.revokeAllSessions,
  // the same session-revocation path delete-account and the security page's "sign out everywhere" use, so
  // an admin-initiated suspend/force-logout takes effect exactly as immediately as a user-initiated one.
  imports: [FeatureFlagsModule, IdentityModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, SuperAdminGuard, AdminAuthService],
  // §35 SHARE-006 — LegacyReleaseModule's admin-operated release endpoints reuse this same admin-session
  // guard/role-check pair rather than reimplementing "is this an authenticated admin operator" a second
  // time; AdminAuthService is exported alongside since AdminGuard depends on it.
  exports: [AdminGuard, SuperAdminGuard, AdminAuthService],
})
export class AdminModule {}
