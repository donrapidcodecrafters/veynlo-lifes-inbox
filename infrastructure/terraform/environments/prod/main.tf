module "networking" {
  source = "../../modules/networking"

  name               = "veynlo-prod"
  vpc_cidr           = "10.20.0.0/16"
  availability_zones = var.availability_zones
  tags               = { Environment = "prod", Project = "veynlo" }
}
