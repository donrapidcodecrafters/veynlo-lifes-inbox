output "dns_name" {
  value = aws_lb.this.dns_name
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "zone_id" {
  description = "For a Route 53 alias record pointing a real domain at this ALB."
  value       = aws_lb.this.zone_id
}
