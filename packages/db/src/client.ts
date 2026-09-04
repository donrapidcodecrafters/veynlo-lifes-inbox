import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * node-postgres defaults a Pool to 10 connections. That is sane for the API and worker processes, which
 * each construct exactly one client — but the API test suite constructs one per test FILE (155 of them),
 * and vitest runs those files sequentially inside a SINGLE worker process, so every pool stays alive for
 * the whole run. 155 x 10 is 1550 against Postgres' default `max_connections` of 100 (confirmed live:
 * `show max_connections` = 100).
 *
 * That is the cause of a long-running intermittent failure where exactly one test failed per full run, a
 * different test each time, and every one of them passed when run on its own — whichever suite happened to
 * be running once the ceiling was reached is the one that failed. Serialising the files
 * (`fileParallelism: false`) made this MORE likely, not less, by keeping every pool in one process.
 *
 * `DB_POOL_MAX` lets the test runner request a small pool without altering production behaviour; see
 * services/api/vitest.config.ts, which sets it to 2.
 */
const DEFAULT_POOL_MAX = 10;

export function createDbClient(connectionString: string) {
  const configured = Number(process.env.DB_POOL_MAX);
  const max = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POOL_MAX;
  const pool = new Pool({ connectionString, max });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDbClient>;
