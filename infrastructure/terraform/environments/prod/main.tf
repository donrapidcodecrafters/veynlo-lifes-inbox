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

# Placeholder until the ecs-service module exists — the database module's RDS Proxy needs to know which
# security group ECS tasks will run under so it can open exactly that inbound rule and nothing broader.
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
