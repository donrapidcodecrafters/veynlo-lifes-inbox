import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { CommerceController } from "./commerce.controller";
import { CommerceService } from "./commerce.service";

@Module({
  imports: [IdentityModule, HouseholdModule],
  controllers: [CommerceController],
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
