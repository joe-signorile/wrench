output "bucket_name" {
  description = "S3 bucket name."
  value       = aws_s3_bucket.client.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.client.id
}

output "cloudfront_domain" {
  description = "CloudFront domain name (e.g. xxx.cloudfront.net). Point your DNS CNAME here."
  value       = aws_cloudfront_distribution.client.domain_name
}

output "fqdn" {
  description = "Custom-domain FQDN this distribution is aliased to, or null if subdomain wiring is disabled."
  value       = local.fqdn
}
