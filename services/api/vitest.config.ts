import { defineConfig } from "vitest/config";

/**
 * Every suite in this package talks to the SAME local Postgres (DATABASE_URL), and none of them
 * namespace their fixtures per worker or wrap themselves in a rolled-back transaction. Vitest's
 * default is to run test FILES in parallel, so suites were writing and counting rows in one shared
 * database at the same time — a "does a re-scan file a duplicate?" test would see a row another
 * file's fixture had just inserted and fail on a count of 2 instead of 1.
 *
 * That produced genuinely non-deterministic runs: three consecutive full runs failed three DIFFERENT
 * single tests (identity-records, then attention.recall, then ingestion.price-adjustment-policy),
 * every one of which passed when run on its own. Serializing files removes the interference without
 * needing to retrofit per-test isolation across ~170 suites.
 *
 * Tests within a single file still share that file's own fixtures and run in order, which is what
 * they already assume.
 *
 * DB_POOL_MAX: 155 test files each call `createDbClient`, and node-postgres pools default to 10
 * connections. Running every file in one worker process keeps all those pools alive, against Postgres'
 * `max_connections` of 100 (confirmed live). Capping the per-pool size bounds that.
 *
 * 5, not 2: some suites legitimately need real concurrency. household.invite-quota-race.test.ts fires two
 * `households.invite` calls through `Promise.allSettled` to prove only one can claim the last seat, and
 * each of those takes a transaction — at max 2 the loser fails on connection starvation instead of the
 * HOUSEHOLD_MEMBER_LIMIT_REACHED it is asserting, which turned a rare flake into a deterministic failure.
 * 5 leaves headroom for that concurrency while still keeping the suite far below the ceiling.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DB_POOL_MAX: "5",
    },
  },
});
