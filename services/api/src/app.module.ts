import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./database/database.module";
import { QueueModule } from "./queue/queue.module";
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

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DatabaseModule,
    QueueModule,
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
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
