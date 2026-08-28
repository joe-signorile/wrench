from unittest import mock

from botocore.exceptions import ClientError

from .support import AwsTestCase, BUCKET, build_tools


class TestUpload(AwsTestCase):
    def test_uploads_every_file_under_the_version_prefix(self):
        self.write_dist(**{"index.html": "<html>", "assets|app-a1b2.js": "1", "assets|nested|x.css": "2"})
        build_tools.build_and_upload(self.cfg, "1.2.3")
        self.assertEqual(self.keys("versions/1.2.3/"), [
            "versions/1.2.3/assets/app-a1b2.js",
            "versions/1.2.3/assets/nested/x.css",
            "versions/1.2.3/index.html",
        ])

    def test_returns_the_version_it_uploaded(self):
        self.write_dist(**{"index.html": "<html>"})
        self.assertEqual(build_tools.build_and_upload(self.cfg, "1.2.3"), "1.2.3")

    def test_index_html_is_uncached_and_hashed_assets_are_immutable(self):
        self.write_dist(**{"index.html": "<html>", "assets|app-a1b2.js": "1"})
        build_tools.build_and_upload(self.cfg, "1.2.3")

        index = self.s3.head_object(Bucket=BUCKET, Key="versions/1.2.3/index.html")
        self.assertIn("no-cache", index["CacheControl"])
        self.assertEqual(index["ContentType"], "text/html")

        asset = self.s3.head_object(Bucket=BUCKET, Key="versions/1.2.3/assets/app-a1b2.js")
        self.assertIn("immutable", asset["CacheControl"])
        self.assertEqual(asset["ContentType"], "text/javascript")

    def test_an_existing_version_aborts_without_force(self):
        self.put("versions/1.2.3/index.html")
        self.write_dist(**{"index.html": "new"})
        with self.assertRaises(RuntimeError) as ctx:
            build_tools.build_and_upload(self.cfg, "1.2.3")
        self.assertIn("--force", str(ctx.exception))
        self.assertEqual(
            self.s3.get_object(Bucket=BUCKET, Key="versions/1.2.3/index.html")["Body"].read(), b"x"
        )

    def test_force_replaces_the_prefix_leaving_no_stale_files(self):
        self.put("versions/1.2.3/index.html", "old")
        self.put("versions/1.2.3/assets/gone.js", "old")
        self.write_dist(**{"index.html": "new"})

        build_tools.build_and_upload(self.cfg, "1.2.3", force=True)

        self.assertEqual(self.keys("versions/1.2.3/"), ["versions/1.2.3/index.html"])
        self.assertEqual(
            self.s3.get_object(Bucket=BUCKET, Key="versions/1.2.3/index.html")["Body"].read(), b"new"
        )

    def test_force_does_not_touch_other_versions(self):
        self.put("versions/1.2.2/index.html", "keep")
        self.put("versions/1.2.3/index.html", "old")
        self.write_dist(**{"index.html": "new"})
        build_tools.build_and_upload(self.cfg, "1.2.3", force=True)
        self.assertEqual(
            self.s3.get_object(Bucket=BUCKET, Key="versions/1.2.2/index.html")["Body"].read(), b"keep"
        )

    def test_an_empty_dist_is_refused(self):
        with self.assertRaises(RuntimeError) as ctx:
            build_tools.build_and_upload(self.cfg, "1.2.3")
        self.assertIn("No files found", str(ctx.exception))

    def test_a_dist_without_index_html_is_refused_before_anything_is_uploaded(self):
        self.write_dist(**{"assets|app.js": "1"})
        with self.assertRaises(RuntimeError) as ctx:
            build_tools.build_and_upload(self.cfg, "1.2.3")
        self.assertIn("no index.html", str(ctx.exception))
        self.assertEqual(self.keys("versions/"), [])

    def test_an_invalid_version_is_refused(self):
        self.write_dist(**{"index.html": "<html>"})
        with self.assertRaises(ValueError):
            build_tools.build_and_upload(self.cfg, "1.2")
        self.assertEqual(self.keys("versions/"), [])

    def test_a_failed_upload_leaves_no_partial_prefix_behind(self):
        # Otherwise the retry hits "already exists" and pushes you to --force.
        self.write_dist(**{"index.html": "<html>", "a.js": "1", "b.js": "2", "c.js": "3"})
        real = build_tools.boto3.client

        def flaky_client(service, **kwargs):
            client = real(service, **kwargs)
            if service != "s3":
                return client
            original = client.upload_file
            calls = {"n": 0}

            def upload_file(**kw):
                calls["n"] += 1
                if calls["n"] == 3:
                    raise RuntimeError("network went away")
                return original(**kw)

            client.upload_file = upload_file
            return client

        with mock.patch.object(build_tools.boto3, "client", flaky_client):
            with self.assertRaises(RuntimeError):
                build_tools.build_and_upload(self.cfg, "1.2.3")

        self.assertEqual(self.keys("versions/1.2.3/"), [], "partial upload should have been cleaned up")


class TestDeletePrefix(AwsTestCase):
    def test_deletes_only_the_named_version(self):
        self.put("versions/1.0.0/a")
        self.put("versions/2.0.0/a")
        build_tools._delete_prefix(self.s3, BUCKET, "versions/1.0.0/")
        self.assertEqual(self.keys(), ["versions/2.0.0/a"])

    def test_refuses_a_prefix_that_would_wipe_every_version(self):
        # The guard lives next to the irreversible operation, not at the caller.
        for bad in ("", "/", "versions/", "versions", "*", "index.html"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_tools._delete_prefix(self.s3, BUCKET, bad)

    def test_refuses_a_non_semver_version_segment(self):
        with self.assertRaises(ValueError):
            build_tools._delete_prefix(self.s3, BUCKET, "versions/../")

    def test_paginates_past_a_thousand_keys(self):
        for i in range(1005):
            self.put(f"versions/1.0.0/f{i:04d}")
        self.assertEqual(build_tools._delete_prefix(self.s3, BUCKET, "versions/1.0.0/"), 1005)
        self.assertEqual(self.keys(), [])

    def test_reported_per_key_failures_raise_instead_of_being_discarded(self):
        # delete_objects returns Errors and does NOT raise; ignoring them left
        # stale files inside a --force-replaced version prefix.
        self.put("versions/1.0.0/a")
        client = mock.MagicMock()
        client.get_paginator.return_value.paginate.return_value = [
            {"Contents": [{"Key": "versions/1.0.0/a"}]}
        ]
        client.delete_objects.return_value = {
            "Deleted": [], "Errors": [{"Key": "versions/1.0.0/a", "Message": "AccessDenied"}],
        }
        with self.assertRaises(RuntimeError) as ctx:
            build_tools._delete_prefix(client, BUCKET, "versions/1.0.0/")
        self.assertIn("AccessDenied", str(ctx.exception))


class TestListVersions(AwsTestCase):
    def test_lists_versions_newest_first(self):
        for v in ("0.0.9", "0.0.10", "1.0.0", "0.2.0"):
            self.put(f"versions/{v}/index.html")
        self.assertEqual(build_tools.list_versions(self.cfg), ["1.0.0", "0.2.0", "0.0.10", "0.0.9"])

    def test_sorts_numerically_not_lexically(self):
        for v in ("0.0.2", "0.0.11"):
            self.put(f"versions/{v}/index.html")
        self.assertEqual(build_tools.list_versions(self.cfg), ["0.0.11", "0.0.2"])

    def test_an_empty_bucket_lists_nothing(self):
        self.assertEqual(build_tools.list_versions(self.cfg), [])

    def test_ignores_objects_outside_the_versions_prefix(self):
        self.put("index.html")
        self.put("favicon.svg")
        self.put("versions/1.0.0/index.html")
        self.assertEqual(build_tools.list_versions(self.cfg), ["1.0.0"])

    def test_paginates_past_a_page_of_prefixes(self):
        for i in range(1200):
            self.put(f"versions/0.0.{i}/index.html")
        self.assertEqual(len(build_tools.list_versions(self.cfg)), 1200)
