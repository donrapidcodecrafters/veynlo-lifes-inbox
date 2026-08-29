import { Module } from "@nestjs/common";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";

@Module({
  imports: [FeatureFlagsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, SuperAdminGuard, AdminAuthService],
})
export class AdminModule {}
