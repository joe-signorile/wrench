#!/usr/bin/env python3
"""
build_tools.py - Shared build/deploy engine for wrench-managed static SPAs

Subcommands:
  build [--clean]                   Build frontend locally (no upload)
  deploy [--clean] [--version V] [--force]  Build + upload to S3 + promote
  upload [--version V] [--force]    Upload existing dist/ to S3
  promote [--version V]             Promote a version (root index.html + CloudFront)
  list                              List all deployed versions in S3

Configuration (set by `wrench deploy`/`wrench infra`/`wrench promote` from
terraform output and the invoking project's "wrench" package.json config):
  WRENCH_PROJECT_ROOT   - absolute path to the project being built/deployed
  WRENCH_S3_BUCKET      - S3 bucket name
  WRENCH_CF_DISTRIBUTION - CloudFront distribution ID
  WRENCH_DISPLAY_NAME   - name shown on the promote page (default: "App")
  WRENCH_ACCENT_COLOR   - spinner accent color hex (default: "#569cd6")
  WRENCH_PROJECT_NAME   - stable slug (package.json "name"), used as the
                          manifest.json key in the registry bucket
  WRENCH_SUBDOMAIN      - this site's subdomain label ("" for apex); blank
                          means "not migrated to custom domains yet"
  WRENCH_ROOT_DOMAIN    - root domain sites are published under
  WRENCH_REGISTRY_BUCKET - S3 bucket holding the shared manifest.json for the
                          landing page; blank skips the registry update
  AWS_REGION            - AWS region (default: us-west-1)

Requirements:
  pip install -r requirements.txt
  AWS credentials configured (aws configure or env vars)
"""

import argparse
import datetime
import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
except ModuleNotFoundError:
    sys.exit("boto3 is required — pip install boto3")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("build_tools")


def _add_file_log():
    """Attach the dist/build.log handler. Called from __main__ only, so that
    importing this module never creates directories in the caller's CWD."""
    log_dir = os.path.join(_project_root(), "dist")
    os.makedirs(log_dir, exist_ok=True)
    logging.getLogger().addHandler(
        logging.FileHandler(os.path.join(log_dir, "build.log"), mode="w")
    )


BUCKET = os.environ.get("WRENCH_S3_BUCKET", "")
CLOUDFRONT_ID = os.environ.get("WRENCH_CF_DISTRIBUTION", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-west-1")
DISPLAY_NAME = os.environ.get("WRENCH_DISPLAY_NAME", "App")
ACCENT_COLOR = os.environ.get("WRENCH_ACCENT_COLOR", "#569cd6")
PROJECT_NAME = os.environ.get("WRENCH_PROJECT_NAME", "")
SUBDOMAIN = os.environ.get("WRENCH_SUBDOMAIN", "")
ROOT_DOMAIN = os.environ.get("WRENCH_ROOT_DOMAIN", "")
REGISTRY_BUCKET = os.environ.get("WRENCH_REGISTRY_BUCKET", "")
S3_VERSION_PREFIX = "versions/"
THREADS = 8

SEMVER_STRICT_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def _validate_semver(version: str):
    if not isinstance(version, str) or not SEMVER_STRICT_RE.match(version):
        raise ValueError(f"Version '{version}' is not valid strict SemVer (X.Y.Z).")


def _run_build(build_cmd: str, cwd: str | None = None, env: dict | None = None):
    logger.info("Running: %s", build_cmd)
    build_env = os.environ.copy()
    if env:
        build_env.update(env)
    proc = subprocess.run(build_cmd, shell=True, cwd=cwd, env=build_env)
    if proc.returncode != 0:
        raise RuntimeError(f"Build command failed with exit code {proc.returncode}")


def _guess_content_type(path: str) -> str:
    if path.endswith(".wasm"):
        return "application/wasm"
    content_type, _ = mimetypes.guess_type(path)
    return content_type or "binary/octet-stream"


def _s3_list_prefix(client, bucket: str, prefix: str) -> List[Dict]:
    paginator = client.get_paginator("list_objects_v2")
    objs = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            objs.append(o)
    return objs


def _delete_prefix(client, bucket: str, prefix: str) -> int:
    logger.info("Deleting all objects under s3://%s/%s", bucket, prefix)
    paginator = client.get_paginator("list_objects_v2")
    total_deleted = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        contents = page.get("Contents", [])
        if not contents:
            continue
        keys = [{"Key": obj["Key"]} for obj in contents]
        for i in range(0, len(keys), 1000):
            chunk = keys[i : i + 1000]
            resp = client.delete_objects(Bucket=bucket, Delete={"Objects": chunk})
            total_deleted += len(resp.get("Deleted", []))
    logger.info("Deleted %d objects under prefix %s", total_deleted, prefix)
    return total_deleted


def _require_config():
    if not BUCKET:
        raise RuntimeError(
            "WRENCH_S3_BUCKET env var is not set.\n"
            "Use 'wrench deploy' which sets it automatically from terraform output,\n"
            "or run manually in infra/:\n"
            "  export WRENCH_S3_BUCKET=$(terraform output -raw bucket_name)\n"
            "  export WRENCH_CF_DISTRIBUTION=$(terraform output -raw cloudfront_distribution_id)"
        )


def _project_root() -> str:
    root = os.environ.get("WRENCH_PROJECT_ROOT")
    return os.path.abspath(root) if root else os.getcwd()


# ---------------------------
# Public API
# ---------------------------

def get_version() -> str:
    """Read current version from version.json -> 'X.Y.Z'."""
    path = os.path.join(_project_root(), "version.json")
    with open(path) as f:
        v = json.load(f)
    return f"{v['major']}.{v['minor']}.{v['patch']}"


def build_local(clean: bool = False) -> None:
    """Build the Vite frontend locally. Does not upload anything."""
    root = _project_root()

    if clean:
        dist = os.path.join(root, "dist")
        if os.path.exists(dist):
            logger.info("Removing dist/")
            shutil.rmtree(dist)

    logger.info("Building frontend...")
    _run_build("npm run build", cwd=root)

    dist_index = os.path.join(root, "dist", "index.html")
    if not os.path.exists(dist_index):
        raise FileNotFoundError("Frontend build failed: dist/index.html not found")

    logger.info("Build complete -> dist/")


def build_and_upload(
    version: Optional[str] = None,
    clean: bool = True,
    _build: bool = True,
    force: bool = False,
) -> str:
    """
    Upload dist/ to S3 under versions/<version>/.

    Args:
        version: SemVer string. If None, reads from version.json.
        clean:   Wipe dist/ before building (only used when _build=True).
        _build:  Run build_local first. Pass False when the caller already built.
        force:   Replace the version prefix if it already exists. Without this,
                 an existing version prefix aborts the upload.

    Returns the version string that was uploaded.
    """
    _require_config()

    if version is None:
        version = get_version()
    _validate_semver(version)

    root = _project_root()
    build_dir = os.path.join(root, "dist")

    if _build:
        build_local(clean=clean)

    logger.info("=" * 60)
    logger.info("UPLOADING v%s", version)
    logger.info("=" * 60)

    s3_client = boto3.client("s3", region_name=AWS_REGION)
    target_prefix = f"{S3_VERSION_PREFIX}{version}/"

    existing = _s3_list_prefix(s3_client, BUCKET, target_prefix)
    if existing:
        logger.info("Version %s already exists with %d objects.", version, len(existing))
        if not force:
            raise RuntimeError(
                f"Aborting: s3://{BUCKET}/{target_prefix} already exists. "
                f"Bump the version, or pass --force to replace it."
            )
        _delete_prefix(s3_client, BUCKET, target_prefix)

    files = []
    for root_dir, _, filenames in os.walk(build_dir):
        for fname in filenames:
            full = os.path.join(root_dir, fname)
            rel = os.path.relpath(full, build_dir).replace(os.sep, "/")
            files.append((full, f"{target_prefix}{rel}"))

    if not files:
        raise RuntimeError("No files found in dist/ to upload.")

    total = len(files)
    logger.info("Uploading %d files to s3://%s/%s", total, BUCKET, target_prefix)

    counter = {"done": 0}
    lock = threading.Lock()

    def _upload(file_and_key):
        fullpath, key = file_and_key
        content_type = _guess_content_type(fullpath)
        if os.path.basename(fullpath).lower() == "index.html":
            cache_control = "no-cache, max-age=0, must-revalidate"
        else:
            cache_control = "public, max-age=31536000, immutable"
        try:
            s3_client.upload_file(
                Filename=fullpath,
                Bucket=BUCKET,
                Key=key,
                ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
            )
        except ClientError as e:
            logger.error("Failed to upload %s -> %s: %s", fullpath, key, e)
            raise
        with lock:
            counter["done"] += 1
            logger.info("Uploaded %d/%d: %s", counter["done"], total, key)

    with ThreadPoolExecutor(max_workers=THREADS) as exe:
        futures = [exe.submit(_upload, fk) for fk in files]
        for f in as_completed(futures):
            exc = f.exception()
            if exc:
                raise exc

    logger.info("Upload complete: s3://%s/%s", BUCKET, target_prefix)
    return version


def list_versions() -> List[str]:
    """List all deployed versions in S3."""
    _require_config()
    s3_client = boto3.client("s3", region_name=AWS_REGION)
    paginator = s3_client.get_paginator("list_objects_v2")
    versions = set()
    for page in paginator.paginate(Bucket=BUCKET, Prefix=S3_VERSION_PREFIX, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            remainder = cp.get("Prefix", "")[len(S3_VERSION_PREFIX):].rstrip("/")
            if remainder:
                versions.add(remainder)
    sorted_versions = sorted(list(versions), reverse=True)
    logger.info("Found %d version(s): %s", len(sorted_versions), sorted_versions)
    return sorted_versions


def promote_version(version: str) -> Dict:
    """
    Promote a version by writing an iframe wrapper at the S3 root index.html
    and invalidating CloudFront so it takes effect immediately.

    Args:
        version: The SemVer string to promote (must already be uploaded).
    """
    _require_config()
    _validate_semver(version)

    s3_client = boto3.client("s3", region_name=AWS_REGION)
    version_prefix = f"{S3_VERSION_PREFIX}{version}/"

    objs = _s3_list_prefix(s3_client, BUCKET, version_prefix)
    if not objs:
        raise RuntimeError(f"Version '{version}' not found in s3://{BUCKET}/{version_prefix}")

    logger.info("Promoting v%s (%d objects)", version, len(objs))

    version_url = f"/{version_prefix}index.html"
    redirect_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>{DISPLAY_NAME}</title>
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
            border-top-color: {ACCENT_COLOR};
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
            <p>{version}</p>
        </div>
    </div>
    <iframe id="game-frame" src="{version_url}" allow="autoplay; fullscreen"></iframe>
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

    try:
        s3_client.put_object(
            Bucket=BUCKET,
            Key="index.html",
            Body=redirect_html.encode("utf-8"),
            ContentType="text/html",
            CacheControl="no-cache, no-store, must-revalidate, max-age=0",
            Metadata={
                "redirects-to-version": version,
                "promoted-at": datetime.datetime.now(datetime.UTC).isoformat(),
            },
        )
        logger.info("Uploaded root index.html -> v%s", version)
    except ClientError as e:
        logger.error("Failed to upload root index.html: %s", e)
        raise

    # Mirror the promoted version's favicon to the bucket root (unversioned)
    # so "https://<site>/favicon.svg" always resolves — bucket root otherwise
    # only ever holds this iframe-wrapper index.html, not any real assets.
    try:
        s3_client.copy_object(
            Bucket=BUCKET,
            Key="favicon.svg",
            CopySource={"Bucket": BUCKET, "Key": f"{version_prefix}favicon.svg"},
            ContentType="image/svg+xml",
            MetadataDirective="REPLACE",
        )
        logger.info("Mirrored favicon.svg from v%s to bucket root", version)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            logger.info("No favicon.svg in v%s; skipping root mirror", version)
        else:
            raise

    invalidation_id = None
    if CLOUDFRONT_ID:
        cf = boto3.client("cloudfront", region_name=AWS_REGION)
        caller_ref = (
            f"promote-{version}-"
            f"{datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')}-"
            f"{hashlib.sha1(version.encode()).hexdigest()[:6]}"
        )
        try:
            resp = cf.create_invalidation(
                DistributionId=CLOUDFRONT_ID,
                InvalidationBatch={
                    "Paths": {"Quantity": 2, "Items": ["/index.html", "/favicon.svg"]},
                    "CallerReference": caller_ref,
                },
            )
            invalidation_id = resp.get("Invalidation", {}).get("Id")
            logger.info("CloudFront invalidation created: %s", invalidation_id)
        except ClientError as e:
            logger.error("CloudFront invalidation failed: %s", e)
            raise

    upsert_registry_entry(version)

    return {
        "status": "promoted",
        "bucket": BUCKET,
        "version": version,
        "version_url": version_url,
        "cloudfront_invalidation_id": invalidation_id,
    }


def _site_url() -> str:
    fqdn = ROOT_DOMAIN if SUBDOMAIN == "" else f"{SUBDOMAIN}.{ROOT_DOMAIN}"
    return f"https://{fqdn}/"


def upsert_registry_entry(version: str) -> None:
    """
    Upsert this site's entry into the shared manifest.json that the landing
    page reads. No-op (with a log line) if the registry bucket or subdomain
    aren't configured — keeps this safe to call for sites not yet migrated
    to custom domains, and for the registry bucket's own bootstrap deploy
    before WRENCH_REGISTRY_BUCKET is known.

    This is a read-modify-write against a single S3 object; concurrent
    promotes across sites can race and clobber each other's update. Accepted
    for a single-operator deploy pipeline — not worth a locking scheme.
    """
    if not REGISTRY_BUCKET or not PROJECT_NAME:
        logger.info("Registry bucket/project name not configured; skipping manifest update.")
        return

    registry_client = boto3.client("s3", region_name=AWS_REGION)

    try:
        resp = registry_client.get_object(Bucket=REGISTRY_BUCKET, Key="manifest.json")
        manifest = json.loads(resp["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            manifest = {"sites": {}}
        else:
            raise

    site_url = _site_url()
    manifest.setdefault("sites", {})[PROJECT_NAME] = {
        "name": PROJECT_NAME,
        "displayName": DISPLAY_NAME,
        "accentColor": ACCENT_COLOR,
        "subdomain": SUBDOMAIN,
        "url": site_url,
        "faviconUrl": f"{site_url}favicon.svg",
        "version": version,
        "versions": list_versions(),
        "promotedAt": datetime.datetime.now(datetime.UTC).isoformat(),
    }

    registry_client.put_object(
        Bucket=REGISTRY_BUCKET,
        Key="manifest.json",
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-cache, max-age=0, must-revalidate",
    )
    logger.info("Updated manifest.json in registry bucket %s for site '%s'", REGISTRY_BUCKET, PROJECT_NAME)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="wrench build and deploy tool")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="Build frontend locally")
    p_build.add_argument("--clean", action="store_true", help="Wipe dist/ before building")

    p_deploy = sub.add_parser("deploy", help="Build + upload to S3 + promote (full pipeline)")
    p_deploy.add_argument("--clean", action="store_true", help="Wipe dist/ before building")
    p_deploy.add_argument("--version", default=None, help="Override version (default: version.json)")
    p_deploy.add_argument("--force", action="store_true", help="Replace the version prefix if it already exists")

    p_upload = sub.add_parser("upload", help="Upload existing dist/ to S3")
    p_upload.add_argument("--version", default=None, help="Override version (default: version.json)")
    p_upload.add_argument("--force", action="store_true", help="Replace the version prefix if it already exists")

    p_promote = sub.add_parser("promote", help="Promote a version (update root index.html + CloudFront)")
    p_promote.add_argument("--version", default=None, help="Version to promote (default: version.json)")

    sub.add_parser("list", help="List all deployed versions in S3")

    args = parser.parse_args()
    _add_file_log()

    try:
        if args.cmd == "build":
            build_local(clean=args.clean)

        elif args.cmd == "deploy":
            v = args.version or get_version()
            build_local(clean=args.clean)
            build_and_upload(version=v, _build=False, force=args.force)
            promote_version(v)

        elif args.cmd == "upload":
            build_and_upload(version=args.version, _build=False, force=args.force)

        elif args.cmd == "promote":
            promote_version(args.version or get_version())

        elif args.cmd == "list":
            versions = list_versions()
            print("\n".join(versions) if versions else "(no versions deployed)")
    except NoCredentialsError:
        sys.exit("No AWS credentials found — configure them: aws configure")
    except Exception as e:
        sys.exit(str(e))
