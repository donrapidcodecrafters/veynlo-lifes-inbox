import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./admin.guard";
import { AdminAuthService } from "./admin-auth.service";

@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, AdminAuthService],
})
export class AdminModule {}
