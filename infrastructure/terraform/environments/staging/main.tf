# Same modules, same security pattern as prod, lower capacity (blueprint §24: "exact release candidate
# testing... same services and security pattern as production, lower capacity").

locals {
  tags = { Environment = "staging", Project = "veynlo" }
}

module "networking" {
  source = "../../modules/networking"

  name               = "veynlo-staging"
  vpc_cidr           = "10.21.0.0/16"
  availability_zones = var.availability_zones
  tags               = local.tags
}

resource "aws_security_group" "ecs_tasks" {
  name_prefix = "veynlo-staging-ecs-tasks-"
  description = "ECS Fargate tasks (API + worker)."
  vpc_id      = module.networking.vpc_id
  tags        = merge(local.tags, { Name = "veynlo-staging-ecs-tasks" })

  lifecycle {
    create_before_destroy = true
  }
}

module "database" {
  source = "../../modules/database"

  name                     = "veynlo-staging"
  vpc_id                   = module.networking.vpc_id
  isolated_data_subnet_ids = module.networking.isolated_data_subnet_ids
  app_security_group_ids   = [aws_security_group.ecs_tasks.id]
  min_acu                  = 2
  max_acu                  = 8
  backup_retention_days    = 7
  deletion_protection      = false
  tags                     = local.tags
}

module "cache" {
  source = "../../modules/cache"

  name                   = "veynlo-staging"
  vpc_id                 = module.networking.vpc_id
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  app_security_group_ids = [aws_security_group.ecs_tasks.id]
  max_storage_gb         = 2
  max_ecpu_per_second    = 1000
  tags                   = local.tags
}

module "storage" {
  source = "../../modules/storage"

  name = "veynlo-staging"
  tags = local.tags
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name = "veynlo-staging"
  tags = local.tags
}

module "alb" {
  source = "../../modules/alb"

  name                  = "veynlo-staging"
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  app_security_group_id = aws_security_group.ecs_tasks.id
  tags                  = local.tags
}

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(["SESSION_JWT_SECRET", "CREDENTIAL_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEY"])
  name     = "veynlo-staging/${each.value}"
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
    NODE_ENV             = "staging"
    PORT                 = "4000"
    DB_PROXY_ENDPOINT    = module.database.proxy_endpoint
    REDIS_URL            = "rediss://${module.cache.endpoint}:${module.cache.port}"
    S3_BUCKET_CLEAN      = module.storage.bucket_names["clean"]
    S3_BUCKET_DERIVED    = module.storage.bucket_names["derived"]
    S3_BUCKET_QUARANTINE = module.storage.bucket_names["quarantine"]
    S3_BUCKET_RAW        = module.storage.bucket_names["raw"]
  }
}

# Staging uses the same ECR repos as prod (one registry, environment-tagged images) rather than
# duplicating repositories — nothing staging-specific to build here beyond referencing them.
data "aws_ecr_repository" "api" {
  name = "veynlo-api"
}

data "aws_ecr_repository" "worker" {
  name = "veynlo-worker"
}

module "ecs_service_api" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-staging-api"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${data.aws_ecr_repository.api.repository_url}:staging-latest"
  container_port         = 4000
  target_group_arn       = module.alb.target_group_arn
  min_count              = 1
  max_count              = 3
  environment            = local.app_environment
  secrets                = local.app_secrets
  task_role_policy_json  = data.aws_iam_policy_document.app_task_permissions.json
  tags                   = local.tags
}

module "ecs_service_worker" {
  source = "../../modules/ecs-service"

  name                   = "veynlo-staging-worker"
  cluster_id             = module.ecs_cluster.cluster_id
  cluster_name           = module.ecs_cluster.cluster_name
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  security_group_id      = aws_security_group.ecs_tasks.id
  image                  = "${data.aws_ecr_repository.worker.repository_url}:staging-latest"
  container_port         = null
  min_count              = 1
  max_count              = 3
  environment            = local.app_environment
  secrets                = local.app_secrets
  task_role_policy_json  = data.aws_iam_policy_document.app_task_permissions.json
  tags                   = local.tags
}
