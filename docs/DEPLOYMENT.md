# Deployment

Honest status: the Terraform in `infrastructure/terraform/` is written and
`terraform validate`-clean against the real `hashicorp/aws` provider schema,
but has **never been applied** — there is no AWS account behind it yet, and
CI **builds** the API/worker Docker images on every PR but does not **push**
them anywhere or deploy anything. This doc is the checklist for closing that
gap, referenced from `.github/workflows/ci.yml` and the `alb`/`prod`
Terraform modules.

## What already works today

- `pnpm dev` / Docker Compose (`infrastructure/docker/`) for local
  development — see the root `README.md`.
- CI (`.github/workflows/ci.yml`): typecheck, lint, full test suite,
  blocking SAST + secret-scanning (gitleaks + Semgrep, see `SECURITY.md`),
  `terraform fmt`/`validate` across all three environments plus an
  informational `checkov` scan, and a Docker build of both the `api` and
  `worker` targets on every PR — build-only, `push: false`, tagged `:ci`
  locally within the runner. This already catches real Dockerfile/Terraform
  breakage (see the comments in `ci.yml`) — it just doesn't ship anywhere
  yet.
- `infrastructure/terraform/` composes three environments (`dev`, `staging`,
  `prod`) from shared modules (networking, database, cache, storage,
  ecs-service, alb) — sized differently per environment but otherwise
  identical. See `infrastructure/terraform/README.md` for layout and the
  `terraform validate`-without-an-AWS-account setup, and
  `docs/DISASTER_RECOVERY.md` for the RPO/RTO targets the database module's
  backup/PITR config is meant to achieve.

## What's needed before this can actually run in AWS

1. **AWS account + landing zone.** Control Tower/Organizations setup
   (architecture blueprint §5) is a guided, console-driven bootstrap — not
   something Terraformed from zero here.
2. **Remote state backend.** No `backend` block is configured on purpose
   (so `terraform validate`/`fmt` work with zero setup) — add an S3 bucket +
   DynamoDB lock table (or Terraform Cloud) before ever running `apply`.
3. **A registered domain + ACM certificate.** `module.alb`'s
   `certificate_arn` is left `null` today, so the ALB comes up **HTTP-only**
   rather than failing to provision — see the comments in
   `infrastructure/terraform/environments/prod/main.tf` and
   `infrastructure/terraform/modules/alb/main.tf`. Once a domain is
   registered: request/validate an ACM certificate (DNS validation via
   Route 53 is simplest), pass its ARN into `certificate_arn`, and the
   `aws_lb_listener.http` resource's redirect-to-HTTPS behavior activates.
4. **Wire ECR push into CI.** `aws_ecr_repository.api`/`.worker` already
   exist in Terraform, but `ci.yml`'s `docker-build` job never pushes to
   them (`push: false`). Needs: an OIDC-federated IAM role for GitHub
   Actions (not long-lived access keys), `aws-actions/configure-aws-
   credentials` + `aws-actions/amazon-ecr-login`, and `push: true` tagged by
   immutable commit SHA — the `ecs_service_api`/`ecs_service_worker`
   modules' `image` fields already say `:latest # placeholder — CI deploys
   by immutable SHA tag, not this`, anticipating this exact change.
5. **An actual deploy trigger.** Nothing currently updates an ECS service's
   task definition or forces a new deployment after a new image lands in
   ECR. The simplest correct addition once (4) exists: an `aws ecs update-
   service --force-new-deployment` (or `render-task-definition` +
   `deploy-task-definition` via `aws-actions/amazon-ecs-deploy-task-
   definition`) step at the end of a merge-to-main workflow, per service.
6. **Populate real secrets.** `aws_secretsmanager_secret.app` (per
   environment) creates the Secrets Manager entries for
   `SESSION_JWT_SECRET`/`CREDENTIAL_ENCRYPTION_KEY`/`FIELD_ENCRYPTION_KEY`
   but never writes a value into them — that's a deliberate manual step
   (`aws secretsmanager put-secret-value`), not something to automate via
   Terraform (a secret value belongs in state as little as possible). See
   `SECURITY.md`'s pre-submission checklist for the "insecure default"
   guard that refuses to boot in production without these actually set.
7. **RDS Proxy auth.** The database module currently connects through RDS
   Proxy using the master credentials (see
   `infrastructure/terraform/README.md`'s still-open note) — provisioning a
   real deployment should first switch to a dedicated least-privilege
   application DB user/role before go-live, not after.

## Rollout notes

- Both `ecs_service_api` and `ecs_service_worker` run as separate ECS
  services (see `services/api/Dockerfile`'s two build targets) — a bad
  worker image can be rolled back independently of the API, and vice versa.
- There is no migration-rollback tooling today (see `SECURITY.md`/
  `docs/ROADMAP.md`) — a schema migration is forward-only in practice;
  budget a manual rollback runbook before the first real production
  migration, not after.
- **Two existing migrations lock hard against a populated table** and would
  cause real write-blocking downtime if replayed against real production
  data: `0020_wooden_iron_fist.sql` (a full backfill+delete+`SET NOT NULL`+
  non-concurrent index on `shipments`) and `0027_search_documents_fts.sql`
  (a `STORED` generated column, which rewrites the entire table under an
  `ACCESS EXCLUSIVE` lock — on `search_documents`, which mirrors nearly
  every row in the system). Both are harmless today only because every
  environment's tables are still empty — they are NOT being rewritten
  retroactively (a migration is a historical record, not something to edit
  after the fact). The actual fix is a going-forward practice: once any
  environment has real data, author new schema changes as
  `CREATE INDEX CONCURRENTLY` (outside a transaction) and multi-step
  backfills (add nullable → backfill in batches → add the constraint),
  not as single blocking statements. Every `CREATE INDEX` in this repo so
  far is non-concurrent for the same reason — fine on empty tables, a real
  outage risk once they aren't.
- `docker-build`'s CI job builds off every PR, which is the right moment to
  add a real staging deploy step once (4)/(5) above exist — build once,
  promote the same immutable image through staging → prod rather than
  rebuilding per environment.
