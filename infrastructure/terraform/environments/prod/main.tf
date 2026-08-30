locals {
  tags = { Environment = "prod", Project = "veynlo" }
}

module "networking" {
  source = "../../modules/networking"

  name               = "veynlo-prod"
  vpc_cidr           = "10.20.0.0/16"
  availability_zones = var.availability_zones
  tags               = local.tags
}

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "veynlo-prod-ecs-tasks-"
  description = "ECS Fargate tasks (API + worker)."
  vpc_id      = module.networking.vpc_id
  tags        = merge(local.tags, { Name = "veynlo-prod-ecs-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

module "database" {
  source = "../../modules/database"

  name                     = "veynlo-prod"
  vpc_id                   = module.networking.vpc_id
  isolated_data_subnet_ids = module.networking.isolated_data_subnet_ids
  app_security_group_ids   = [aws_security_group.ecs_tasks.id]
  tags                     = local.tags
}

module "cache" {
  source = "../../modules/cache"

  name                   = "veynlo-prod"
  vpc_id                 = module.networking.vpc_id
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  app_security_group_ids = [aws_security_group.ecs_tasks.id]
  tags                   = local.tags
}

module "storage" {
  source = "../../modules/storage"

  name = "veynlo-prod"
  tags = local.tags
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name = "veynlo-prod"
  tags = local.tags
}

module "alb" {
  source = "../../modules/alb"

  name                  = "veynlo-prod"
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  app_security_group_id = aws_security_group.ecs_tasks.id
  # certificate_arn left null — no ACM certificate/domain exists yet (docs/DEPLOYMENT.md's
  # production-readiness checklist covers acquiring the domain and requesting one). The ALB comes up
  # HTTP-only until then rather than failing to provision at all.
  tags = local.tags
}

# +---------------------------------------------------------------+
# | ECR — image registries the CI pipeline pushes to               |
# +---------------------------------------------------------------+

resource "aws_ecr_repository" "api" {
  name                 = "veynlo-api"
  image_tag_mutability = "IMMUTABLE" # blueprint §25: "never deploy only a mutable 'latest' tag"
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_ecr_repository" "worker" {
  name                 = "veynlo-worker"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

# +---------------------------------------------------------------+
# | Application secrets — containers created here, VALUES set out-of-band via                     |
# | `aws secretsmanager put-secret-value` (never via Terraform state/config — see SECURITY.md).    |
# +---------------------------------------------------------------+

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(["SESSION_JWT_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY"])
  name     = "veynlo-prod/${each.value}"
  tags     = local.tags
}

# +---------------------------------------------------------------+
# | ECS services — API (behind the ALB) and worker (no inbound)   |
# +---------------------------------------------------------------+

data "aws_iam_policy_document" "app_task_permissions" {
  statement {
    sid       = "DocumentBuckets"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [for arn in module.storage.bucket_arns : "${arn}/*"]
  }
  statement {
    sid       = "S3KmsForDocumentBuckets"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.storage.kms_key_arn]
  }
}

locals {
  app_secrets = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
  # DATABASE_URL/REDIS_URL are non-secret connection metadata (the actual DB password is RDS-managed and
  # never leaves Secrets Manager/RDS Proxy's own auth — the app connects to the proxy, not with the master
  # password itself). See infrastructure/terraform/README.md for the still-open least-privilege DB user
  # follow-up — this first pass connects through RDS Proxy using the master credentials.
  app_environment = {
    NODE_ENV             = "production"
    PORT                 = "4000"
    DB_PROXY_ENDPOINT    = module.database.proxy_endpoint
    REDIS_URL            = "rediss://${module.cache.endpoint}:${module.cache.port}"
    S3_BUCKET_CLEAN      = module.storage.bucket_names["clean"]
    S3_BUCKET_DERIVED    = module.storage.bucket_names["derived"]
    S3_BUCKET_QUARANTINE = module.storage.bucket_names["quarantine"]
    S3_BUCKET_RAW        = module.storage.bucket_names["raw"]
  }
}

module "ecs_service_api" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-prod-api"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${aws_ecr_repository.api.repository_url}:latest" # placeholder — CI deploys by immutable SHA tag, not this
  container_port         = 4000
  target_group_arn       = module.alb.target_group_arn
  min_count              = 3 # blueprint §10/§32: one baseline task per active AZ
  max_count              = 30
  # Per-task pg pool size, tuned separately from the worker below (see database.module.ts /
  # DATABASE_POOL_MAX): at max_count=30 this tops out at 300 proxy connections for the API alone,
  # so raise it only alongside the RDS Proxy's max_connections_percent / the Aurora Serverless v2
  # max_acu ceiling in modules/database.
  environment           = merge(local.app_environment, { DATABASE_POOL_MAX = "10" })
  secrets               = local.app_secrets
  task_role_policy_json = data.aws_iam_policy_document.app_task_permissions.json
  tags                  = local.tags
}

module "ecs_service_worker" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-prod-worker"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${aws_ecr_repository.worker.repository_url}:latest"
  container_port         = null # no inbound traffic — background job processor only
  min_count              = 2
  max_count              = 50
  # Smaller per-task pool than the API's: each worker task runs many concurrency-limited BullMQ
  # workers sharing one process/pool, not one connection per inbound HTTP request, so it needs
  # fewer live connections per task even though it can scale to more tasks.
  environment           = merge(local.app_environment, { DATABASE_POOL_MAX = "5" })
  secrets               = local.app_secrets
  task_role_policy_json = data.aws_iam_policy_document.app_task_permissions.json
  tags                  = local.tags
}
