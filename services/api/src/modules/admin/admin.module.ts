import { Module } from "@nestjs/common";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { SearchModule } from "../search/search.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { BillingModule } from "../billing/billing.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";

@Module({
  imports: [FeatureFlagsModule, SearchModule, IntelligenceModule, BillingModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, SuperAdminGuard, AdminAuthService],
})
export class AdminModule {}
