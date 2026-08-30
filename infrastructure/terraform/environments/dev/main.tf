# Shared AWS development resources (blueprint §24): small, single-task, no production data ever.

locals {
  tags = { Environment = "dev", Project = "veynlo" }
}

module "networking" {
  source = "../../modules/networking"

  name               = "veynlo-dev"
  vpc_cidr           = "10.22.0.0/16"
  availability_zones = var.availability_zones
  tags               = local.tags
}

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "veynlo-dev-ecs-tasks-"
  description = "ECS Fargate tasks (API + worker)."
  vpc_id      = module.networking.vpc_id
  tags        = merge(local.tags, { Name = "veynlo-dev-ecs-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

module "database" {
  source = "../../modules/database"

  name                     = "veynlo-dev"
  vpc_id                   = module.networking.vpc_id
  isolated_data_subnet_ids = module.networking.isolated_data_subnet_ids
  app_security_group_ids   = [aws_security_group.ecs_tasks.id]
  # Lowest documented Serverless v2 minimum — AWS has moved this capability over time (down from a 0.5
  # ACU floor toward supporting a true 0 ACU "pause" in some regions/versions); confirm the current floor
  # for the target region/engine version before applying, rather than assume this exact number still holds.
  min_acu               = 0.5
  max_acu               = 4
  backup_retention_days = 1
  deletion_protection   = false
  tags                  = local.tags
}

module "cache" {
  source = "../../modules/cache"

  name                   = "veynlo-dev"
  vpc_id                 = module.networking.vpc_id
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  app_security_group_ids = [aws_security_group.ecs_tasks.id]
  max_storage_gb         = 1
  max_ecpu_per_second    = 1000
  tags                   = local.tags
}

module "storage" {
  source = "../../modules/storage"

  name = "veynlo-dev"
  tags = local.tags
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name = "veynlo-dev"
  tags = local.tags
}

module "alb" {
  source = "../../modules/alb"

  name                  = "veynlo-dev"
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  app_security_group_id = aws_security_group.ecs_tasks.id
  tags                  = local.tags
}

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(["SESSION_JWT_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY"])
  name     = "veynlo-dev/${each.value}"
  tags     = local.tags
}

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
  app_environment = {
    NODE_ENV             = "development"
    PORT                 = "4000"
    DB_PROXY_ENDPOINT    = module.database.proxy_endpoint
    REDIS_URL            = "rediss://${module.cache.endpoint}:${module.cache.port}"
    S3_BUCKET_CLEAN      = module.storage.bucket_names["clean"]
    S3_BUCKET_DERIVED    = module.storage.bucket_names["derived"]
    S3_BUCKET_QUARANTINE = module.storage.bucket_names["quarantine"]
    S3_BUCKET_RAW        = module.storage.bucket_names["raw"]
  }
}

data "aws_ecr_repository" "api" {
  name = "veynlo-api"
}

data "aws_ecr_repository" "worker" {
  name = "veynlo-worker"
}

module "ecs_service_api" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-dev-api"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${data.aws_ecr_repository.api.repository_url}:dev-latest"
  container_port         = 4000
  target_group_arn       = module.alb.target_group_arn
  min_count              = 1
  max_count              = 1
  environment            = merge(local.app_environment, { DATABASE_POOL_MAX = "10" })
  secrets                = local.app_secrets
  task_role_policy_json  = data.aws_iam_policy_document.app_task_permissions.json
  tags                   = local.tags
}

module "ecs_service_worker" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-dev-worker"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${data.aws_ecr_repository.worker.repository_url}:dev-latest"
  container_port         = null
  min_count              = 1
  max_count              = 1
  environment            = merge(local.app_environment, { DATABASE_POOL_MAX = "5" })
  secrets                = local.app_secrets
  task_role_policy_json  = data.aws_iam_policy_document.app_task_permissions.json
  tags                   = local.tags
}
