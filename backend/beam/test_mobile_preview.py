"""Offline mobile preview/API authorization checks; no cloud or GPU calls."""
import ast
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import mobile_preview
import security
import storage


class MobileTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="mobile-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.patches = [patch.object(storage, "ROOT", self.root), patch.object(security, "ROOT", self.root),
                        patch.object(mobile_preview, "MAX_POINTS", 257),
                        patch.dict(os.environ, {"BEAM_API_TOKEN": "offline-test-only-not-an-account-key"})]
        for item in self.patches:
            item.start()
        self.job_id = "a" * 32
        self.directory = storage.job_path(self.job_id)
        self.directory.mkdir(parents=True)
        self.token = security.create_access(self.job_id)
        self.filename = "scene_" + self.job_id + ".splat"
        self.source = self.directory / self.filename
        self.raw = b"".join(struct.pack("<6f8B", index, 1, 2, .1, .2, .3, 20, 40, 60, 255, 255, 128, 128, 128) for index in range(8192 + 7))
        self.source.write_bytes(self.raw)
        self.ply = self.filename.removesuffix(".splat") + ".ply"
        (self.directory / self.ply).write_bytes(b"existing full preview; PLY need not be decoded")
        storage.write_state(self.job_id, "done", job_id=self.job_id, ply_file=self.ply, viewer_file=self.filename)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.assertTrue(self.root.is_relative_to(self.workspace))
        self.temporary.cleanup()

    def ensure(self):
        return mobile_preview.ensure_mobile_preview(self.directory, self.filename)

    def endpoint(self, name):
        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                self.status_code, self.detail = status_code, detail
        def private_job(job_id, token):
            try:
                security.authorize(job_id, token)
            except security.AccessDenied:
                raise HTTPException(403, "denied")
            return storage.job_path(job_id)
        module = ast.parse((self.workspace / "gateway.py").read_text(encoding="utf-8-sig"))
        create = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "create_app")
        function = next(node for node in create.body if isinstance(node, ast.FunctionDef) and node.name == name)
        function.decorator_list = []
        namespace = {"Header": lambda default="", **kwargs: default, "HTTPException": HTTPException,
                     "private_job": private_job, "get_urls": security.get_urls, "OUTPUT_PATTERN": security.FILE_PATTERN,
                     "job_path": storage.job_path, "read_state": storage.read_state, "write_state": storage.write_state,
                     "valid_id": storage.valid_id, "time": time}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "gateway.py", "exec"), namespace)
        return namespace[name], HTTPException

    def test_stratified_sampling_scale_only_and_source_unchanged(self):
        record = self.ensure()
        data = (self.directory / record["viewer_file"]).read_bytes()
        total, count = len(self.raw) // 32, record["splat_count"]
        self.assertEqual(count, 257)
        self.assertEqual(len(data), count * 32)
        self.assertEqual(record["source_bytes"], len(self.raw))
        self.assertEqual(record["version"], 1)
        self.assertLessEqual(record["scale_multiplier"], 1.65)
        self.assertNotIn("source_mtime_ns", record)
        offsets = set()
        for index in range(count):
            row = data[index * 32:(index + 1) * 32]
            source_index = int(struct.unpack_from("<f", row)[0])
            start, end = index * total // count, (index + 1) * total // count
            self.assertLessEqual(start, source_index)
            self.assertLess(source_index, end)
            offsets.add(source_index - start)
            original = self.raw[source_index * 32:(source_index + 1) * 32]
            self.assertEqual(row[:12], original[:12])
            self.assertEqual(row[24:], original[24:])
            expected = struct.pack("<3f", *(value * record["scale_multiplier"] for value in struct.unpack_from("<3f", original, 12)))
            self.assertEqual(row[12:24], expected)
        self.assertGreater(len(offsets), 4, "avoid fixed sampling offsets/grid stripes")
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_small_scene_is_byte_identical(self):
        self.source.write_bytes(self.raw[:200 * 32])
        record = self.ensure()
        self.assertEqual(record["scale_multiplier"], 1)
        self.assertEqual((self.directory / record["viewer_file"]).read_bytes(), self.raw[:200 * 32])

    def test_cache_does_not_read_source_again_and_invalidates_modified_source(self):
        first = self.ensure()
        original_open = Path.open
        def guarded_open(path, *args, **kwargs):
            if path == self.source:
                raise AssertionError("cached listing must not read full scene")
            return original_open(path, *args, **kwargs)
        with patch.object(Path, "open", guarded_open):
            self.assertEqual(self.ensure(), first)
            self.assertEqual(mobile_preview.get_mobile_preview(self.directory, self.filename), first)
        self.source.write_bytes(self.raw + self.raw[:32])
        self.assertIsNone(mobile_preview.get_mobile_preview(self.directory, self.filename))
        self.assertEqual(self.ensure()["source_bytes"], len(self.raw) + 32)

    def test_concurrent_requests_encode_once(self):
        with patch.object(mobile_preview, "_generate", wraps=mobile_preview._generate) as generate:
            with ThreadPoolExecutor(max_workers=4) as pool:
                records = list(pool.map(lambda _: self.ensure(), range(4)))
            self.assertEqual(generate.call_count, 1)
            self.assertTrue(all(record == records[0] for record in records))
        self.assertFalse(list(self.directory.glob("*.tmp")))

    def test_invalid_source_rejected_without_partial_output(self):
        self.source.write_bytes(self.raw[:-1])
        with self.assertRaises(ValueError):
            self.ensure()
        self.assertFalse(list(self.directory.glob("*_mobile.splat")))
        self.assertFalse(list(self.directory.glob("*.tmp")))
        with self.assertRaises(ValueError):
            mobile_preview.ensure_mobile_preview(self.directory, "../access.json")

    def test_signed_mobile_access_does_not_expose_metadata(self):
        record = self.ensure()
        name = record["viewer_file"]
        urls = security.get_urls(self.job_id, [name, name.removesuffix(".splat") + ".json"])
        self.assertEqual(list(urls), [name])
        query = parse_qs(urlparse(urls[name]).query)
        security.authorize_file(self.job_id, name, query["expires"][0], query["sig"][0])
        with self.assertRaises(security.AccessDenied):
            security.authorize_file(self.job_id, name, "", "")
        for name in ("scene_" + self.job_id + "_mobile.ply", "../access.json", "mobile-preview.lock"):
            self.assertFalse(security.FILE_PATTERN.fullmatch(name))

    def test_api_auth_precedes_mobile_work_and_default_is_lazy(self):
        files, error = self.endpoint("files")
        with patch.object(mobile_preview, "ensure_mobile_preview", side_effect=AssertionError("unexpected mobile encoding")):
            with self.assertRaises(error) as denied:
                files(self.job_id, "", preview="mobile")
            self.assertEqual(denied.exception.status_code, 403)
            ordinary = files(self.job_id, self.token)
            self.assertNotIn("mobile_viewer_file", ordinary)
            self.assertEqual(ordinary["viewer_file"], self.filename)
        result = files(self.job_id, self.token, preview="mobile")
        self.assertIn(result["mobile_viewer_file"], result["file_urls"])
        self.assertIn(self.filename, result["file_urls"])
        self.assertEqual(result["mobile_preview"]["source_bytes"], len(self.raw))

    def test_status_discovers_mobile_without_generating(self):
        status, _ = self.endpoint("status")
        with patch.object(mobile_preview, "ensure_mobile_preview", side_effect=AssertionError("status must never generate")):
            self.assertNotIn("mobile_viewer_file", status(self.job_id, self.token))
        expected = self.ensure()
        result = status(self.job_id, self.token)
        self.assertEqual(result["mobile_viewer_file"], expected["viewer_file"])
        self.assertIn(expected["viewer_file"], result["file_urls"])

    def test_explicit_source_selects_that_scene_and_never_falls_back(self):
        files, error = self.endpoint("files")
        other = "scene_" + "b" * 32 + ".splat"
        (self.directory / other).write_bytes(self.raw[:200 * 32])
        with patch("preview.ensure_latest_preview", side_effect=AssertionError("Explicit source must not select latest")):
            result = files(self.job_id, self.token, preview="mobile", source=other)
        self.assertEqual(result["viewer_file"], other)
        self.assertEqual(result["mobile_preview"]["source_file"], other)
        self.assertEqual(result["mobile_preview"]["source_bytes"], 200 * 32)
        self.assertEqual(result["mobile_viewer_file"], other.removesuffix(".splat") + "_mobile.splat")
        for source in ("../access.json", "access.json", self.filename.removesuffix(".splat") + "_mobile.splat", self.ply):
            with self.assertRaises(error) as invalid:
                files(self.job_id, self.token, preview="mobile", source=source)
            self.assertEqual(invalid.exception.status_code, 400)
        with self.assertRaises(error) as missing:
            files(self.job_id, self.token, preview="mobile", source="scene_" + "c" * 32 + ".splat")
        self.assertEqual(missing.exception.status_code, 404)
        with self.assertRaises(error) as wrong_mode:
            files(self.job_id, self.token, source=other)
        self.assertEqual(wrong_mode.exception.status_code, 400)


def benchmark(source_path, destination_path):
    source, destination = Path(source_path), Path(destination_path)
    with source.open("rb") as stream:
        before = hashlib.file_digest(stream, "sha256").hexdigest()
    started = time.perf_counter()
    result = mobile_preview._generate(source, destination, destination.with_suffix(".json"))
    seconds = time.perf_counter() - started
    with source.open("rb") as stream:
        after = hashlib.file_digest(stream, "sha256").hexdigest()
    assert before == after, "Full model changed"
    print(json.dumps({**result, "seconds": round(seconds, 4), "source_unchanged": True}, indent=2))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--benchmark":
        benchmark(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
