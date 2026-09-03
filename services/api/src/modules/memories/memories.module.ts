import { Module } from "@nestjs/common";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { DocumentsModule } from "../documents/documents.module";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { SearchIndexModule } from "../search/search-index.module";
import { MemoriesController } from "./memories.controller";
import { MemoriesService } from "./memories.service";
import { ResurfacingService } from "./resurfacing.service";

/**
 * §29.1 "Saved Memory, Lists & Knowledge" (SAVE-001..007). `ResurfacingService` is exported (not just a
 * provider) so worker-main.ts can inject it directly for the recurring resurfacing-scan tick, the same
 * shape AttentionModule exports AttentionService for its own scanAndFileDeadlines tick.
 */
@Module({
  imports: [IntelligenceModule, DocumentsModule, HouseholdModule, SharingModule, SearchIndexModule],
  controllers: [MemoriesController],
  providers: [MemoriesService, ResurfacingService],
  exports: [MemoriesService, ResurfacingService],
})
export class MemoriesModule {}
