variable "project_name" {
  description = "Short name used to prefix AWS resource names (bucket, OAC, tags)."
  type        = string
}

variable "subdomain" {
  description = "Subdomain label under root_domain (e.g. \"app\"). Empty string means apex (root_domain itself). Leave null to disable custom-domain wiring entirely (default CloudFront domain only)."
  type        = string
  default     = null
}

variable "root_domain" {
  description = "Root domain the subdomain hangs off (e.g. \"example.com\"). Required when subdomain is set."
  type        = string
  default     = null
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone id for root_domain. Required when subdomain is set."
  type        = string
  default     = null
}

variable "noncurrent_version_retention_days" {
  description = "How long superseded S3 object versions are kept, so a --force replace stays recoverable."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags merged onto every taggable resource."
  type        = map(string)
  default     = {}
}
