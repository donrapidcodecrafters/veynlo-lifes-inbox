import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { HouseholdModule } from "../household/household.module";
import { SharedModule } from "../shared/shared.module";
import { SearchModule } from "../search/search.module";
import { BillingModule } from "../billing/billing.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { StorageService } from "./storage.service";
import { MalwareScannerService } from "./malware-scanner.service";

@Module({
  imports: [IdentityModule, IntelligenceModule, HouseholdModule, SharedModule, SearchModule, BillingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, StorageService, MalwareScannerService],
  exports: [DocumentsService, StorageService, MalwareScannerService],
})
export class DocumentsModule {}
