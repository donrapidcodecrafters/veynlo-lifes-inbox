import { Module } from "@nestjs/common";
import { SearchIndexService } from "./search-index.service";

/**
 * Split out from SearchModule (rather than exporting SearchIndexService from there) specifically so every
 * domain module that needs to keep `search_documents` in sync can import it directly without also pulling
 * in SearchModule's own dependencies (Identity/Intelligence/Entitlements/Memories/Preferences) — this
 * module depends on nothing but the `@Global()` DATABASE token, so it can never be the cause of an import
 * cycle no matter how many domain modules import it.
 */
@Module({
  providers: [SearchIndexService],
  exports: [SearchIndexService],
})
export class SearchIndexModule {}
