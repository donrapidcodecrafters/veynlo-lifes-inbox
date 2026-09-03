variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "isolated_data_subnet_ids" {
  description = "Exactly 3 subnet IDs — Aurora's DB subnet group needs 2+, and the module's own no-public-IP posture assumes the isolated-data tier."
  type        = list(string)
}

variable "app_security_group_ids" {
  description = "Security groups (ECS tasks etc.) allowed to reach Postgres through RDS Proxy on 5432."
  type        = list(string)
}

variable "master_username" {
  type    = string
  default = "veynlo"
}

variable "min_acu" {
  description = "Blueprint §14: start at 2 ACU minimum."
  type        = number
  default     = 2
}

variable "max_acu" {
  description = "Blueprint §14: start at 32 ACU maximum; raise after load testing."
  type        = number
  default     = 32
}

variable "backup_retention_days" {
  description = "Blueprint §14/§29: 35-day PITR retention in production."
  type        = number
  default     = 35
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
