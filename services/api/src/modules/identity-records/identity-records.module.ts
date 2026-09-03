import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { IdentityRecordsController } from "./identity-records.controller";
import { IdentityRecordsService } from "./identity-records.service";

/** "Identity & Legal Continuity" (ID-001..005). */
@Module({
  imports: [IdentityModule, HouseholdModule, SharingModule],
  controllers: [IdentityRecordsController],
  providers: [IdentityRecordsService],
  exports: [IdentityRecordsService],
})
export class IdentityRecordsModule {}
