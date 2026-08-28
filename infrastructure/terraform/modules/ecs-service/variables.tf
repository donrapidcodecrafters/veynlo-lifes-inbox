variable "name" {
  description = "e.g. \"veynlo-prod-api\" or \"veynlo-prod-worker\"."
  type        = string
}

variable "cluster_id" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "private_app_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "image" {
  description = "Full ECR image URI including tag/digest — e.g. \"<account>.dkr.ecr.<region>.amazonaws.com/veynlo-api:sha-abc123\". Deploy by immutable digest/SHA tag in production, never a mutable \"latest\" (blueprint §25)."
  type        = string
}

variable "container_port" {
  description = "Null for a worker service with no inbound traffic (no target group attachment)."
  type        = number
  default     = null
}

variable "target_group_arn" {
  description = "Required when container_port is set."
  type        = string
  default     = null
}

variable "cpu" {
  type    = number
  default = 1024 # 1 vCPU — blueprint §10/§12 launch baseline
}

variable "memory" {
  type    = number
  default = 2048 # 2 GB
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "min_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 10
}

variable "environment" {
  description = "Plain (non-secret) environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Env var name -> Secrets Manager/SSM ARN, injected at task start rather than baked into the image or task definition in plaintext."
  type        = map(string)
  default     = {}
}

variable "task_role_policy_json" {
  description = "IAM policy JSON granting this service's own application permissions (S3, KMS, Secrets Manager reads, etc.) — deliberately passed in rather than hardcoded here, since the API and worker task roles need different permissions and this module has no knowledge of what other modules (storage, database, ...) exist."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
