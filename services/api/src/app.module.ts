import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { LoggingModule } from "./logging/logging.module";
import { DatabaseModule } from "./database/database.module";
import { QueueModule } from "./queue/queue.module";
import { CacheModule } from "./cache/cache.module";
import { EventBusModule } from "./events/event-bus.module";
import { HealthModule } from "./modules/health/health.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { HouseholdModule } from "./modules/household/household.module";
import { IntelligenceModule } from "./modules/intelligence/intelligence.module";
import { IngestionModule } from "./modules/ingestion/ingestion.module";
import { ConnectorsModule } from "./modules/connectors/connectors.module";
import { AttentionModule } from "./modules/attention/attention.module";
import { CommerceModule } from "./modules/commerce/commerce.module";
import { ScheduleModule } from "./modules/schedule/schedule.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { SearchModule } from "./modules/search/search.module";
import { BillingModule } from "./modules/billing/billing.module";
import { AdminModule } from "./modules/admin/admin.module";
import { TimelineModule } from "./modules/timeline/timeline.module";
import { DataExportModule } from "./modules/data-export/data-export.module";
import { FeatureFlagsModule } from "./modules/feature-flags/feature-flags.module";
import { EntitlementsModule } from "./modules/entitlements/entitlements.module";
import { AssetsModule } from "./modules/assets/assets.module";
import { PetsModule } from "./modules/pets/pets.module";
import { FinanceModule } from "./modules/finance/finance.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { GraphModule } from "./modules/graph/graph.module";
import { ListsModule } from "./modules/lists/lists.module";
import { MemoriesModule } from "./modules/memories/memories.module";
import { EmergencyBinderModule } from "./modules/emergency-binder/emergency-binder.module";
import { PublicShareModule } from "./modules/sharing/public-share.module";
import { LocationModule } from "./modules/location/location.module";
import { TripsModule } from "./modules/trips/trips.module";
import { SchoolModule } from "./modules/school/school.module";
import { HealthLogisticsModule } from "./modules/health-logistics/health-logistics.module";
import { PreferencesModule } from "./modules/preferences/preferences.module";
import { PeopleModule } from "./modules/people/people.module";
import { OnboardingModule } from "./modules/onboarding/onboarding.module";
import { WidgetsModule } from "./modules/widgets/widgets.module";
import { IdentityRecordsModule } from "./modules/identity-records/identity-records.module";
import { CaregiverDayPassModule } from "./modules/sharing/caregiver-day-pass.module";
import { LegacyReleaseModule } from "./modules/sharing/legacy-release.module";

@Module({
  imports: [
    LoggingModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    QueueModule,
    CacheModule,
    EventBusModule,
    HealthModule,
    IdentityModule,
    HouseholdModule,
    IntelligenceModule,
    IngestionModule,
    ConnectorsModule,
    AttentionModule,
    CommerceModule,
    ScheduleModule,
    DocumentsModule,
    NotificationsModule,
    SearchModule,
    BillingModule,
    AdminModule,
    TimelineModule,
    DataExportModule,
    FeatureFlagsModule,
    EntitlementsModule,
    AssetsModule,
    PetsModule,
    FinanceModule,
    AutomationModule,
    GraphModule,
    ListsModule,
    MemoriesModule,
    EmergencyBinderModule,
    PublicShareModule,
    LocationModule,
    TripsModule,
    SchoolModule,
    HealthLogisticsModule,
    PreferencesModule,
    PeopleModule,
    OnboardingModule,
    WidgetsModule,
    IdentityRecordsModule,
    CaregiverDayPassModule,
    LegacyReleaseModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
