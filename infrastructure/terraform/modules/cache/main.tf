# ElastiCache Valkey Serverless (blueprint §16) — ephemeral cache/rate-limit/lock state, not a second
# permanent database. Standard Redis-protocol endpoint, so the existing BullMQ/ioredis code this repo
# already runs against local Redis needs only a connection-string change to point here — see the
# blueprint feasibility review's recommendation not to rewrite the queue layer onto SQS/EventBridge
# unless a specific need for it shows up later.

resource "aws_security_group" "cache" {
  name_prefix = "${var.name}-cache-"
  description = "ElastiCache Valkey Serverless — inbound only from application security groups."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-cache" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_app" {
  for_each                     = toset(var.app_security_group_ids)
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = each.value
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_elasticache_serverless_cache" "this" {
  name        = var.name
  engine      = "valkey"
  description = "${var.name} ephemeral cache / rate limits / distributed locks"

  cache_usage_limits {
    data_storage {
      maximum = var.max_storage_gb
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = var.max_ecpu_per_second
    }
  }

  security_group_ids = [aws_security_group.cache.id]
  subnet_ids         = var.private_app_subnet_ids

  tags = merge(var.tags, { Name = var.name })
}
