import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export interface DbClientOptions {
  /** Max connections in this process's pool. Defaults to pg's own default (10) when unset. */
  poolMax?: number;
  /** Milliseconds an idle connection stays open before being closed. Defaults to pg's own default (10s) when unset. */
  idleTimeoutMillis?: number;
}

export function createDbClient(connectionString: string, options: DbClientOptions = {}) {
  const pool = new Pool({
    connectionString,
    max: options.poolMax,
    idleTimeoutMillis: options.idleTimeoutMillis,
  });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDbClient>;
