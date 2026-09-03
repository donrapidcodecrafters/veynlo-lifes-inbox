# Disaster recovery

Current, real posture — not the target. See `docs/DECISIONS.md` for how this
reconciles with the architecture blueprint's production DR requirements
(§29: 35-day Aurora PITR, cross-account/cross-region backup copies, Vault
Lock, quarterly restore drills).

## What exists today

- **Backup**: `pnpm db:backup` (`packages/db/src/scripts/backup.ts`) — a
  real `pg_dump --format=custom` against `DATABASE_URL`, written to
  `./backups/` at the repo root. Manual, on-demand only; nothing schedules
  this automatically yet (no production environment exists to schedule it
  in).
- **Restore, proven**: `pnpm db:restore-drill` (`restore-drill.ts`) runs the
  full cycle in one command — dump, restore into a throwaway isolated
  database on the same Postgres server, verify row counts match exactly
  across 16 tables spanning identity/commerce/documents/the knowledge graph,
  then always clean up (drop the drill database, delete the dump), even on
  failure. This is what makes the backup a *proven* backup rather than an
  assumed one — see §29's own framing: "a backup is not proven until
  restoration is tested."
- **Wired into CI**: `.github/workflows/ci.yml` runs the restore drill on
  every push/PR against the freshly migrated-and-seeded database, so this
  is checked continuously rather than only on the blueprint's quarterly
  minimum — cheap to run in CI, and a regression here (a migration that
  breaks restorability, a schema change that breaks the sanity-table list)
  is caught the same day it's introduced.
- **Single instance, no replication**: local dev Postgres is one container
  with a local Docker volume. No read replica, no point-in-time recovery
  beyond whatever WAL Postgres itself retains locally, no cross-region or
  cross-account copy of anything. Losing that one Docker volume loses
  everything since the last manual `pnpm db:backup`.
- **S3-equivalent (MinIO)**: also single-instance, also no replication or
  versioning configured beyond MinIO's own defaults.

## What the blueprint's production target adds (not built — needs a real AWS account)

| Blueprint requirement | Status |
|---|---|
| Aurora 35-day continuous/PITR backup retention | N/A — not on Aurora yet; local dev's restore drill is the closest equivalent today |
| AWS Backup copy into a separate Backup/DR account | N/A — no multi-account AWS org exists |
| Cross-region copy (us-west-2) | N/A — no second region in play |
| Quarterly minimum restore drills | Exceeded in spirit today — the drill runs on every CI build, not quarterly — but against local dev data, not a production Aurora cluster |
| S3 versioning + lifecycle on document buckets | N/A — MinIO locally, no versioning configured |
| AWS Backup Vault Lock (governance mode) | N/A |

## Recovery objectives — current reality, not a target

There is no production system, so there is no real RPO/RTO to report.
Locally: RPO is "since the last manual `pnpm db:backup`" (no automatic
schedule), and RTO is "however long a human takes to run
`pnpm db:restore-drill`'s restore half against a real target" (minutes,
based on the drill's own timing against this repo's current data volume —
re-measure against real production data volume once it exists, since restore
time scales with database size in ways local dev's small dataset doesn't
exercise).

## Before this app handles real user data on real infrastructure

1. Provision Aurora with the blueprint's 35-day PITR retention and
   deletion protection enabled from creation (§14) — not something to
   enable retroactively after real data already exists unprotected.
2. Stand up the Backup/DR account and AWS Backup cross-account/cross-region
   copy policy (§29) before real user data exists, per the blueprint's own
   ordering.
3. Re-run (or re-design) the restore drill against the real Aurora cluster,
   not just local Postgres — connection/auth details differ (RDS Proxy,
   IAM auth options), and restore timing at real data volume needs to be
   measured, not assumed from local dev's small dataset.
4. Decide and document the actual RPO/RTO targets the business is willing
   to commit to, then verify the infrastructure actually meets them via a
   real drill — not the other way around.
