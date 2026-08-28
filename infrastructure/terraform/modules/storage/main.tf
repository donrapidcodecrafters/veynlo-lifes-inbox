# Private, KMS-encrypted S3 (blueprint §17) — four buckets, each with a distinct role/retention policy
# rather than one bucket with prefixes, so an overly broad IAM policy on one role can't accidentally reach
# a different trust tier (e.g. the OCR worker's quarantine-bucket access should never imply clean-originals
# access).

resource "aws_kms_key" "s3" {
  description             = "${var.name} S3 document storage encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(var.tags, { Name = "${var.name}-s3-kms" })
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${var.name}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

locals {
  buckets = {
    quarantine = "${var.name}-upload-quarantine"
    clean      = "${var.name}-clean-originals"
    derived    = "${var.name}-derived-assets"
    raw        = "${var.name}-raw-payload-archive"
  }
}

resource "aws_s3_bucket" "buckets" {
  for_each = local.buckets
  bucket   = each.value
  tags     = merge(var.tags, { Name = each.value, Role = each.key })
}

resource "aws_s3_bucket_public_access_block" "buckets" {
  for_each                = aws_s3_bucket.buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "buckets" {
  for_each = aws_s3_bucket.buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_ownership_controls" "buckets" {
  for_each = aws_s3_bucket.buckets
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced" # disables ACL-based ownership entirely — bucket policies/IAM only, per blueprint §17
  }
}

# Deny any non-TLS request to every bucket — the one policy statement every bucket shares regardless of role.
resource "aws_s3_bucket_policy" "deny_insecure_transport" {
  for_each = aws_s3_bucket.buckets
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [each.value.arn, "${each.value.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# Upload quarantine — no document is available to normal users until validation/scanning completes, so
# nothing here should live long: aggressive expiry, no versioning (there's nothing worth recovering).
resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.buckets["quarantine"].id
  rule {
    id     = "expire-unvalidated-uploads"
    status = "Enabled"
    filter {}
    expiration {
      days = 2
    }
  }
}

# Clean originals — versioned (recovery requirements justify it here: this is the actual source document),
# noncurrent versions lifecycle to cheaper storage/expiration so versioning doesn't grow unbounded.
resource "aws_s3_bucket_versioning" "clean" {
  bucket = aws_s3_bucket.buckets["clean"].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "clean" {
  bucket = aws_s3_bucket.buckets["clean"].id
  rule {
    id     = "noncurrent-version-lifecycle"
    status = "Enabled"
    filter {}
    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
}

# Derived assets (thumbnails, OCR output, previews) — regenerable from the clean original, so no
# versioning; just a straightforward IA transition for cost.
resource "aws_s3_bucket_lifecycle_configuration" "derived" {
  bucket = aws_s3_bucket.buckets["derived"].id
  rule {
    id     = "transition-to-ia"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }
}

# Raw provider payload archive — "short/controlled retention for reproducibility and evidence; lifecycle
# aggressively" per blueprint §17.
resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.buckets["raw"].id
  rule {
    id     = "expire-raw-payloads"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}
