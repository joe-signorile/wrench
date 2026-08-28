import json
from unittest import mock

from botocore.exceptions import ClientError

from .support import AwsTestCase, REGISTRY, build_tools, make_config


class TestRegistry(AwsTestCase):
    def cfg_with(self, **overrides):
        return make_config(project_root=self.root, cloudfront_id=self.distribution_id, **overrides)

    def manifest(self):
        obj = self.s3.get_object(Bucket=REGISTRY, Key="manifest.json")
        return json.loads(obj["Body"].read())

    def test_creates_the_manifest_when_none_exists(self):
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.3")
        entry = self.manifest()["sites"]["demo"]
        self.assertEqual(entry["url"], "https://app.example.com/")
        self.assertEqual(entry["faviconUrl"], "https://app.example.com/favicon.svg")
        self.assertEqual(entry["version"], "1.2.3")
        self.assertEqual(entry["displayName"], "Demo")
        self.assertEqual(entry["subdomain"], "app")
        self.assertIn("promotedAt", entry)

    def test_the_manifest_is_served_uncached_as_json(self):
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.3")
        obj = self.s3.head_object(Bucket=REGISTRY, Key="manifest.json")
        self.assertEqual(obj["ContentType"], "application/json")
        self.assertIn("no-cache", obj["CacheControl"])

    def test_updates_this_site_without_disturbing_the_others(self):
        self.s3.put_object(
            Bucket=REGISTRY, Key="manifest.json",
            Body=json.dumps({"sites": {"other": {"name": "other", "version": "9.9.9"}}}).encode(),
        )
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.3")
        sites = self.manifest()["sites"]
        self.assertEqual(sites["other"]["version"], "9.9.9")
        self.assertEqual(sites["demo"]["version"], "1.2.3")

    def test_an_existing_entry_is_replaced_not_merged(self):
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.3")
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.4")
        self.assertEqual(self.manifest()["sites"]["demo"]["version"], "1.2.4")

    def test_the_deployed_version_list_is_included(self):
        for v in ("1.2.3", "1.2.4"):
            self.put(f"versions/{v}/index.html")
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.4")
        self.assertEqual(self.manifest()["sites"]["demo"]["versions"], ["1.2.4", "1.2.3"])

    def test_an_apex_site_gets_the_root_domain(self):
        build_tools.upsert_registry_entry(self.cfg_with(subdomain=""), "1.2.3")
        self.assertEqual(self.manifest()["sites"]["demo"]["url"], "https://example.com/")

    def test_a_site_with_no_subdomain_is_skipped_rather_than_claiming_the_apex(self):
        # The bug this guards: null and "" both became "", so an unmigrated site
        # published https://<rootDomain>/ as its own URL.
        build_tools.upsert_registry_entry(self.cfg_with(subdomain=None), "1.2.3")
        with self.assertRaises(self.s3.exceptions.NoSuchKey):
            self.s3.get_object(Bucket=REGISTRY, Key="manifest.json")

    def test_skipped_when_the_registry_bucket_is_unconfigured(self):
        build_tools.upsert_registry_entry(self.cfg_with(registry_bucket=""), "1.2.3")
        with self.assertRaises(self.s3.exceptions.NoSuchKey):
            self.s3.get_object(Bucket=REGISTRY, Key="manifest.json")

    def test_skipped_when_the_project_has_no_name(self):
        build_tools.upsert_registry_entry(self.cfg_with(project_name=""), "1.2.3")
        with self.assertRaises(self.s3.exceptions.NoSuchKey):
            self.s3.get_object(Bucket=REGISTRY, Key="manifest.json")

    def test_a_corrupt_manifest_is_replaced_rather_than_crashing_the_deploy(self):
        self.s3.put_object(Bucket=REGISTRY, Key="manifest.json", Body=b'["not", "an", "object"]')
        build_tools.upsert_registry_entry(self.cfg_with(), "1.2.3")
        self.assertIn("demo", self.manifest()["sites"])

    def test_promote_updates_the_registry_end_to_end(self):
        self.put("versions/1.2.3/index.html", "<html>")
        build_tools.promote_version(self.cfg_with(), "1.2.3")
        self.assertEqual(self.manifest()["sites"]["demo"]["version"], "1.2.3")


class TestRegistryConcurrency(AwsTestCase):
    """The manifest is a single object shared by every site, so the
    read-modify-write is guarded with a conditional put."""

    def config(self):
        return make_config(project_root=self.root, cloudfront_id=self.distribution_id)

    @staticmethod
    def precondition_failed():
        return ClientError(
            {"Error": {"Code": "PreconditionFailed", "Message": "At least one of the pre-conditions failed"}},
            "PutObject",
        )

    def patched_client(self, put_side_effect):
        real = build_tools.boto3.client

        def factory(service, **kwargs):
            client = real(service, **kwargs)
            if service == "s3":
                original = client.put_object
                client.put_object = lambda **kw: put_side_effect(original, kw)
            return client

        return mock.patch.object(build_tools.boto3, "client", factory)

    def test_a_creating_write_is_conditional_on_the_object_not_existing(self):
        seen = {}

        def capture(original, kw):
            seen.update(kw)
            return original(**kw)

        with self.patched_client(capture):
            build_tools.upsert_registry_entry(self.config(), "1.2.3")
        self.assertEqual(seen.get("IfNoneMatch"), "*")

    def test_an_updating_write_is_conditional_on_the_etag_it_read(self):
        self.s3.put_object(Bucket=REGISTRY, Key="manifest.json", Body=b'{"sites":{}}')
        etag = self.s3.head_object(Bucket=REGISTRY, Key="manifest.json")["ETag"]
        seen = {}

        def capture(original, kw):
            seen.update(kw)
            return original(**{k: v for k, v in kw.items() if k != "IfMatch"})

        with self.patched_client(capture):
            build_tools.upsert_registry_entry(self.config(), "1.2.3")
        self.assertEqual(seen.get("IfMatch"), etag)

    def test_a_conflicting_write_is_retried_rather_than_clobbering(self):
        calls = {"n": 0}

        def conflict_once(original, kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise self.precondition_failed()
            return original(**{k: v for k, v in kw.items() if k not in ("IfMatch", "IfNoneMatch")})

        with self.patched_client(conflict_once):
            build_tools.upsert_registry_entry(self.config(), "1.2.3")

        self.assertEqual(calls["n"], 2)
        obj = self.s3.get_object(Bucket=REGISTRY, Key="manifest.json")
        self.assertIn("demo", json.loads(obj["Body"].read())["sites"])

    def test_persistent_conflicts_fail_loudly_instead_of_silently_losing_the_update(self):
        def always_conflict(original, kw):
            raise self.precondition_failed()

        with self.patched_client(always_conflict):
            with self.assertRaises(RuntimeError) as ctx:
                build_tools.upsert_registry_entry(self.config(), "1.2.3")
        self.assertIn("conflicting attempts", str(ctx.exception))

    def test_an_unrelated_put_error_is_not_swallowed_as_a_conflict(self):
        def access_denied(original, kw):
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "nope"}}, "PutObject")

        with self.patched_client(access_denied):
            with self.assertRaises(ClientError):
                build_tools.upsert_registry_entry(self.config(), "1.2.3")
