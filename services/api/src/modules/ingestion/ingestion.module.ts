import { Module } from "@nestjs/common";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentsModule } from "../documents/documents.module";
import { SearchModule } from "../search/search.module";
import { IngestionController } from "./ingestion.controller";
import { InboundEmailController } from "./inbound-email.controller";
import { IngestionService } from "./ingestion.service";
import { SafeUrlFetcher } from "./safe-url-fetcher";

@Module({
  imports: [IntelligenceModule, IdentityModule, NotificationsModule, DocumentsModule, SearchModule],
  controllers: [IngestionController, InboundEmailController],
  providers: [IngestionService, SafeUrlFetcher],
  exports: [IngestionService],
})
export class IngestionModule {}
