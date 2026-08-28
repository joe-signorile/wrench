#!/usr/bin/env python3
"""
build_tools.py - S3 upload / promote / list engine for wrench-managed static SPAs

Subcommands:
  upload --version V [--force]   Upload the existing dist/ to S3
  promote --version V            Promote a version (root index.html + CloudFront)
  list                           List all deployed versions in S3

Building is the Node CLI's job (src/commands/build.mjs); this module only ever
talks to AWS.

Configuration, all set by the `wrench` CLI from terraform output and the
invoking project's "wrench" package.json block:
  WRENCH_PROJECT_ROOT    - absolute path to the project being deployed
  WRENCH_S3_BUCKET       - S3 bucket name (required)
  WRENCH_CF_DISTRIBUTION - CloudFront distribution ID (required)
  WRENCH_DISPLAY_NAME    - name shown on the promote page (default: "App")
  WRENCH_ACCENT_COLOR    - spinner accent color hex (default: "#569cd6")
  WRENCH_PROJECT_NAME    - stable slug (package.json "name"), used as the
                           manifest.json key in the registry bucket
  WRENCH_SUBDOMAIN       - this site's subdomain label. UNSET means custom-domain
                           wiring is off; set-but-empty means the apex. The two
                           are not interchangeable.
  WRENCH_ROOT_DOMAIN     - root domain sites are published under
  WRENCH_REGISTRY_BUCKET - S3 bucket holding the shared manifest.json for the
                           landing page; blank skips the registry update
  AWS_REGION             - AWS region (default: us-west-1)
  WRENCH_DEBUG           - set to any value to get tracebacks instead of a
                           one-line error

Requirements:
  pip install -r requirements.txt
  AWS credentials configured (aws configure or env vars)
"""

import argparse
import datetime
import hashlib
import html
import json
import logging
import mimetypes
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Dict, List, Optional

try:
    import boto3
    from botocore.config import Config as BotoConfig
    from botocore.exceptions import ClientError, NoCredentialsError
except ModuleNotFoundError:
    sys.exit("boto3 is required — pip install boto3")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("build_tools")

S3_VERSION_PREFIX = "versions/"
THREADS = 8
REGISTRY_MAX_ATTEMPTS = 3

SEMVER_STRICT_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

# Transient S3/CloudFront throttling should not fail a deploy.
_BOTO_CONFIG = BotoConfig(retries={"max_attempts": 10, "mode": "standard"})


# ---------------------------
# Configuration
# ---------------------------

@dataclass(frozen=True)
class WrenchConfig:
    bucket: str
    cloudfront_id: str
    project_root: str
    region: str = "us-west-1"
    display_name: str = "App"
    accent_color: str = "#569cd6"
    project_name: str = ""
    # None: custom-domain wiring is off. "": the apex. "app": app.<root_domain>.
    subdomain: Optional[str] = None
    root_domain: str = ""
    registry_bucket: str = ""

    def __post_init__(self):
        if not self.bucket:
            raise RuntimeError(
                "WRENCH_S3_BUCKET is not set.\n"
                "Use 'wrench deploy', which sets it automatically from terraform output,\n"
                "or run manually in infra/:\n"
                "  export WRENCH_S3_BUCKET=$(terraform output -raw bucket_name)\n"
                "  export WRENCH_CF_DISTRIBUTION=$(terraform output -raw cloudfront_distribution_id)"
            )
        # A blank distribution id used to silently skip invalidation, leaving the
        # CDN serving the previous version while the deploy reported success.
        if not self.cloudfront_id:
            raise RuntimeError(
                "WRENCH_CF_DISTRIBUTION is not set — refusing to deploy without a "
                "CloudFront invalidation, which would leave the site serving a stale version."
            )
        if not HEX_COLOR_RE.match(self.accent_color):
            raise ValueError(
                f"WRENCH_ACCENT_COLOR '{self.accent_color}' is not a hex color like '#569cd6'."
            )


def config_from_env(env=None) -> WrenchConfig:
    env = os.environ if env is None else env
    root = env.get("WRENCH_PROJECT_ROOT")
    return WrenchConfig(
        bucket=env.get("WRENCH_S3_BUCKET", ""),
        cloudfront_id=env.get("WRENCH_CF_DISTRIBUTION", ""),
        project_root=os.path.abspath(root) if root else os.getcwd(),
        region=env.get("AWS_REGION", "us-west-1"),
        display_name=env.get("WRENCH_DISPLAY_NAME", "App"),
        accent_color=env.get("WRENCH_ACCENT_COLOR") or "#569cd6",
        project_name=env.get("WRENCH_PROJECT_NAME", ""),
        # Absent and empty mean different things — .get() preserves the distinction.
        subdomain=env.get("WRENCH_SUBDOMAIN"),
        root_domain=env.get("WRENCH_ROOT_DOMAIN", ""),
        registry_bucket=env.get("WRENCH_REGISTRY_BUCKET", ""),
    )


def _client(cfg: WrenchConfig, service: str):
    return boto3.client(service, region_name=cfg.region, config=_BOTO_CONFIG)


def _add_file_log(project_root: str):
    """Attach the .wrench/build.log handler. Deliberately NOT inside dist/:
    the upload walks dist/, so a log written there gets published to the CDN
    along with the build."""
    log_dir = os.path.join(project_root, ".wrench")
    os.makedirs(log_dir, exist_ok=True)
    logging.getLogger().addHandler(
        logging.FileHandler(os.path.join(log_dir, "build.log"), mode="w")
    )


# ---------------------------
# Helpers
# ---------------------------

def _validate_semver(version: str) -> str:
    if not isinstance(version, str) or not SEMVER_STRICT_RE.match(version):
        raise ValueError(f"Version '{version}' is not valid strict SemVer (X.Y.Z).")
    return version


def _version_prefix(version: str) -> str:
    return f"{S3_VERSION_PREFIX}{_validate_semver(version)}/"


def _guess_content_type(path: str) -> str:
    content_type, _ = mimetypes.guess_type(path)
    return content_type or "binary/octet-stream"


def _s3_list_prefix(client, bucket: str, prefix: str) -> List[Dict]:
    paginator = client.get_paginator("list_objects_v2")
    objs = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objs.extend(page.get("Contents", []))
    return objs


def _delete_prefix(client, bucket: str, prefix: str) -> int:
    # This is irreversible and mass-scoped, so it validates its own argument
    # rather than trusting a caller a hundred lines away.
    if not prefix.startswith(S3_VERSION_PREFIX) or not prefix.endswith("/"):
        raise ValueError(f"Refusing to delete prefix '{prefix}': not a versions/<v>/ prefix.")
    _validate_semver(prefix[len(S3_VERSION_PREFIX):-1])

    logger.info("Deleting all objects under s3://%s/%s", bucket, prefix)
    paginator = client.get_paginator("list_objects_v2")
    total_deleted = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        contents = page.get("Contents", [])
        if not contents:
            continue
        keys = [{"Key": obj["Key"]} for obj in contents]
        for i in range(0, len(keys), 1000):
            resp = client.delete_objects(
                Bucket=bucket, Delete={"Objects": keys[i : i + 1000]}
            )
            # delete_objects reports per-key failures in Errors and does not
            # raise. Ignoring them leaves stale files inside the version prefix.
            errors = resp.get("Errors", [])
            if errors:
                detail = ", ".join(f"{e.get('Key')}: {e.get('Message')}" for e in errors[:5])
                raise RuntimeError(f"Failed to delete {len(errors)} object(s) under {prefix} — {detail}")
            total_deleted += len(resp.get("Deleted", []))
    logger.info("Deleted %d objects under prefix %s", total_deleted, prefix)
    return total_deleted


def _cache_control(filename: str) -> str:
    if os.path.basename(filename).lower() == "index.html":
        return "no-cache, max-age=0, must-revalidate"
    return "public, max-age=31536000, immutable"


# ---------------------------
# Public API
# ---------------------------

def build_and_upload(cfg: WrenchConfig, version: str, force: bool = False) -> str:
    """
    Upload dist/ to S3 under versions/<version>/.

    The prefix ends up either complete or absent: a partial upload is cleaned
    up before the error propagates, so a retry never has to reach for --force.
    """
    target_prefix = _version_prefix(version)
    build_dir = os.path.join(cfg.project_root, "dist")

    logger.info("=" * 60)
    logger.info("UPLOADING v%s", version)
    logger.info("=" * 60)

    s3_client = _client(cfg, "s3")

    existing = _s3_list_prefix(s3_client, cfg.bucket, target_prefix)
    if existing:
        logger.info("Version %s already exists with %d objects.", version, len(existing))
        if not force:
            raise RuntimeError(
                f"Aborting: s3://{cfg.bucket}/{target_prefix} already exists. "
                f"Bump the version, or pass --force to replace it."
            )
        _delete_prefix(s3_client, cfg.bucket, target_prefix)

    files = []
    for root_dir, _, filenames in os.walk(build_dir):
        for fname in filenames:
            full = os.path.join(root_dir, fname)
            rel = os.path.relpath(full, build_dir).replace(os.sep, "/")
            files.append((full, f"{target_prefix}{rel}"))

    if not files:
        raise RuntimeError(f"No files found in {build_dir} to upload.")
    if f"{target_prefix}index.html" not in {key for _, key in files}:
        raise RuntimeError(f"{build_dir} has no index.html — refusing to upload an unservable version.")

    total = len(files)
    logger.info("Uploading %d files to s3://%s/%s", total, cfg.bucket, target_prefix)

    counter = {"done": 0}
    lock = threading.Lock()

    def _upload(file_and_key):
        fullpath, key = file_and_key
        s3_client.upload_file(
            Filename=fullpath,
            Bucket=cfg.bucket,
            Key=key,
            ExtraArgs={
                "ContentType": _guess_content_type(fullpath),
                "CacheControl": _cache_control(fullpath),
            },
        )
        with lock:
            counter["done"] += 1
            logger.info("Uploaded %d/%d: %s", counter["done"], total, key)

    try:
        with ThreadPoolExecutor(max_workers=THREADS) as exe:
            futures = [exe.submit(_upload, fk) for fk in files]
            for f in as_completed(futures):
                exc = f.exception()
                if exc:
                    raise exc
    except Exception:
        logger.error("Upload failed — removing the partial version prefix.")
        try:
            _delete_prefix(s3_client, cfg.bucket, target_prefix)
        except Exception as cleanup_err:  # pragma: no cover - best effort
            logger.error("Could not clean up %s: %s", target_prefix, cleanup_err)
        raise

    logger.info("Upload complete: s3://%s/%s", cfg.bucket, target_prefix)
    return version


def list_versions(cfg: WrenchConfig) -> List[str]:
    """List all deployed versions in S3, newest first."""
    s3_client = _client(cfg, "s3")
    paginator = s3_client.get_paginator("list_objects_v2")
    versions = set()
    for page in paginator.paginate(Bucket=cfg.bucket, Prefix=S3_VERSION_PREFIX, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            remainder = cp.get("Prefix", "")[len(S3_VERSION_PREFIX):].rstrip("/")
            if remainder:
                versions.add(remainder)
    # Sort numerically so 0.0.10 beats 0.0.9; anything non-SemVer sorts last.
    def key(v):
        m = SEMVER_STRICT_RE.match(v)
        return (1, tuple(int(p) for p in v.split("."))) if m else (0, ())

    sorted_versions = sorted(versions, key=key, reverse=True)
    logger.info("Found %d version(s): %s", len(sorted_versions), sorted_versions)
    return sorted_versions


def render_promote_page(cfg: WrenchConfig, version: str, version_url: str) -> str:
    """The wrapper page written to the bucket root.

    display_name comes from the project's package.json and is interpolated into
    markup, so it is escaped here; accent_color is validated as a hex color by
    WrenchConfig, which is what keeps it out of the CSS as an injection vector.
    """
    title = html.escape(cfg.display_name)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>{title}</title>
    <style>
        body {{
            margin: 0;
            padding: 0;
            overflow: hidden;
            background: #101010;
        }}
        iframe {{
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border: none;
        }}
        .loading {{
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #101010;
            color: #fff;
            font-family: monospace;
            z-index: 9999;
        }}
        .spinner {{
            width: 40px;
            height: 40px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: {cfg.accent_color};
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }}
        @keyframes spin {{
            to {{ transform: rotate(360deg); }}
        }}
    </style>
</head>
<body>
    <div class="loading" id="loading">
        <div style="text-align: center;">
            <div class="spinner"></div>
            <p>{html.escape(version)}</p>
        </div>
    </div>
    <iframe id="game-frame" src="{html.escape(version_url, quote=True)}" allow="autoplay; fullscreen"></iframe>
    <script>
        const iframe = document.getElementById('game-frame');
        const loading = document.getElementById('loading');
        iframe.onload = function() {{
            loading.style.display = 'none';
        }};
        setTimeout(function() {{
            loading.style.display = 'none';
        }}, 3000);
    </script>
</body>
</html>"""


def promote_version(cfg: WrenchConfig, version: str) -> Dict:
    """
    Promote a version by writing an iframe wrapper at the S3 root index.html
    and invalidating CloudFront so it takes effect immediately.
    """
    version_prefix = _version_prefix(version)
    s3_client = _client(cfg, "s3")

    # A non-empty listing is not proof the version is servable — a partial
    # upload can leave assets without the entrypoint.
    try:
        s3_client.head_object(Bucket=cfg.bucket, Key=f"{version_prefix}index.html")
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            raise RuntimeError(
                f"Version '{version}' has no index.html at "
                f"s3://{cfg.bucket}/{version_prefix} — refusing to promote it."
            ) from e
        raise

    logger.info("Promoting v%s", version)

    version_url = f"/{version_prefix}index.html"
    s3_client.put_object(
        Bucket=cfg.bucket,
        Key="index.html",
        Body=render_promote_page(cfg, version, version_url).encode("utf-8"),
        ContentType="text/html",
        CacheControl="no-cache, no-store, must-revalidate, max-age=0",
        Metadata={
            "redirects-to-version": version,
            "promoted-at": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )
    logger.info("Uploaded root index.html -> v%s", version)

    # Mirror the promoted version's favicon to the bucket root (unversioned)
    # so "https://<site>/favicon.svg" always resolves — bucket root otherwise
    # only ever holds this iframe-wrapper index.html, not any real assets.
    try:
        s3_client.copy_object(
            Bucket=cfg.bucket,
            Key="favicon.svg",
            CopySource={"Bucket": cfg.bucket, "Key": f"{version_prefix}favicon.svg"},
            ContentType="image/svg+xml",
            MetadataDirective="REPLACE",
        )
        logger.info("Mirrored favicon.svg from v%s to bucket root", version)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404", "NotFound"):
            logger.info("No favicon.svg in v%s; skipping root mirror", version)
        else:
            raise

    # "/" as well as "/index.html": the bare-root request is resolved through
    # default_root_object, and invalidating only the key is not documented to
    # cover it.
    paths = ["/", "/index.html", "/favicon.svg"]
    cf = _client(cfg, "cloudfront")
    caller_ref = (
        f"promote-{version}-"
        f"{datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{hashlib.sha1(version.encode()).hexdigest()[:6]}"
    )
    resp = cf.create_invalidation(
        DistributionId=cfg.cloudfront_id,
        InvalidationBatch={
            "Paths": {"Quantity": len(paths), "Items": paths},
            "CallerReference": caller_ref,
        },
    )
    invalidation_id = resp.get("Invalidation", {}).get("Id")
    logger.info("CloudFront invalidation created: %s", invalidation_id)

    upsert_registry_entry(cfg, version)

    return {
        "status": "promoted",
        "bucket": cfg.bucket,
        "version": version,
        "version_url": version_url,
        "cloudfront_invalidation_id": invalidation_id,
    }


def site_url(cfg: WrenchConfig) -> str:
    if cfg.subdomain is None:
        raise ValueError("No subdomain configured — this site has no custom-domain URL.")
    if not cfg.root_domain:
        raise ValueError("WRENCH_ROOT_DOMAIN is not set — cannot build a site URL.")
    fqdn = cfg.root_domain if cfg.subdomain == "" else f"{cfg.subdomain}.{cfg.root_domain}"
    return f"https://{fqdn}/"


def upsert_registry_entry(cfg: WrenchConfig, version: str) -> None:
    """
    Upsert this site's entry into the shared manifest.json that the landing
    page reads. No-op (with a log line) when the registry bucket, project name,
    or custom-domain wiring isn't configured — that keeps this safe to call for
    sites not yet migrated to custom domains, and for the registry bucket's own
    bootstrap deploy before WRENCH_REGISTRY_BUCKET is known.

    The read-modify-write is guarded with a conditional put (If-Match on the
    ETag we read, If-None-Match on create), retried on conflict, so concurrent
    promotes across sites cannot clobber each other.
    """
    if not cfg.registry_bucket or not cfg.project_name:
        logger.info("Registry bucket/project name not configured; skipping manifest update.")
        return
    if cfg.subdomain is None:
        logger.info("No subdomain configured for '%s'; skipping manifest update.", cfg.project_name)
        return

    url = site_url(cfg)
    versions = list_versions(cfg)
    registry_client = _client(cfg, "s3")

    entry = {
        "name": cfg.project_name,
        "displayName": cfg.display_name,
        "accentColor": cfg.accent_color,
        "subdomain": cfg.subdomain,
        "url": url,
        "faviconUrl": f"{url}favicon.svg",
        "version": version,
        "versions": versions,
        "promotedAt": datetime.datetime.now(datetime.UTC).isoformat(),
    }

    for attempt in range(1, REGISTRY_MAX_ATTEMPTS + 1):
        try:
            resp = registry_client.get_object(Bucket=cfg.registry_bucket, Key="manifest.json")
            manifest = json.loads(resp["Body"].read())
            condition = {"IfMatch": resp["ETag"]}
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("NoSuchKey", "404", "NotFound"):
                raise
            manifest = {"sites": {}}
            condition = {"IfNoneMatch": "*"}

        if not isinstance(manifest, dict):
            manifest = {"sites": {}}
        manifest.setdefault("sites", {})[cfg.project_name] = entry

        try:
            registry_client.put_object(
                Bucket=cfg.registry_bucket,
                Key="manifest.json",
                Body=json.dumps(manifest, indent=2).encode("utf-8"),
                ContentType="application/json",
                CacheControl="no-cache, max-age=0, must-revalidate",
                **condition,
            )
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("PreconditionFailed", "ConditionalRequestConflict"):
                raise
            logger.warning(
                "manifest.json changed underneath us (attempt %d/%d); retrying.",
                attempt, REGISTRY_MAX_ATTEMPTS,
            )
            continue

        logger.info(
            "Updated manifest.json in registry bucket %s for site '%s'",
            cfg.registry_bucket, cfg.project_name,
        )
        return

    raise RuntimeError(
        f"Gave up updating manifest.json in {cfg.registry_bucket} after "
        f"{REGISTRY_MAX_ATTEMPTS} conflicting attempts."
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="wrench S3 upload/promote tool")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_upload = sub.add_parser("upload", help="Upload the existing dist/ to S3")
    p_upload.add_argument("--version", required=True, help="Version to upload (X.Y.Z)")
    p_upload.add_argument("--force", action="store_true", help="Replace the version prefix if it already exists")

    p_promote = sub.add_parser("promote", help="Promote a version (root index.html + CloudFront)")
    p_promote.add_argument("--version", required=True, help="Version to promote (X.Y.Z)")

    sub.add_parser("list", help="List all deployed versions in S3")

    args = parser.parse_args(argv)
    cfg = config_from_env()
    if args.cmd in ("upload", "promote"):
        _add_file_log(cfg.project_root)

    if args.cmd == "upload":
        build_and_upload(cfg, version=args.version, force=args.force)
    elif args.cmd == "promote":
        promote_version(cfg, args.version)
    elif args.cmd == "list":
        versions = list_versions(cfg)
        print("\n".join(versions) if versions else "(no versions deployed)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except NoCredentialsError:
        sys.exit("No AWS credentials found — configure them: aws configure")
    except Exception as e:
        if os.environ.get("WRENCH_DEBUG"):
            raise
        sys.exit(f"{type(e).__name__}: {e}")
