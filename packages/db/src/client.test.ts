import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDbClient } from "./client";

/**
 * The pg Pool's `max` was previously never configurable — every process (HTTP and worker alike) was
 * stuck at pg's hardcoded default (10), untunable against RDS's real max_connections at scale. Proves
 * poolMax genuinely constrains how many connections this process can hold open at once, against the
 * real local Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("createDbClient poolMax", () => {
  it("never opens more concurrent connections than poolMax allows", async () => {
    const db = createDbClient(DATABASE_URL, { poolMax: 2 });
    try {
      // 5 concurrent long-ish queries against a pool capped at 2 — pg_sleep forces genuine overlap so a
      // 3rd/4th/5th query can only proceed once an earlier one releases its connection back to the pool.
      const start = Date.now();
      await Promise.all(Array.from({ length: 5 }, () => db.execute(sql`select pg_sleep(0.2)`)));
      const elapsedMs = Date.now() - start;
      // With max 2 connections serving 5 sequential-in-groups 0.2s queries, at least 3 rounds are needed
      // (ceil(5/2) = 3) — floor comfortably below the 600ms a 3-round serialization implies. A pool that
      // ignored poolMax (defaulting to 10) would run all 5 concurrently and finish near 200ms.
      expect(elapsedMs).toBeGreaterThan(400);
    } finally {
      await db.$client.end();
    }
  }, 10_000);

  it("defaults to pg's own pool size when poolMax is omitted", async () => {
    const db = createDbClient(DATABASE_URL);
    try {
      const start = Date.now();
      await Promise.all(Array.from({ length: 5 }, () => db.execute(sql`select pg_sleep(0.2)`)));
      const elapsedMs = Date.now() - start;
      // pg's default max (10) comfortably covers 5 concurrent queries — they should all run in parallel.
      expect(elapsedMs).toBeLessThan(400);
    } finally {
      await db.$client.end();
    }
  }, 10_000);
});
