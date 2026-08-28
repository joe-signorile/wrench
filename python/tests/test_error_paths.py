"""Errors that are neither expected nor recoverable must propagate, not be
swallowed by the not-found branches that sit next to them."""
import os
import subprocess
import sys
from unittest import mock

from botocore.exceptions import ClientError

from .support import AwsTestCase, BUCKET, REGISTRY, build_tools

BUILD_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build_tools.py")


def error(code, op):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class TestErrorPropagation(AwsTestCase):
    def patch_s3(self, method, side_effect):
        real = build_tools.boto3.client

        def factory(service, **kwargs):
            client = real(service, **kwargs)
            if service == "s3":
                setattr(client, method, side_effect)
            return client

        return mock.patch.object(build_tools.boto3, "client", factory)

    def test_a_permissions_error_reading_a_version_is_not_read_as_missing(self):
        def denied(**kw):
            raise error("AccessDenied", "HeadObject")

        with self.patch_s3("head_object", denied):
            with self.assertRaises(ClientError):
                build_tools.promote_version(self.cfg, "1.2.3")

    def test_a_favicon_mirror_failure_that_is_not_a_missing_key_aborts_the_promote(self):
        self.put("versions/1.2.3/index.html", "<html>")

        def denied(**kw):
            raise error("AccessDenied", "CopyObject")

        with self.patch_s3("copy_object", denied):
            with self.assertRaises(ClientError):
                build_tools.promote_version(self.cfg, "1.2.3")

    def test_a_permissions_error_reading_the_manifest_is_not_read_as_missing(self):
        # Treating it as missing would replace the whole shared manifest with a
        # single-site one.
        def denied(**kw):
            raise error("AccessDenied", "GetObject")

        with self.patch_s3("get_object", denied):
            with self.assertRaises(ClientError):
                build_tools.upsert_registry_entry(self.cfg, "1.2.3")

    def test_delete_prefix_tolerates_an_empty_listing_page(self):
        client = mock.MagicMock()
        client.get_paginator.return_value.paginate.return_value = [{}, {"Contents": []}]
        self.assertEqual(build_tools._delete_prefix(client, BUCKET, "versions/1.0.0/"), 0)
        client.delete_objects.assert_not_called()


class TestCommandLineErrorHandling(AwsTestCase):
    """The __main__ wrapper: a one-line message by default, a traceback under
    WRENCH_DEBUG."""

    def invoke(self, extra_env=None):
        env = {
            **os.environ,
            "WRENCH_PROJECT_ROOT": self.root,
            "AWS_ACCESS_KEY_ID": "testing",
            "AWS_SECRET_ACCESS_KEY": "testing",
            "AWS_REGION": "us-west-1",
        }
        env.pop("WRENCH_S3_BUCKET", None)
        env.pop("WRENCH_CF_DISTRIBUTION", None)
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, BUILD_TOOLS, "list"],
            capture_output=True, text=True, env=env,
        )

    def test_a_missing_bucket_exits_non_zero_with_a_single_line(self):
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WRENCH_S3_BUCKET is not set", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_wrench_debug_produces_a_traceback(self):
        result = self.invoke({"WRENCH_DEBUG": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Traceback", result.stderr)

    def test_a_blank_distribution_id_is_refused_at_the_command_line(self):
        result = self.invoke({"WRENCH_S3_BUCKET": BUCKET, "WRENCH_CF_DISTRIBUTION": ""})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("WRENCH_CF_DISTRIBUTION", result.stderr)
