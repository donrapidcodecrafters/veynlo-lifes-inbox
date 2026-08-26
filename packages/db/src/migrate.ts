import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDbClient } from "./client";

async function main() {
  const connectionString =
    process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);
  // pgvector must exist before any migration creates a `vector(...)` column.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await migrate(db, { migrationsFolder: "./src/migrations" });
  console.log("Migrations applied.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
