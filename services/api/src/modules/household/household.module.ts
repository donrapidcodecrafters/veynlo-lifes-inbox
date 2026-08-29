import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HouseholdController } from "./household.controller";
import { HouseholdService } from "./household.service";

@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [HouseholdController],
  providers: [HouseholdService],
  exports: [HouseholdService],
})
export class HouseholdModule {}
