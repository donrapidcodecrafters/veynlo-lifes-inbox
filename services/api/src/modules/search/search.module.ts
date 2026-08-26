import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({
  imports: [IdentityModule, IntelligenceModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
