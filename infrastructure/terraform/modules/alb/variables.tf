variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  description = "ECS task security group — the target group's health checks and traffic come from here."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener. Leave null to stand up HTTP-only (e.g. before a domain/ACM cert exists) — see blueprint §8."
  type        = string
  default     = null
}

variable "health_check_path" {
  type    = string
  default = "/health/ready"
}

variable "tags" {
  type    = map(string)
  default = {}
}
