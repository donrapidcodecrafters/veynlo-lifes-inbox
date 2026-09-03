import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { IdentityModule } from "../identity/identity.module";
import { EmergencyBinderController } from "./emergency-binder.controller";
import { EmergencyBinderService } from "./emergency-binder.service";

@Module({
  imports: [HouseholdModule, IdentityModule],
  controllers: [EmergencyBinderController],
  providers: [EmergencyBinderService],
  exports: [EmergencyBinderService],
})
export class EmergencyBinderModule {}
