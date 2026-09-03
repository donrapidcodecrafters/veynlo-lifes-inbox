import { Module } from "@nestjs/common";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentsModule } from "../documents/documents.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AutomationModule } from "../automation/automation.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { TripsModule } from "../trips/trips.module";
import { PreferencesModule } from "../preferences/preferences.module";
import { MemoriesModule } from "../memories/memories.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { SearchIndexModule } from "../search/search-index.module";
import { SpeechModule } from "../speech/speech.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { IngestionController } from "./ingestion.controller";
import { InboundEmailController } from "./inbound-email.controller";
import { IngestionService } from "./ingestion.service";
import { SafeUrlFetcher } from "./safe-url-fetcher";

// MemoriesModule imported here (not the reverse), same one-directional shape LocationModule already uses
// for the same reason (see that module's own doc comment) — MemoriesModule/MemoriesService never import
// anything from IngestionModule, so this stays a one-directional dependency, no cycle. Needed for §MSG-001
// "share-message extraction" routing a classified "recommendation"/"person"/"note" share into a real Saved
// Memory (SAVE-001) rather than a parallel note-storage mechanism — see IngestionService.
// classifyAndRouteShareMessage.
@Module({
  imports: [IntelligenceModule, IdentityModule, NotificationsModule, DocumentsModule, EntitlementsModule, AutomationModule, ScheduleModule, TripsModule, PreferencesModule, MemoriesModule, FeatureFlagsModule, SearchIndexModule, SpeechModule, AnalyticsModule],
  controllers: [IngestionController, InboundEmailController],
  providers: [IngestionService, SafeUrlFetcher],
  exports: [IngestionService, SafeUrlFetcher],
})
export class IngestionModule {}
