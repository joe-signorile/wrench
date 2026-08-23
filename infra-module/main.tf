terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
}

# ---------------------------
# S3 bucket (private)
# ---------------------------
resource "aws_s3_bucket" "client" {
  bucket = local.bucket_name
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
  name                              = "${var.project_name}-oac"
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

  # S3 returns 403 for missing keys with OAC; fall back to index.html
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
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
    cloudfront_default_certificate = true
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
