terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6.24 for aws_nat_gateway's regional availability_mode (added Nov 2025) — see the networking
      # module's own comment on why use_regional_nat_gateway defaults to false regardless.
      version = ">= 6.24"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
