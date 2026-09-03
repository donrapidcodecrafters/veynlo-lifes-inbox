import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { MemoriesModule } from "../memories/memories.module";
import { LocationController } from "./location.controller";
import { LocationService } from "./location.service";

// MemoriesModule imported here (not the reverse) so a real geofence arrival can fire SAVE-004's
// `location_proximity` resurfacing rules directly — see LocationService.recordGeofenceEvent and
// ResurfacingService.fireLocationProximityResurfacing. MemoriesModule/MemoriesService never import
// anything from this module (a resurfacing rule's `placeId` is validated via a direct `places` table read
// in MemoriesService instead), so this stays a one-directional dependency, no cycle.
@Module({
  imports: [HouseholdModule, MemoriesModule],
  controllers: [LocationController],
  providers: [LocationService],
  exports: [LocationService],
})
export class LocationModule {}
