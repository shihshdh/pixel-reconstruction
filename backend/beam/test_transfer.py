"""Offline transport tests; core checks use only stdlib, real HTTP when installed.

Run: python -m unittest discover -s backend/beam -p 'test_*.py'
No account credentials, network requests, GPU calls, or deployments.
"""
import ast
import asyncio
import gzip
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import security
import storage
import transfer


def restore(packet):
    magic, length, block_rows, transform = transfer.HEADER.unpack_from(packet)
    assert (magic, transform) == (transfer.MAGIC, 1)
    lanes = gzip.decompress(packet[20:])
    assert len(lanes) == length
    output = bytearray(length)
    for base in range(0, length, block_rows * 32):
        count = min(block_rows * 32, length - base) // 32
        for column in range(32):
            output[base + column:base + count * 32:32] = lanes[base + column * count:base + (column + 1) * count]
    return bytes(output)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="transfer-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.cache = self.root / "cache"
        self.patches = [patch.object(transfer, "CACHE_ROOT", self.cache),
                        patch.object(storage, "ROOT", self.root / "data"),
                        patch.object(security, "ROOT", self.root / "data"),
                        patch.dict(os.environ, {"BEAM_API_TOKEN": "offline-test-only-not-an-account-key"})]
        for item in self.patches:
            item.start()
        transfer._leases.clear()
        self.job_id = "a" * 32
        self.directory = storage.job_path(self.job_id)
        self.directory.mkdir(parents=True)
        security.create_access(self.job_id)
        self.filename = "scene_" + self.job_id + ".splat"
        self.source = self.directory / self.filename
        self.raw = struct.pack("<8f", 1, 2, 3, .1, .2, .3, .4, .5) * (65536 + 7)
        self.source.write_bytes(self.raw)
        query = parse_qs(urlparse(security.get_urls(self.job_id, [self.filename])[self.filename]).query)
        self.expires, self.sig = query["expires"][0], query["sig"][0]

    def tearDown(self):
        transfer._leases.clear()
        for item in reversed(self.patches):
            item.stop()
        self.assertTrue(self.root.resolve().is_relative_to(self.workspace))
        self.temporary.cleanup()


class TransferTests(Fixture):
    def test_representation_etag_survives_cache_access_and_rebuild(self):
        path = transfer.prepare_transfer(self.source)
        packet, etag, modified = path.read_bytes(), transfer.transfer_etag(path), path.stat().st_mtime_ns
        self.assertEqual(transfer.prepare_transfer(self.source), path)
        self.assertEqual(path.stat().st_mtime_ns, modified)
        self.assertEqual(transfer.transfer_etag(path), etag)
        transfer.release_transfer(path)
        transfer.release_transfer(path)
        path.unlink()  # Simulate a fresh container without its temporary cache.
        rebuilt = transfer.prepare_transfer(self.source)
        self.assertEqual(rebuilt.read_bytes(), packet)
        self.assertEqual(transfer.transfer_etag(rebuilt), etag)
        transfer.release_transfer(rebuilt)
        self.source.write_bytes(self.raw + self.raw[:32])
        changed = transfer.prepare_transfer(self.source)
        self.assertNotEqual(transfer.transfer_etag(changed), etag)
        transfer.release_transfer(changed)

    def test_roundtrip_header_partial_block_cache_and_leases(self):
        path = transfer.prepare_transfer(self.source)
        self.assertNotEqual(path, self.source)
        packet = path.read_bytes()
        self.assertEqual(transfer.HEADER.size, 20)
        self.assertEqual(transfer.HEADER.unpack_from(packet), (b"PRSGZ001", len(self.raw), 65536, 1))
        self.assertEqual(packet[24:28], b"\0" * 4, "gzip mtime must be zero")
        self.assertEqual(restore(packet), self.raw)
        self.assertLessEqual(len(packet), len(self.raw) * .95)
        with patch.object(transfer.zlib, "compressobj", side_effect=AssertionError("cache miss")):
            self.assertEqual(transfer.prepare_transfer(self.source), path)
        self.assertEqual(transfer._leases[path], 2)
        transfer.release_transfer(path)
        transfer.release_transfer(path)
        self.assertNotIn(path, transfer._leases)

    def test_raw_fallback_and_negative_cache(self):
        self.source.write_bytes(os.urandom(32 * 8192))
        self.assertEqual(transfer.prepare_transfer(self.source), self.source)
        with patch.object(transfer.zlib, "compressobj", side_effect=AssertionError("raw decision not cached")):
            self.assertEqual(transfer.prepare_transfer(self.source), self.source)
        self.assertFalse(list(self.cache.glob("*.tmp")))
        self.source.write_bytes(b"malformed length")
        self.assertEqual(transfer.prepare_transfer(self.source), self.source)
        self.source.write_bytes(b"\0" * 128)
        with patch.object(transfer, "MAX_RAW_BYTES", 64):
            self.assertEqual(transfer.prepare_transfer(self.source), self.source)

    def test_changed_source_uses_new_cache_key(self):
        old = transfer.prepare_transfer(self.source)
        transfer.release_transfer(old)
        self.source.write_bytes(self.raw + self.raw[:32])
        new = transfer.prepare_transfer(self.source)
        self.assertNotEqual(old, new)
        self.assertEqual(restore(new.read_bytes()), self.raw + self.raw[:32])
        transfer.release_transfer(new)

    def test_cache_limit_does_not_evict_inflight_or_source(self):
        first = transfer.prepare_transfer(self.source)
        other = self.directory / ("scene_" + "b" * 32 + ".splat")
        other.write_bytes(self.raw)
        with patch.object(transfer, "CACHE_LIMIT_BYTES", first.stat().st_size * 2):
            self.assertEqual(transfer.prepare_transfer(other), other)
            self.assertTrue(first.exists(), "in-flight download must stay readable")
            transfer.release_transfer(first)
            second = transfer.prepare_transfer(other)
            self.assertNotEqual(second, other)
            self.assertFalse(first.exists())
            self.assertLessEqual(sum(p.stat().st_size for p in self.cache.iterdir()), transfer.CACHE_LIMIT_BYTES)
            transfer.release_transfer(second)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertEqual(other.read_bytes(), self.raw)

    def test_accept_requires_explicit_enabled_media_type(self):
        self.assertTrue(transfer.accepts_transfer(transfer.MEDIA_TYPE))
        self.assertTrue(transfer.accepts_transfer("application/octet-stream, " + transfer.MEDIA_TYPE + ";q=0.5"))
        for value in ("", "*/*", transfer.MEDIA_TYPE + ";q=0", transfer.MEDIA_TYPE + ";q=invalid"):
            self.assertFalse(transfer.accepts_transfer(value))


class EndpointTests(Fixture):
    """Execute the actual /file function AST, substituting only framework types."""
    def setUp(self):
        super().setUp()
        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                self.status_code, self.detail = status_code, detail
        class Response:
            def __init__(self, path, media_type, headers):
                self.path, self.media_type, self.headers = path, media_type, headers
                self.fail_send = False
            async def __call__(self, scope, receive, send):
                if self.fail_send:
                    raise RuntimeError("offline simulated disconnect")
        module = ast.parse((self.workspace / "gateway.py").read_text(encoding="utf-8-sig"))
        create = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "create_app")
        function = next(node for node in create.body if isinstance(node, ast.FunctionDef) and node.name == "file")
        function.decorator_list = []
        namespace = {"Header": lambda default="", **kwargs: default, "authorize_file": security.authorize_file,
                     "AccessDenied": security.AccessDenied, "HTTPException": HTTPException,
                     "get_job": storage.job_path, "OUTPUT_PATTERN": security.FILE_PATTERN, "FileResponse": Response}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "gateway.py", "exec"), namespace)
        self.endpoint, self.HTTPException = namespace["file"], HTTPException

    def call(self, **kwargs):
        return self.endpoint(self.job_id, self.filename, self.expires, self.sig, **kwargs)

    def test_unauthorized_never_calls_encoder(self):
        with patch.object(transfer, "prepare_transfer", side_effect=AssertionError("unauthorized encode")):
            with self.assertRaises(self.HTTPException) as error:
                self.endpoint(self.job_id, self.filename, "", "", accept=transfer.MEDIA_TYPE)
        self.assertEqual(error.exception.status_code, 403)
        self.assertFalse(self.cache.exists())

    def test_negotiation_no_paths_or_content_encoding_and_release(self):
        raw = self.call()
        self.assertEqual(raw.path, self.source)
        self.assertEqual(raw.media_type, "application/octet-stream")
        packet = self.call(accept=transfer.MEDIA_TYPE)
        self.assertEqual(packet.media_type, transfer.MEDIA_TYPE)
        self.assertEqual(packet.chunk_size, 256 * 1024)
        self.assertEqual(packet.headers["Vary"], "Accept")
        self.assertEqual(packet.headers["Cache-Control"], "private, no-store")
        self.assertEqual(packet.headers["Referrer-Policy"], "no-referrer")
        self.assertNotIn("Content-Encoding", packet.headers)
        self.assertNotIn(str(self.cache), str(packet.headers))
        packet.fail_send = True
        with self.assertRaises(RuntimeError):
            asyncio.run(packet({}, None, None))
        self.assertFalse(transfer._leases, "disconnect must release the cache lease")


class RealHTTPTests(Fixture):
    def test_raw_packet_and_range_with_actual_starlette(self):
        try:
            from fastapi.testclient import TestClient
            import gateway
        except ImportError as error:
            self.skipTest("Optional HTTP dependencies unavailable: " + str(error))
        except RuntimeError as error:
            if "requires the httpx" in str(error):
                self.skipTest("Optional HTTP test client unavailable: " + str(error))
            raise
        with TestClient(gateway.create_app()) as client:
            url = f"/file/{self.job_id}/{self.filename}?expires={self.expires}&sig={self.sig}"
            response = client.get(url, headers={"Range": "bytes=32-63"})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, self.raw[32:64])
            response = client.get(url, headers={"Accept": transfer.MEDIA_TYPE})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], transfer.MEDIA_TYPE)
            self.assertEqual(restore(response.content), self.raw)
            self.assertNotIn("content-encoding", response.headers)
            self.assertFalse(transfer._leases)
            response = client.get(url, headers={"Accept": transfer.MEDIA_TYPE, "Range": "bytes=0-19"})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, transfer.HEADER.pack(transfer.MAGIC, len(self.raw), transfer.BLOCK_ROWS, 1))
            self.assertFalse(transfer._leases)


if __name__ == "__main__":
    unittest.main()
