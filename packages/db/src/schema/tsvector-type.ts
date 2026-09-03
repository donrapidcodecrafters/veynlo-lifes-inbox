import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector` column via a custom type, mirroring vector-type.ts's approach for `pgvector` so both
 * stay independent of whichever drizzle-orm minor version's native column helpers exist.
 *
 * In this codebase the only `tsvector` column (`search_documents.search_vector`, see schema/search.ts) is a
 * `GENERATED ALWAYS ... STORED` column — Postgres computes and stores it itself from `title`/`body_text` on
 * every INSERT/UPDATE, so application code never constructs or writes a value for it directly. `toDriver`
 * is therefore unreachable in normal use; `fromDriver` just passes the raw driver string through unchanged
 * for the rare case a caller selects the column directly rather than only referencing it inside a `sql`
 * predicate/order-by (the normal way `SearchService` uses it).
 */
export const tsvector = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return "tsvector";
    },
    toDriver(value: string): string {
      return value;
    },
    fromDriver(value: string): string {
      return value;
    },
  })(name);
