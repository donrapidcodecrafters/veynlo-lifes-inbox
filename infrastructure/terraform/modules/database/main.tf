# Aurora PostgreSQL Serverless v2 (blueprint §14): writer + hot reader, RDS Proxy in front,
# KMS-encrypted, isolated-data subnets only (no public IP), 35-day PITR by default.

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "aurora" {
  description             = "${var.name} Aurora storage encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(var.tags, { Name = "${var.name}-aurora-kms" })
}

resource "aws_kms_alias" "aurora" {
  name          = "alias/${var.name}-aurora"
  target_key_id = aws_kms_key.aurora.key_id
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.isolated_data_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-db" })
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name}-aurora-"
  description = "Aurora cluster — inbound Postgres only from the RDS Proxy security group."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-aurora" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "proxy" {
  name_prefix = "${var.name}-rds-proxy-"
  description = "RDS Proxy — inbound Postgres only from application security groups."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-rds-proxy" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_app" {
  for_each                     = toset(var.app_security_group_ids)
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_database" {
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = aws_security_group.database.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_proxy" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.proxy.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_rds_cluster" "this" {
  cluster_identifier          = var.name
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned" # Serverless v2 instances run under the standard "provisioned" cluster engine mode
  engine_version              = "17.7"
  database_name               = "veynlo"
  master_username             = var.master_username
  manage_master_user_password = true # RDS-managed Secrets Manager secret — no password variable to leak into state/CI
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  storage_encrypted           = true
  kms_key_id                  = aws_kms_key.aurora.arn
  backup_retention_period     = var.backup_retention_days
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-final"

  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
  }

  tags = merge(var.tags, { Name = var.name })
}

# Writer + one hot reader (blueprint §14: "1 Serverless v2 writer + 1 Serverless v2 reader/failover
# target in a different AZ") — Aurora elects the writer among cluster instances automatically; both run
# identical db.serverless instance class since capacity comes from the cluster's ACU range above, not a
# per-instance size choice.
resource "aws_rds_cluster_instance" "instances" {
  count              = 2
  identifier         = "${var.name}-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version
  tags               = merge(var.tags, { Name = "${var.name}-${count.index}" })
}

# +---------------------------------------------------------------+
# | RDS Proxy                                                     |
# +---------------------------------------------------------------+

data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = "${var.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "proxy_secrets_access" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_rds_cluster.this.master_user_secret[0].secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.aurora.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "proxy_secrets_access" {
  name   = "${var.name}-rds-proxy-secrets"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy_secrets_access.json
}

data "aws_region" "current" {}

resource "aws_db_proxy" "this" {
  name                   = var.name
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.isolated_data_subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy.id]
  require_tls            = true

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_rds_cluster.this.master_user_secret[0].secret_arn
  }

  tags = merge(var.tags, { Name = var.name })
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    max_connections_percent = 100
  }
}

resource "aws_db_proxy_target" "this" {
  db_proxy_name         = aws_db_proxy.this.name
  target_group_name     = aws_db_proxy_default_target_group.this.name
  db_cluster_identifier = aws_rds_cluster.this.cluster_identifier
}
