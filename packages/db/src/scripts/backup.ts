import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * §29 "Backup, restore, and disaster recovery" / §36 migration checklist "perform full backup restore
 * into an isolated environment" — this repo had no backup tooling of any kind before this. Uses `pg_dump`
 * directly (the same tool AWS's own Aurora/RDS docs point to for logical backups) rather than anything
 * Drizzle-specific, so the resulting dump is restorable with plain `pg_restore` against any PostgreSQL
 * target, Aurora included — no dependency on this codebase's own tooling surviving.
 *
 * Custom format (`-Fc`) is compressed and is the only format `pg_restore` (used by restore-drill.ts) can
 * restore selectively/in parallel; a plain-SQL dump would also work but loses those properties for no
 * benefit here.
 */
// Anchored to the monorepo root regardless of which package's directory this runs from (`pnpm --filter
// @veynlo/db backup` invokes tsx with cwd=packages/db, not the root) — a relative "./backups" would
// otherwise land in a different, un-gitignored place depending on the caller.
const REPO_ROOT_BACKUPS_DIR = path.resolve(__dirname, "../../../../backups");

async function main() {
  const connectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const outputDir = process.argv[2] ?? REPO_ROOT_BACKUPS_DIR;
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(outputDir, `veynlo-${timestamp}.dump`);

  await execFileAsync("pg_dump", ["--format=custom", `--file=${outputFile}`, "--no-owner", "--no-privileges", connectionString]);

  const { size } = await stat(outputFile);
  console.log(`Backup written: ${outputFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(outputFile); // last stdout line — restore-drill.ts's shell wrapper can capture this if needed
}

main().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
