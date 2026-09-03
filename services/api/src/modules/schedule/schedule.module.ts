import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AssetsModule } from "../assets/assets.module";
import { SearchIndexModule } from "../search/search-index.module";
import { ScheduleController } from "./schedule.controller";
import { ScheduleService } from "./schedule.service";
import { ConflictService } from "./conflict.service";

@Module({
  // AssetsModule — VEH-007 "mileage" recurrence rules resolve their due status against a vehicle's
  // odometer history (AssetsService.latestOdometerMileage/earliestOdometerMileage), a DB lookup this
  // module doesn't own. Safe to import here: AssetsModule doesn't depend on ScheduleModule (and its own
  // SafeUrlFetcher dependency is provided directly rather than via IngestionModule specifically to avoid
  // creating that cycle — see assets.module.ts's own doc comment), so this stays one-directional.
  imports: [IdentityModule, HouseholdModule, NotificationsModule, AssetsModule, SearchIndexModule],
  controllers: [ScheduleController],
  providers: [ScheduleService, ConflictService],
  exports: [ScheduleService, ConflictService],
})
export class ScheduleModule {}
