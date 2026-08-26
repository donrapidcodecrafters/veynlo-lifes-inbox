import { Module } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";

@Module({
  controllers: [IdentityController],
  providers: [IdentityService, AuthGuard],
  exports: [IdentityService, AuthGuard],
})
export class IdentityModule {}
