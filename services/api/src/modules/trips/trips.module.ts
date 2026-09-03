import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { ListsModule } from "../lists/lists.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { SearchIndexModule } from "../search/search-index.module";
import { TripsController } from "./trips.controller";
import { TripsService } from "./trips.service";

@Module({
  // ScheduleModule — the "Add to calendar" trip-segment action (TripsService.addSegmentToCalendar) reuses
  // ScheduleService.createEvent rather than a parallel event-creation path. Safe to import here: ScheduleModule
  // (IdentityModule/HouseholdModule/NotificationsModule/AssetsModule) doesn't depend on TripsModule, so this
  // stays one-directional — same precedent as ScheduleModule's own AssetsModule import.
  imports: [HouseholdModule, SharingModule, ListsModule, ScheduleModule, SearchIndexModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
