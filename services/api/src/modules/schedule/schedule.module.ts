import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { ScheduleController } from "./schedule.controller";
import { ScheduleService } from "./schedule.service";

@Module({
  imports: [IdentityModule, HouseholdModule, ConnectorsModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
