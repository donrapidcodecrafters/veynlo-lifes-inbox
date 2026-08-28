variable "name" {
  description = "Prefix for all resource names, e.g. \"veynlo-prod\"."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. See blueprint §7: 10.20.0.0/16 for production."
  type        = string
}

variable "availability_zones" {
  description = "Exactly 3 AZs, per blueprint §6/§7's three-AZ production footprint."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) == 3
    error_message = "Provide exactly 3 availability zones."
  }
}

variable "use_regional_nat_gateway" {
  description = <<-EOT
    Use a single AWS Regional NAT Gateway (auto-expands across the AZs where workloads
    exist) instead of one zonal NAT Gateway per AZ. Verified real (announced Nov 2025)
    but recent enough that regional availability should be confirmed for the target
    region before relying on it in prod — see SECURITY.md / the blueprint review.
    Falls back to per-AZ zonal NAT gateways when false.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}
