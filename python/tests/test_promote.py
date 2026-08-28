import json

from .support import AwsTestCase, BUCKET, build_tools, make_config


class TestPromote(AwsTestCase):
    def promotable(self, version="1.2.3", favicon=True):
        self.put(f"versions/{version}/index.html", "<html>app</html>")
        self.put(f"versions/{version}/assets/app.js", "1")
        if favicon:
            self.put(f"versions/{version}/favicon.svg", "<svg/>")

    def root_index(self):
        obj = self.s3.get_object(Bucket=BUCKET, Key="index.html")
        return obj, obj["Body"].read().decode()

    def test_writes_an_iframe_wrapper_pointing_at_the_version(self):
        self.promotable()
        result = build_tools.promote_version(self.cfg, "1.2.3")
        _, body = self.root_index()
        self.assertIn('src="/versions/1.2.3/index.html"', body)
        self.assertEqual(result["status"], "promoted")
        self.assertEqual(result["version_url"], "/versions/1.2.3/index.html")

    def test_the_root_page_is_never_cached(self):
        self.promotable()
        build_tools.promote_version(self.cfg, "1.2.3")
        obj, _ = self.root_index()
        self.assertIn("no-store", obj["CacheControl"])
        self.assertEqual(obj["ContentType"], "text/html")

    def test_metadata_records_what_is_promoted_and_when(self):
        self.promotable()
        build_tools.promote_version(self.cfg, "1.2.3")
        obj, _ = self.root_index()
        self.assertEqual(obj["Metadata"]["redirects-to-version"], "1.2.3")
        self.assertIn("promoted-at", obj["Metadata"])

    def test_a_version_that_was_never_uploaded_is_refused(self):
        with self.assertRaises(RuntimeError) as ctx:
            build_tools.promote_version(self.cfg, "9.9.9")
        self.assertIn("no index.html", str(ctx.exception))

    def test_a_version_whose_upload_lost_its_index_html_is_refused(self):
        # A non-empty listing is not proof the version is servable.
        self.put("versions/1.2.3/assets/app.js", "1")
        with self.assertRaises(RuntimeError) as ctx:
            build_tools.promote_version(self.cfg, "1.2.3")
        self.assertIn("refusing to promote", str(ctx.exception))
        with self.assertRaises(self.s3.exceptions.NoSuchKey):
            self.s3.get_object(Bucket=BUCKET, Key="index.html")

    def test_an_invalid_version_is_refused(self):
        with self.assertRaises(ValueError):
            build_tools.promote_version(self.cfg, "1.2")

    def test_the_favicon_is_mirrored_to_the_bucket_root(self):
        self.promotable()
        build_tools.promote_version(self.cfg, "1.2.3")
        obj = self.s3.get_object(Bucket=BUCKET, Key="favicon.svg")
        self.assertEqual(obj["Body"].read(), b"<svg/>")
        self.assertEqual(obj["ContentType"], "image/svg+xml")

    def test_a_version_with_no_favicon_still_promotes(self):
        self.promotable(favicon=False)
        build_tools.promote_version(self.cfg, "1.2.3")
        _, body = self.root_index()
        self.assertIn("/versions/1.2.3/index.html", body)

    def test_invalidates_the_bare_root_as_well_as_index_html(self):
        # "/" is resolved via default_root_object; invalidating only the key is
        # not documented to cover it.
        self.promotable()
        result = build_tools.promote_version(self.cfg, "1.2.3")
        invalidations = self.invalidations()
        self.assertEqual(len(invalidations), 1)
        paths = invalidations[0]["Invalidation"]["InvalidationBatch"]["Paths"]
        self.assertEqual(sorted(paths["Items"]), ["/", "/favicon.svg", "/index.html"])
        self.assertEqual(paths["Quantity"], len(paths["Items"]))
        self.assertIsNotNone(result["cloudfront_invalidation_id"])

    def test_rollback_is_just_promoting_an_older_version(self):
        self.promotable("1.2.3")
        self.promotable("1.2.2")
        build_tools.promote_version(self.cfg, "1.2.3")
        build_tools.promote_version(self.cfg, "1.2.2")
        _, body = self.root_index()
        self.assertIn("/versions/1.2.2/index.html", body)


class TestPromotePageRendering(AwsTestCase):
    def render(self, **overrides):
        cfg = make_config(project_root=self.root, cloudfront_id=self.distribution_id, **overrides)
        return build_tools.render_promote_page(cfg, "1.2.3", "/versions/1.2.3/index.html")

    def test_the_display_name_is_shown_as_the_title(self):
        self.assertIn("<title>Demo</title>", self.render(display_name="Demo"))

    def test_a_display_name_cannot_break_out_of_the_title_element(self):
        # This page is served at the site root, so an unescaped display name
        # from package.json was script injection.
        html = self.render(display_name="</title><script>alert(1)</script>")
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;/title&gt;&lt;script&gt;", html)

    def test_html_metacharacters_in_a_display_name_are_escaped(self):
        html = self.render(display_name='Tom & "Jerry" <v2>')
        self.assertIn("Tom &amp; &quot;Jerry&quot; &lt;v2&gt;", html)
        self.assertNotIn("<v2>", html)

    def test_the_accent_color_reaches_the_stylesheet(self):
        self.assertIn("border-top-color: #ff0000;", self.render(accent_color="#ff0000"))

    def test_an_accent_color_cannot_carry_css(self):
        # Validation happens in WrenchConfig, which is what keeps the value out
        # of the stylesheet as an injection vector.
        with self.assertRaises(ValueError):
            self.render(accent_color="#fff; } body { background: url(https://evil/x)")

    def test_the_version_is_displayed_behind_the_spinner(self):
        self.assertIn("<p>1.2.3</p>", self.render())
