import unittest

from .support import build_tools, make_config


class TestWrenchConfig(unittest.TestCase):
    def test_valid_config_round_trips(self):
        cfg = make_config()
        self.assertEqual(cfg.bucket, "demo-client-abc123")
        self.assertEqual(cfg.subdomain, "app")

    def test_missing_bucket_is_refused_with_a_recovery_hint(self):
        with self.assertRaises(RuntimeError) as ctx:
            make_config(bucket="")
        self.assertIn("terraform output -raw bucket_name", str(ctx.exception))

    def test_missing_distribution_is_refused_rather_than_skipping_invalidation(self):
        # A blank distribution id used to silently skip invalidation, so the
        # deploy reported success while the CDN served the previous version.
        with self.assertRaises(RuntimeError) as ctx:
            make_config(cloudfront_id="")
        self.assertIn("stale", str(ctx.exception))

    def test_accent_color_must_be_a_hex_color(self):
        for good in ("#abc", "#AABBCC", "#aabbccdd"):
            self.assertEqual(make_config(accent_color=good).accent_color, good)
        for bad in ("red", "#ab", "#abcd", "#569cd6; } body { background: url(x)", "javascript:x", ""):
            with self.subTest(bad=bad), self.assertRaises((ValueError, RuntimeError)):
                make_config(accent_color=bad)

    def test_config_is_frozen(self):
        cfg = make_config()
        with self.assertRaises(Exception):
            cfg.bucket = "other"


class TestConfigFromEnv(unittest.TestCase):
    BASE = {
        "WRENCH_S3_BUCKET": "b",
        "WRENCH_CF_DISTRIBUTION": "E1",
        "WRENCH_PROJECT_ROOT": "/p",
    }

    def test_reads_every_variable(self):
        cfg = build_tools.config_from_env({
            **self.BASE,
            "AWS_REGION": "eu-west-1",
            "WRENCH_DISPLAY_NAME": "Demo",
            "WRENCH_ACCENT_COLOR": "#123456",
            "WRENCH_PROJECT_NAME": "demo",
            "WRENCH_SUBDOMAIN": "app",
            "WRENCH_ROOT_DOMAIN": "example.com",
            "WRENCH_REGISTRY_BUCKET": "reg",
        })
        self.assertEqual(cfg.region, "eu-west-1")
        self.assertEqual(cfg.display_name, "Demo")
        self.assertEqual(cfg.accent_color, "#123456")
        self.assertEqual(cfg.project_name, "demo")
        self.assertEqual(cfg.subdomain, "app")
        self.assertEqual(cfg.root_domain, "example.com")
        self.assertEqual(cfg.registry_bucket, "reg")

    def test_defaults_apply_when_optional_vars_are_absent(self):
        cfg = build_tools.config_from_env(self.BASE)
        self.assertEqual(cfg.region, "us-west-1")
        self.assertEqual(cfg.display_name, "App")
        self.assertEqual(cfg.accent_color, "#569cd6")
        self.assertEqual(cfg.project_name, "")
        self.assertEqual(cfg.root_domain, "")
        self.assertEqual(cfg.registry_bucket, "")

    def test_absent_subdomain_is_none_but_empty_subdomain_is_the_apex(self):
        # The distinction the env boundary used to destroy.
        self.assertIsNone(build_tools.config_from_env(self.BASE).subdomain)
        self.assertEqual(
            build_tools.config_from_env({**self.BASE, "WRENCH_SUBDOMAIN": ""}).subdomain, ""
        )

    def test_project_root_falls_back_to_cwd_and_is_absolutised(self):
        env = {k: v for k, v in self.BASE.items() if k != "WRENCH_PROJECT_ROOT"}
        import os
        self.assertEqual(build_tools.config_from_env(env).project_root, os.getcwd())
        self.assertTrue(
            os.path.isabs(build_tools.config_from_env({**self.BASE, "WRENCH_PROJECT_ROOT": "."}).project_root)
        )

    def test_blank_accent_color_env_falls_back_to_the_default(self):
        cfg = build_tools.config_from_env({**self.BASE, "WRENCH_ACCENT_COLOR": ""})
        self.assertEqual(cfg.accent_color, "#569cd6")


class TestSiteUrl(unittest.TestCase):
    def test_subdomain_site(self):
        self.assertEqual(build_tools.site_url(make_config(subdomain="app")), "https://app.example.com/")

    def test_empty_subdomain_is_the_apex(self):
        self.assertEqual(build_tools.site_url(make_config(subdomain="")), "https://example.com/")

    def test_absent_subdomain_has_no_url_at_all(self):
        # Not "https://example.com/" — that is the apex site's URL, not this one's.
        with self.assertRaises(ValueError):
            build_tools.site_url(make_config(subdomain=None))

    def test_a_blank_root_domain_raises_instead_of_producing_https_slash_slash_slash(self):
        with self.assertRaises(ValueError):
            build_tools.site_url(make_config(subdomain="", root_domain=""))


class TestHelpers(unittest.TestCase):
    def test_validate_semver_accepts_strict_versions(self):
        for good in ("0.0.0", "1.2.3", "10.20.30", "0.0.100"):
            self.assertEqual(build_tools._validate_semver(good), good)

    def test_validate_semver_rejects_everything_else(self):
        for bad in ("1.2", "1.2.3.4", "01.2.3", "1.02.3", "v1.2.3", "1.2.3-rc1",
                    "1.2.3+build", "", " 1.2.3", "../etc", None, 123):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_tools._validate_semver(bad)

    def test_version_prefix_is_validated(self):
        self.assertEqual(build_tools._version_prefix("1.2.3"), "versions/1.2.3/")
        with self.assertRaises(ValueError):
            build_tools._version_prefix("../../etc/passwd")

    def test_content_types_cover_the_web_assets_a_vite_build_emits(self):
        cases = {
            "app.js": "text/javascript",
            "app.mjs": "text/javascript",
            "app.css": "text/css",
            "engine.wasm": "application/wasm",
            "data.json": "application/json",
            "favicon.svg": "image/svg+xml",
            "site.webmanifest": "application/manifest+json",
            "index.html": "text/html",
            "font.woff2": "font/woff2",
            "shot.webp": "image/webp",
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(build_tools._guess_content_type(name), expected)

    def test_unknown_extensions_fall_back_to_octet_stream(self):
        self.assertEqual(build_tools._guess_content_type("thing.unknownext"), "binary/octet-stream")

    def test_only_index_html_is_uncached(self):
        self.assertIn("no-cache", build_tools._cache_control("dist/index.html"))
        self.assertIn("no-cache", build_tools._cache_control("dist/nested/INDEX.HTML"))
        self.assertIn("immutable", build_tools._cache_control("dist/assets/app-a1b2.js"))
        self.assertIn("immutable", build_tools._cache_control("dist/other.html"))
