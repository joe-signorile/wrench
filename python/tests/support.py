"""Shared fixtures for the build_tools tests."""
import logging
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

import build_tools  # noqa: E402

REGION = "us-west-1"
BUCKET = "demo-client-abc123"
REGISTRY = "landing-client-def456"
DISTRIBUTION = "E1EXAMPLE"


def make_config(**overrides) -> build_tools.WrenchConfig:
    base = dict(
        bucket=BUCKET,
        cloudfront_id=DISTRIBUTION,
        project_root="/tmp/does-not-matter",
        region=REGION,
        display_name="Demo",
        accent_color="#569cd6",
        project_name="demo",
        subdomain="app",
        root_domain="example.com",
        registry_bucket=REGISTRY,
    )
    base.update(overrides)
    return build_tools.WrenchConfig(**base)


class AwsTestCase(unittest.TestCase):
    """Boots moto with dummy credentials and a project root under a temp dir."""

    def setUp(self):
        # build_tools logs at INFO by design; keep it out of the test output.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        self._env = dict(os.environ)
        os.environ.update({
            "AWS_ACCESS_KEY_ID": "testing",
            "AWS_SECRET_ACCESS_KEY": "testing",
            "AWS_SECURITY_TOKEN": "testing",
            "AWS_SESSION_TOKEN": "testing",
            "AWS_DEFAULT_REGION": REGION,
        })
        self.mock = mock_aws()
        self.mock.start()

        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.dist = os.path.join(self.root, "dist")
        os.makedirs(self.dist)

        self.s3 = boto3.client("s3", region_name=REGION)
        for bucket in (BUCKET, REGISTRY):
            self.s3.create_bucket(
                Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION}
            )

        self.cf = boto3.client("cloudfront", region_name=REGION)
        self.distribution_id = self.cf.create_distribution(DistributionConfig={
            "CallerReference": "wrench-test",
            "Comment": "wrench test distribution",
            "Enabled": True,
            "Origins": {"Quantity": 1, "Items": [{
                "Id": "o1",
                "DomainName": f"{BUCKET}.s3.amazonaws.com",
                "S3OriginConfig": {"OriginAccessIdentity": ""},
            }]},
            "DefaultCacheBehavior": {"TargetOriginId": "o1", "ViewerProtocolPolicy": "redirect-to-https"},
        })["Distribution"]["Id"]

        self.cfg = make_config(project_root=self.root, cloudfront_id=self.distribution_id)

    def tearDown(self):
        self.mock.stop()
        self.tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._env)

    # -- helpers ----------------------------------------------------------

    def write_dist(self, **files):
        """write_dist(**{'index.html': '<html>'}) -> writes into dist/."""
        for rel, body in files.items():
            full = os.path.join(self.dist, rel.replace("|", os.sep))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(body)

    def keys(self, prefix=""):
        resp = self.s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
        return sorted(o["Key"] for o in resp.get("Contents", []))

    def put(self, key, body="x", bucket=BUCKET):
        self.s3.put_object(Bucket=bucket, Key=key, Body=body.encode())

    def invalidations(self):
        listed = self.cf.list_invalidations(DistributionId=self.distribution_id)
        items = listed.get("InvalidationList", {}).get("Items", [])
        return [self.cf.get_invalidation(DistributionId=self.distribution_id, Id=i["Id"])
                for i in items]
