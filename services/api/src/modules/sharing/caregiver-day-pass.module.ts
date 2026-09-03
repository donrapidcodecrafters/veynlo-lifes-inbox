import { Module } from "@nestjs/common";
import { SharingModule } from "./sharing.module";
import { CaregiverDayPassController } from "./caregiver-day-pass.controller";
import { CaregiverDayPassPublicController } from "./caregiver-day-pass-public.controller";
import { CaregiverDayPassService } from "./caregiver-day-pass.service";

/** §35 SHARE-005 "Caregiver/day pass" — see CaregiverDayPassService's own doc comment. No HouseholdModule
 * import needed: membership checks are done directly against schema tables (see
 * CaregiverDayPassService.assertAdultMember's own doc comment on why), same as EmergencyBinderModule's own
 * precedent for the one thing it actually needs from HouseholdModule vs. querying directly. */
@Module({
  imports: [SharingModule],
  controllers: [CaregiverDayPassController, CaregiverDayPassPublicController],
  providers: [CaregiverDayPassService],
  exports: [CaregiverDayPassService],
})
export class CaregiverDayPassModule {}
