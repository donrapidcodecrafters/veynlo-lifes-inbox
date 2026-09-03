output "proxy_endpoint" {
  description = "Application connection endpoint — always go through the proxy, never the cluster endpoint directly."
  value       = aws_db_proxy.this.endpoint
}

output "cluster_reader_endpoint" {
  description = "Direct reader endpoint, for read-offload use cases RDS Proxy's own read/write splitting doesn't cover."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "master_user_secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}
