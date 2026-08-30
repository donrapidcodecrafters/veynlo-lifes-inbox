# Disaster recovery — RPO/RTO

Real backup/PITR configuration has existed in `infrastructure/terraform/modules/database`
since it was written, but nothing in the repo ever stated what recovery target that
configuration is actually meant to achieve. This ties the two together.

## Targets

| | RPO (max data loss) | RTO (max time to restore) |
| --- | --- | --- |
| **Aurora PostgreSQL (primary datastore)** | 5 minutes (production) | ~1 hour, untested |
| **Object storage (S3: raw/clean/derived/quarantine)** | See caveat below | N/A |
| **Redis (queue/cache)** | Not applicable — see caveat below | N/A |

These are targets, not measured/verified numbers — there has never been a real restore
drill against this infrastructure (there's no AWS account behind it yet; see
`infrastructure/terraform/README.md`). Once a real environment exists, a scheduled
restore-and-verify drill should replace "untested" above with a real measurement.

## Aurora PostgreSQL

`modules/database`'s `backup_retention_days` (default 35, blueprint §14/§29) enables
Aurora's continuous backup with point-in-time recovery. Aurora's own PITR granularity is
~5 minutes, which sets the RPO above — a restore can recover to any point within the
retention window, losing at most the last few minutes of writes before an incident.

RTO is Aurora's typical PITR restore time for a database this size (a new cluster
provisioned from the backup, DNS/connection-string cutover, RDS Proxy re-pointed) — not
yet measured against a real cluster. `deletion_protection = true` (the module's default)
guards against the most common real-world RTO blowup: an accidental `terraform destroy`
or console deletion, which a restore recovers *data* from but doesn't avoid the outage
of.

Environment-specific retention (from each environment's `main.tf`):

- `dev`: 1 day — matches its disposable, no-real-user-data purpose.
- `staging`: 7 days.
- `prod`: 35 days (the module default, left unset in `prod/main.tf`).

## Object storage (S3)

Only the `clean` bucket has versioning enabled (`modules/storage/main.tf`) — the
`raw`/`derived`/`quarantine` buckets do not, by explicit design (aggressive lifecycle
expiry on `raw`, nothing in `quarantine` worth recovering). This means:

- Accidental deletion/overwrite of a *clean* (post-processing) object is recoverable via
  S3 versioning.
- Accidental deletion/overwrite of a *raw* (original upload) object is **not** currently
  recoverable — there is no RPO/RTO target for this because there is no backup to recover
  from. The `checkov` CI job (`.github/workflows/ci.yml`) already flags this
  (`CKV_AWS_21` on the unversioned buckets) as an informational finding; closing it is
  tracked separately, not restated here as if it were already covered.

## Redis (ElastiCache)

No snapshot/backup configuration exists for the cache module, deliberately — Redis here
is a BullMQ queue and cache, not a system of record. A queue loss means in-flight jobs
need to be re-enqueued (the ingestion pipeline is designed to be re-run safely — see
`services/api/src/worker-main.ts`'s idempotency handling), not permanent data loss. No
RPO/RTO target applies because nothing here is meant to survive a Redis restart
un-replayed.

## What this doc does not cover

- A tested/measured restore procedure (runbook) — this states the *target*, not the
  *steps*. A real runbook needs a real AWS account to write and verify against.
- Multi-region failover — out of scope; this environment is single-region.
- Cross-region backup replication — not configured; `CKV_AWS_144` in the `checkov` scan
  flags the S3 side of this as a known, informational gap.
