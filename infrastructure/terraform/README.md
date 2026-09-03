# Terraform

Infrastructure-as-code for Veynlo's production AWS footprint (architecture
blueprint §5–17). Written to match the blueprint closely — Aurora
PostgreSQL 17.7 Serverless v2 (`modules/database`), ElastiCache Valkey
Serverless (`modules/cache`), ECS Fargate on ARM64 (`modules/ecs-cluster`/
`modules/ecs-service`, `cpu_architecture = "ARM64"` — blueprint §10) — but
**never applied**; there is no AWS account behind this yet.

## Layout

```
modules/       reusable building blocks: alb, cache, database, ecs-cluster,
               ecs-service, networking, storage
environments/  per-environment composition (dev/, staging/, prod/) — same
               seven modules, different sizing/tfvars
```

All seven modules exist and all three environments wire up all seven
(confirmed 2026-08-31 by reading each environment's `main.tf` directly — a
prior version of this README claimed only `networking` and `prod` existed,
which was stale by the time this was checked). **Not independently
re-validated this pass** — this environment has no working `terraform`
binary to run `terraform validate`/`plan` against (installing one requires a
system Command Line Tools upgrade too invasive to do unilaterally just for
this check); confirm `terraform validate` still passes before relying on
this modules/environments claim for a real deployment. See `docs/DECISIONS.md`
for how this reconciles with the rest of the codebase's current (non-AWS)
architecture, and `docs/ROADMAP.md` / `SECURITY.md` for what's still unbuilt
elsewhere.

## Before this can ever be applied

1. An AWS account needs to exist — Control Tower/Organizations landing-zone
   setup (blueprint §5) is a guided, mostly console-driven bootstrap, not
   something this repo Terraforms from zero.
2. A remote state backend (S3 + DynamoDB lock table, or Terraform Cloud)
   needs to exist before `terraform init` here can use it — there's no
   `backend` block configured yet on purpose, so `terraform validate`/`fmt`
   work with zero setup; add one before ever running `apply`.
3. `terraform plan`/`apply` need real AWS credentials — `validate` doesn't,
   which is why validation was possible without an AWS account at all.

## Regional NAT Gateway

`modules/networking`'s `use_regional_nat_gateway` variable defaults to
`false` (falls back to one zonal NAT Gateway per AZ). AWS's regional NAT
Gateway mode is real (confirmed against the `hashicorp/aws` provider docs,
added in provider v6.24, Nov 2025) but recent enough that regional
availability should be confirmed for the deployment region before flipping
this to `true` — see the blueprint feasibility review.
