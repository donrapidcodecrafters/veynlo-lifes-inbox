import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SearchIndexModule } from "../search/search-index.module";
import { AttentionController } from "./attention.controller";
import { AttentionService } from "./attention.service";
import { InboxService } from "./inbox.service";

@Module({
  // ConnectorsModule (CAL-002's "add to calendar" destination choice needs CalendarWriteBackService) — a
  // one-directional new edge: ConnectorsModule imports ScheduleModule/IngestionModule/etc but never
  // AttentionModule, so this doesn't create a cycle.
  // ScheduleModule (CAL-004's "apply the offered reschedule" action re-runs ConflictService.detectOverlaps
  // — see InboxService.applyRescheduleChange) — also one-directional: ScheduleModule's own imports
  // (Household/Notifications/Assets/Identity) never reach back into AttentionModule.
  // NotificationsModule (§33.1 "Critical: Immediate push ... Important: Push + Home" — see
  // AttentionService.notifyIfUrgent) — NotificationsModule only imports IdentityModule, so this is also a
  // one-directional new edge, no cycle.
  imports: [IdentityModule, HouseholdModule, ConnectorsModule, ScheduleModule, NotificationsModule, SearchIndexModule],
  controllers: [AttentionController],
  providers: [AttentionService, InboxService],
  exports: [AttentionService, InboxService],
})
export class AttentionModule {}
