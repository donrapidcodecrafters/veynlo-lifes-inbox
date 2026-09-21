import { Module } from "@nestjs/common";
import { SearchIndexModule } from "./search-index.module";
import { SearchBackfillService } from "./search-backfill.service";

/**
 * Kept separate from SearchIndexModule rather than added to it: that module's whole point is depending on
 * nothing but the `@Global()` DATABASE token, so any domain module can import it with no risk of an import
 * cycle (see its own doc comment). SearchBackfillService reads every indexed domain's tables, so it is
 * exactly the kind of dependency that invariant exists to keep out.
 */
@Module({
  imports: [SearchIndexModule],
  providers: [SearchBackfillService],
  exports: [SearchBackfillService],
})
export class SearchBackfillModule {}
