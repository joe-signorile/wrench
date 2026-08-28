terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 5.0"
      configuration_aliases = [aws.us_east_1]
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  bucket_name = "${var.project_name}-client-${random_id.suffix.hex}"

  tags = merge(var.tags, {
    Project   = var.project_name
    ManagedBy = "wrench"
  })

  # Empty string means apex (root_domain itself); a non-empty label gets
  # "<subdomain>.<root_domain>". null means custom-domain wiring is off.
  fqdn = var.subdomain == null ? null : (
    var.subdomain == "" ? var.root_domain : "${var.subdomain}.${var.root_domain}"
  )
}

# Looked up by domain name (not passed in as an ARN) so sites don't need to
# read wrench/domain's Terraform state — see wrench/domain/main.tf.
data "aws_acm_certificate" "wildcard" {
  count       = var.subdomain != null ? 1 : 0
  domain      = var.root_domain
  statuses    = ["ISSUED"]
  most_recent = true
  provider    = aws.us_east_1
}

# ---------------------------
# S3 bucket (private)
# ---------------------------
resource "aws_s3_bucket" "client" {
  bucket = local.bucket_name
  tags   = local.tags
}

# `wrench deploy --force` deletes a whole versions/<v>/ prefix before replacing
# it. Versioning makes that recoverable; without it the previous build is gone.
resource "aws_s3_bucket_versioning" "client" {
  bucket = aws_s3_bucket.client.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "client" {
  bucket     = aws_s3_bucket.client.id
  depends_on = [aws_s3_bucket_versioning.client]

  # Keep the safety net short — this is a rollback window, not an archive.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }

  # A killed upload can strand multipart parts that are invisible in the
  # console and billed indefinitely.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "client" {
  bucket                  = aws_s3_bucket.client.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------
# CloudFront Origin Access Control
# ---------------------------
resource "aws_cloudfront_origin_access_control" "client" {
  name                              = "${var.project_name}-oac-${random_id.suffix.hex}"
  description                       = "OAC for ${var.project_name} S3 origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---------------------------
# CloudFront distribution
# ---------------------------
resource "aws_cloudfront_distribution" "client" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${var.project_name} client"
  aliases             = var.subdomain == null ? [] : [local.fqdn]
  tags                = local.tags

  origin {
    domain_name              = aws_s3_bucket.client.bucket_regional_domain_name
    origin_id                = "s3-${local.bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.client.id
  }

  # Root index.html: never cache so promote_version takes effect immediately
  ordered_cache_behavior {
    path_pattern           = "/index.html"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-${local.bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # Everything else (versioned assets): cache aggressively — Vite hashes filenames
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-${local.bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  }

  # With OAC, S3 answers a missing key with 403 (never 404 — there is no rule
  # for it because it cannot happen). This fallback is load-bearing for
  # history-API routing inside the versioned iframe.
  #
  # The tradeoff: a genuinely missing asset is answered with the wrapper HTML
  # under a 200, which a browser then fails to parse as JS. What keeps that
  # from happening is upload atomicity — build_tools deletes a partially
  # uploaded version prefix and refuses to promote a version with no
  # index.html, so an incomplete build never becomes reachable.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.subdomain == null ? true : null
    acm_certificate_arn            = var.subdomain == null ? null : data.aws_acm_certificate.wildcard[0].arn
    ssl_support_method             = var.subdomain == null ? null : "sni-only"
    minimum_protocol_version       = var.subdomain == null ? null : "TLSv1.2_2021"
  }
}

# CloudFront's hosted-zone-id is a fixed, well-known AWS constant shared by
# every distribution globally — not looked up, just documented here.
resource "aws_route53_record" "alias" {
  count   = var.subdomain == null ? 0 : 1
  zone_id = var.hosted_zone_id
  name    = local.fqdn
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.client.domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}

# ---------------------------
# Bucket policy: allow CloudFront OAC only
# ---------------------------
data "aws_iam_policy_document" "cloudfront_oac" {
  statement {
    sid    = "AllowCloudFrontOAC"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.client.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.client.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "client" {
  bucket     = aws_s3_bucket.client.id
  policy     = data.aws_iam_policy_document.cloudfront_oac.json
  depends_on = [aws_s3_bucket_public_access_block.client]
}
