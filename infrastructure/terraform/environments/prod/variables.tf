variable "aws_region" {
  description = "Primary production region — blueprint §6: us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "availability_zones" {
  description = "Exactly 3 AZs in aws_region."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}
