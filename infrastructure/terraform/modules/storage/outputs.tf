output "bucket_names" {
  value = { for k, b in aws_s3_bucket.buckets : k => b.bucket }
}

output "bucket_arns" {
  value = { for k, b in aws_s3_bucket.buckets : k => b.arn }
}

output "kms_key_arn" {
  value = aws_kms_key.s3.arn
}
