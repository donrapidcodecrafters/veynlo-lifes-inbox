# Three-AZ VPC per blueprint §7: public/edge, private-app, and isolated-data subnets in each AZ.
# No production database or application task receives a public IP — only the edge subnets are public,
# and only NAT gateways / a future ALB live there.

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

# +---------------------------------------------------------------+
# | Subnets — /20 each keeps room to grow within a /16 VPC CIDR   |
# +---------------------------------------------------------------+

resource "aws_subnet" "public" {
  count                   = 3
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index) # 10.20.0.0/20, 10.20.16.0/20, 10.20.32.0/20
  map_public_ip_on_launch = false                                    # NAT gateways get their EIP explicitly; nothing else here should auto-assign one
  tags                    = merge(var.tags, { Name = "${var.name}-public-${var.availability_zones[count.index]}", Tier = "public" })
}

resource "aws_subnet" "private_app" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 3) # 10.20.48.0/20 ...
  tags              = merge(var.tags, { Name = "${var.name}-private-app-${var.availability_zones[count.index]}", Tier = "private-app" })
}

resource "aws_subnet" "isolated_data" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 6) # 10.20.96.0/20 ...
  tags              = merge(var.tags, { Name = "${var.name}-isolated-data-${var.availability_zones[count.index]}", Tier = "isolated-data" })
}

# +---------------------------------------------------------------+
# | NAT — regional (single, auto-expanding) or per-AZ zonal       |
# +---------------------------------------------------------------+
# Regional NAT Gateway requires hashicorp/aws >= 6.24 (added Nov 2025) and AWS support for
# `availability_mode = "regional"` in the target region — confirmed real, but recent enough that
# `use_regional_nat_gateway` defaults to false; flip it once that's verified for the deployment region.
# See SECURITY.md / the blueprint feasibility review for why this defaults conservative.

resource "aws_eip" "nat_regional" {
  count  = var.use_regional_nat_gateway ? 1 : 0
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-regional-eip" })
}

resource "aws_nat_gateway" "regional" {
  count             = var.use_regional_nat_gateway ? 1 : 0
  connectivity_type = "public"
  availability_mode = "regional"
  allocation_id     = aws_eip.nat_regional[0].id
  vpc_id            = aws_vpc.this.id
  tags              = merge(var.tags, { Name = "${var.name}-nat-regional" })
  depends_on        = [aws_internet_gateway.this]
}

resource "aws_eip" "nat_zonal" {
  count  = var.use_regional_nat_gateway ? 0 : 3
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${var.availability_zones[count.index]}-eip" })
}

resource "aws_nat_gateway" "zonal" {
  count         = var.use_regional_nat_gateway ? 0 : 3
  allocation_id = aws_eip.nat_zonal[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name}-nat-${var.availability_zones[count.index]}" })
  depends_on    = [aws_internet_gateway.this]
}

# +---------------------------------------------------------------+
# | Route tables                                                  |
# +---------------------------------------------------------------+

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ so a zonal NAT failure only affects its own AZ's egress; a regional NAT
# gateway is one resource, so all three route tables simply point at the same one in that mode.
resource "aws_route_table" "private" {
  count  = 3
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = var.use_regional_nat_gateway ? aws_nat_gateway.regional[0].id : aws_nat_gateway.zonal[count.index].id
  }
  tags = merge(var.tags, { Name = "${var.name}-private-${var.availability_zones[count.index]}" })
}

resource "aws_route_table_association" "private_app" {
  count          = 3
  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Isolated-data subnets get no default route at all — Aurora/RDS Proxy/Valkey never initiate outbound
# internet traffic, so there's nothing for them to reach through a NAT gateway. VPC endpoints (S3 gateway
# endpoint below, interface endpoints for ECR/Secrets Manager/etc.) are the only way anything in this
# tier reaches an AWS service.
resource "aws_route_table_association" "isolated_data" {
  count          = 3
  subnet_id      = aws_subnet.isolated_data[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# +---------------------------------------------------------------+
# | VPC endpoints                                                 |
# +---------------------------------------------------------------+

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = merge(var.tags, { Name = "${var.name}-s3-endpoint" })
}

data "aws_region" "current" {}
