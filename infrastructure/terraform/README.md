# Terraform

Infrastructure-as-code for Veynlo's production AWS footprint (architecture
blueprint §5–17). This is written and validated (`terraform validate`
against the real `hashicorp/aws` provider schema — no AWS account or
credentials needed for that) but **never applied** — there is no AWS
account behind this yet.

## Layout

```
modules/       reusable building blocks (networking, database, cache, ...)
environments/  per-environment composition (prod/, staging/, dev/) —
               same modules, different sizing/tfvars
```

All three environments (`prod`, `staging`, `dev`) exist, each composing the
same modules at different sizing. See `docs/DEPLOYMENT.md` for the
production-readiness checklist (domain/ACM, ECR image push, remote state)
and `docs/ROADMAP.md` / `SECURITY.md` for what's still unbuilt.

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
