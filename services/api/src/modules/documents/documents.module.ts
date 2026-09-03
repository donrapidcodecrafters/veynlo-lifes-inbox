import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { HouseholdModule } from "../household/household.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { SharingModule } from "../sharing/sharing.module";
import { SearchIndexModule } from "../search/search-index.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { StorageService } from "./storage.service";
import { OBJECT_STORAGE } from "./object-storage.interface";
import { MalwareScannerService } from "./malware-scanner.service";

// PublicShareController (the unauthenticated /v1/share/:token/access route) now lives in
// PublicShareModule, generic across every shareable resource type — see that module's own doc comment
// for why it can't live here without creating an import cycle.
@Module({
  imports: [IdentityModule, IntelligenceModule, HouseholdModule, EntitlementsModule, SharingModule, SearchIndexModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, StorageService, { provide: OBJECT_STORAGE, useExisting: StorageService }, MalwareScannerService],
  exports: [DocumentsService, StorageService, OBJECT_STORAGE, MalwareScannerService],
})
export class DocumentsModule {}
