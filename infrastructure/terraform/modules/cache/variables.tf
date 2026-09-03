variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_app_subnet_ids" {
  type = list(string)
}

variable "app_security_group_ids" {
  type = list(string)
}

variable "max_storage_gb" {
  description = "Serverless cache storage ceiling — cost guardrail, not a hard capacity plan."
  type        = number
  default     = 10
}

variable "max_ecpu_per_second" {
  description = "Serverless cache compute ceiling."
  type        = number
  default     = 5000
}

variable "tags" {
  type    = map(string)
  default = {}
}
