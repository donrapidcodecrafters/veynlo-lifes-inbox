import { Module } from "@nestjs/common";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IngestionController } from "./ingestion.controller";
import { IngestionService } from "./ingestion.service";
import { SafeUrlFetcher } from "./safe-url-fetcher";

@Module({
  imports: [IntelligenceModule, IdentityModule, NotificationsModule],
  controllers: [IngestionController],
  providers: [IngestionService, SafeUrlFetcher],
  exports: [IngestionService],
})
export class IngestionModule {}
