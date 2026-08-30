import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { BillingModule } from "../billing/billing.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";
import { SearchIndexService } from "./search-index.service";

@Module({
  imports: [IdentityModule, IntelligenceModule, BillingModule],
  controllers: [SearchController],
  providers: [SearchService, SearchIndexService],
  exports: [SearchService, SearchIndexService],
})
export class SearchModule {}
