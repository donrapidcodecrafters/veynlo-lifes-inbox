import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { TimelineController } from "./timeline.controller";
import { TimelineService } from "./timeline.service";

@Module({
  // SharingModule added alongside the existing two — TimelineService now needs SharingService for the
  // health_appointment branch's explicit-grant check (§TIME-001 Phase 3 extension, see
  // timeline.service.ts's own doc comment).
  imports: [IdentityModule, HouseholdModule, SharingModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
