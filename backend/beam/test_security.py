"""Offline security boundary checks; stdlib only, no GPU or cloud API calls."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import security
import storage


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="security-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.assertTrue(self.root.is_relative_to(self.workspace))
        self.patches = [patch.object(storage, "ROOT", self.root), patch.object(security, "ROOT", self.root),
                        patch.dict(os.environ, {"BEAM_API_TOKEN": "offline-test-only-not-a-real-token"})]
        for item in self.patches:
            item.start()
        self.job_id = "a" * 32
        storage.job_path(self.job_id).mkdir(parents=True)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.assertTrue(self.root.resolve().is_relative_to(self.workspace))
        self.temporary.cleanup()

    def test_old_job_fails_closed(self):
        with self.assertRaises(security.AccessDenied):
            security.authorize(self.job_id, "x" * 43)
        with self.assertRaises(security.AccessDenied):
            security.get_urls(self.job_id, ["original.jpg"])

    def test_token_required_and_only_hash_is_stored(self):
        token = security.create_access(self.job_id)
        record = storage.read_json(storage.job_path(self.job_id) / "access.json")
        self.assertEqual(record["token_sha256"], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, str(record))
        security.authorize(self.job_id, token)
        for header in ("", "x" * 43, "Bearer " + token, "Basic " + token):
            with self.assertRaises(security.AccessDenied):
                security.authorize(self.job_id, header)

    def test_tokens_cannot_cross_jobs(self):
        token = security.create_access(self.job_id)
        other = "b" * 32
        storage.job_path(other).mkdir(parents=True)
        security.create_access(other)
        with self.assertRaises(security.AccessDenied):
            security.authorize(other, token)

    def test_signed_links_expire_and_cannot_be_tampered(self):
        security.create_access(self.job_id)
        (storage.job_path(self.job_id) / "original.jpg").write_bytes(b"test")
        (storage.job_path(self.job_id) / "access.json").is_file()
        urls = security.get_urls(self.job_id, ["original.jpg", "access.json", "../access.json"])
        self.assertEqual(list(urls), ["original.jpg"])
        args = parse_qs(urlparse(urls["original.jpg"]).query)
        expires, sig = args["expires"][0], args["sig"][0]
        security.authorize_file(self.job_id, "original.jpg", expires, sig)
        with self.assertRaises(security.AccessDenied):
            security.authorize_file(self.job_id, "original.jpg", expires, "0" * 64)
        with self.assertRaises(security.AccessDenied):
            security.authorize_file(self.job_id, "edit_" + "c" * 32 + ".jpg", expires, sig)
        with patch("security.time.time", return_value=int(expires) + 1):
            with self.assertRaises(security.AccessDenied):
                security.authorize_file(self.job_id, "original.jpg", expires, sig)

    def test_preview_assets_require_the_same_signed_access(self):
        security.create_access(self.job_id)
        name = "scene_" + self.job_id + ".splat"
        (storage.job_path(self.job_id) / name).write_bytes(b"test")
        urls = security.get_urls(self.job_id, [name])
        args = parse_qs(urlparse(urls[name]).query)
        security.authorize_file(self.job_id, name, args["expires"][0], args["sig"][0])
        with self.assertRaises(security.AccessDenied):
            security.authorize_file(self.job_id, name, "", "")

    def test_upload_rate_is_persistent_and_per_ip(self):
        self.assertTrue(all(security.allow_upload("192.0.2.1") for _ in range(3)))
        self.assertFalse(security.allow_upload("192.0.2.1"))
        self.assertTrue(security.allow_upload("192.0.2.2"))
        self.assertNotIn("192.0.2.1", (self.root / "limits" / "upload-ips.json").read_text())

    def test_missing_signing_secret_fails_closed(self):
        with patch.dict(os.environ, {"BEAM_API_TOKEN": ""}):
            with self.assertRaises(security.SigningUnavailable):
                security.signature(self.job_id, "original.jpg", 9999999999)


if __name__ == "__main__":
    unittest.main()
