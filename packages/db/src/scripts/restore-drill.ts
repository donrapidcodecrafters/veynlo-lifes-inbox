import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

/**
 * §29 "a backup is not proven until restoration is tested" / §36 "perform full backup restore into an
 * isolated environment" — the blueprint requires quarterly minimum restore drills at the infrastructure
 * level; this is the code-level equivalent that can run today without AWS Backup existing, and cheaply
 * enough to run on every CI run rather than waiting for a quarter. It does the whole cycle in one command
 * so there is no way to run "the backup" without also running "the restore": dump the real database,
 * restore it into a throwaway isolated database on the same server, and verify the row counts for a
 * cross-section of tables (spanning identity, commerce, documents, and the knowledge graph) match exactly
 * between source and restored copy — not just that `pg_restore` exited zero, which would pass even on an
 * empty or truncated dump.
 */

const SANITY_TABLES = [
  "users",
  "households",
  "sessions",
  "connections",
  "source_events",
  "purchases",
  "purchase_lines",
  "bills",
  "warranties",
  "documents",
  "document_versions",
  "canonical_entities",
  "facts",
  "relationships",
  "inbox_items",
  "entitlements",
];

function parseConnection(connectionString: string) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

function connectionStringFor(base: ReturnType<typeof parseConnection>, database: string): string {
  return `postgres://${encodeURIComponent(base.user)}:${encodeURIComponent(base.password)}@${base.host}:${base.port}/${database}`;
}

/**
 * A plain `pg.Client` connected and explicitly `.end()`-ed per call, not `createDbClient`'s pooled
 * drizzle instance — a `pg.Pool` has no natural "done" signal for a short-lived script, and leaving one
 * open against the drill database is exactly what broke `dropdb` below on the first real run of this
 * script ("database is being accessed by other users"). A one-shot client that always closes, even on
 * error, is the right lifecycle for a handful of COUNT queries that run once and exit.
 */
async function countRows(connectionString: string): Promise<Record<string, number>> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of SANITY_TABLES) {
      const result = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0]?.count ?? -1;
    }
    return counts;
  } finally {
    await client.end();
  }
}

async function createExtension(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await client.end();
  }
}

// See backup.ts's identical constant doc comment — same reasoning applies here.
const REPO_ROOT_BACKUPS_DIR = path.resolve(__dirname, "../../../../backups");

async function main() {
  const sourceConnectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const base = parseConnection(sourceConnectionString);
  const env = { ...process.env, PGPASSWORD: base.password };

  const outputDir = REPO_ROOT_BACKUPS_DIR;
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpFile = path.join(outputDir, `restore-drill-${timestamp}.dump`);
  const drillDatabase = `veynlo_restore_drill_${Date.now()}`;

  console.log(`1/5 Dumping ${base.database} -> ${dumpFile}`);
  await execFileAsync("pg_dump", ["--format=custom", `--file=${dumpFile}`, "--no-owner", "--no-privileges", sourceConnectionString]);
  const { size } = await stat(dumpFile);
  console.log(`    ${(size / 1024 / 1024).toFixed(2)} MB`);

  console.log(`2/5 Creating isolated drill database: ${drillDatabase}`);
  await execFileAsync("createdb", ["-h", base.host, "-p", base.port, "-U", base.user, drillDatabase], { env });

  try {
    console.log("3/5 Restoring dump into the drill database");
    // pgvector's `vector` type must exist before pg_restore recreates any column using it, same
    // requirement migrate.ts already documents for a fresh database.
    const drillConnectionString = connectionStringFor(base, drillDatabase);
    await createExtension(drillConnectionString);
    await execFileAsync("pg_restore", ["--no-owner", "--no-privileges", "-d", drillConnectionString, dumpFile]);

    console.log("4/5 Comparing row counts (source vs. restored)");
    const [sourceCounts, restoredCounts] = await Promise.all([countRows(sourceConnectionString), countRows(drillConnectionString)]);

    const mismatches = SANITY_TABLES.filter((table) => sourceCounts[table] !== restoredCounts[table]);
    for (const table of SANITY_TABLES) {
      const ok = sourceCounts[table] === restoredCounts[table];
      console.log(`    ${ok ? "✓" : "✗"} ${table}: source=${sourceCounts[table]} restored=${restoredCounts[table]}`);
    }

    if (mismatches.length > 0) {
      throw new Error(`Restore drill FAILED — row-count mismatch in: ${mismatches.join(", ")}`);
    }
    console.log("5/5 Restore drill PASSED — every sanity table matches exactly.");
  } finally {
    console.log(`Cleaning up: dropping ${drillDatabase}`);
    await execFileAsync("dropdb", ["-h", base.host, "-p", base.port, "-U", base.user, "--if-exists", drillDatabase], { env }).catch((err) =>
      console.error(`Warning: failed to drop drill database ${drillDatabase} — remove it manually.`, err),
    );
    if (process.env.KEEP_RESTORE_DRILL_DUMP !== "true") {
      await rm(dumpFile, { force: true });
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
