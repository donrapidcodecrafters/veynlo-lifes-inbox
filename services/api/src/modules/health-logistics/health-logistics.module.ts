import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { DocumentsModule } from "../documents/documents.module";
import { DataExportModule } from "../data-export/data-export.module";
import { SearchIndexModule } from "../search/search-index.module";
import { HealthLogisticsController } from "./health-logistics.controller";
import { HealthLogisticsService } from "./health-logistics.service";

/** §27 "Health Logistics (Non-Diagnostic)" (HLTH-001..005). */
@Module({
  imports: [IdentityModule, HouseholdModule, SharingModule, DocumentsModule, DataExportModule, SearchIndexModule],
  controllers: [HealthLogisticsController],
  providers: [HealthLogisticsService],
  exports: [HealthLogisticsService],
})
export class HealthLogisticsModule {}
