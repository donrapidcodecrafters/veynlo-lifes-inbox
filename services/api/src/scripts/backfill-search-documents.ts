/**
 * §44.4 "Search architecture" — on-demand search index reconciliation.
 *
 * The projection itself lives in SearchBackfillService (see its own doc comment for why a forward-only
 * index needs reconciling at all). This script used to carry its own copy of that logic, which meant two
 * implementations of "what does a purchase's search document look like" that nothing kept in step — the
 * exact drift the service's doc comment warns about. It is now a thin entry point: the same code the daily
 * `search-index-backfill` queue tick runs, invoked by hand.
 *
 * Reach for this after a seed, an import, a migration, or a fix to one domain's projection shape, rather
 * than waiting up to a day for the scheduled pass. Idempotent and safe to re-run at any time.
 *
 * Usage: pnpm --filter @veynlo/api run backfill-search-documents
 */
import "../config/load-env-file"; // must be the first import — see its own doc comment for why
import { createDbClient } from "@veynlo/db";
import { loadEnv } from "../config/env";
import { SearchIndexService } from "../modules/search/search-index.service";
import { SearchBackfillService } from "../modules/search/search-backfill.service";

async function main() {
  const db = createDbClient(loadEnv().DATABASE_URL);
  const result = await new SearchBackfillService(db, new SearchIndexService(db)).run();

  console.log("Search backfill complete.");
  console.log("  written/refreshed:");
  for (const [label, count] of Object.entries(result.indexed)) console.log(`    ${label}: ${count}`);
  const total = Object.values(result.indexed).reduce((sum, count) => sum + count, 0);
  console.log(`  total search_documents rows written/refreshed: ${total}`);

  const retiredTotal = Object.values(result.retired).reduce((sum, count) => sum + count, 0);
  if (retiredTotal === 0) {
    console.log("  retired (resource no longer exists): none");
  } else {
    console.log("  retired (resource no longer exists):");
    for (const [label, count] of Object.entries(result.retired)) console.log(`    ${label}: ${count}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Search backfill failed:", err);
  process.exit(1);
});
