import contextlib
import io
import os
from unittest import mock

from .support import AwsTestCase, BUCKET, REGISTRY, build_tools


class TestMain(AwsTestCase):
    """Exercises the argparse entrypoint the Node CLI actually shells out to."""

    def run_main(self, argv):
        env = {
            "WRENCH_S3_BUCKET": BUCKET,
            "WRENCH_CF_DISTRIBUTION": self.distribution_id,
            "WRENCH_PROJECT_ROOT": self.root,
            "AWS_REGION": self.cfg.region,
            "WRENCH_PROJECT_NAME": "demo",
            "WRENCH_DISPLAY_NAME": "Demo",
            "WRENCH_SUBDOMAIN": "app",
            "WRENCH_ROOT_DOMAIN": "example.com",
            "WRENCH_REGISTRY_BUCKET": REGISTRY,
        }
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), \
                contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(io.StringIO()):
            code = build_tools.main(argv)
        return code, stdout.getvalue()

    def test_upload_then_promote_is_the_deploy_pipeline(self):
        self.write_dist(**{"index.html": "<html>", "assets|app.js": "1"})
        self.assertEqual(self.run_main(["upload", "--version", "1.2.3"])[0], 0)
        self.assertEqual(self.run_main(["promote", "--version", "1.2.3"])[0], 0)
        body = self.s3.get_object(Bucket=BUCKET, Key="index.html")["Body"].read().decode()
        self.assertIn("/versions/1.2.3/index.html", body)

    def test_list_prints_versions_newest_first(self):
        for v in ("0.0.9", "0.0.10"):
            self.put(f"versions/{v}/index.html")
        code, out = self.run_main(["list"])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip().splitlines(), ["0.0.10", "0.0.9"])

    def test_list_says_so_when_nothing_is_deployed(self):
        self.assertIn("(no versions deployed)", self.run_main(["list"])[1])

    def test_upload_requires_an_explicit_version(self):
        with self.assertRaises(SystemExit):
            self.run_main(["upload"])

    def test_promote_requires_an_explicit_version(self):
        with self.assertRaises(SystemExit):
            self.run_main(["promote"])

    def test_the_removed_build_and_deploy_subcommands_are_gone(self):
        # Building is the Node CLI's job; these paths were unreachable and
        # duplicated it.
        for cmd in ("build", "deploy"):
            with self.subTest(cmd=cmd), self.assertRaises(SystemExit):
                self.run_main([cmd])

    def test_the_build_log_is_written_outside_dist_so_it_is_never_published(self):
        # It used to land in dist/, which the upload walks — so every deploy
        # published local paths and the bucket name to the CDN.
        self.write_dist(**{"index.html": "<html>"})
        self.run_main(["upload", "--version", "1.2.3"])

        self.assertEqual(self.keys("versions/1.2.3/"), ["versions/1.2.3/index.html"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "dist", "build.log")))
        self.assertTrue(os.path.exists(os.path.join(self.root, ".wrench", "build.log")))

    def test_no_uploaded_key_ends_in_build_log(self):
        self.write_dist(**{"index.html": "<html>", "assets|app.js": "1"})
        self.run_main(["upload", "--version", "1.2.3"])
        self.assertFalse([k for k in self.keys() if k.endswith("build.log")])

    def test_list_does_not_create_directories_in_the_project(self):
        before = sorted(os.listdir(self.root))
        self.run_main(["list"])
        self.assertEqual(sorted(os.listdir(self.root)), before)
