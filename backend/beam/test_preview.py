"""Offline scalar/NumPy compatibility and bounded conversion checks.

Tests: python -m unittest discover -s backend/beam -p test_preview.py
Real file: python backend/beam/test_preview.py --benchmark artifacts/landing.ply
No dependency installation, cloud calls, or GPU use.
"""
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import preview

try:
    import numpy as np
except ImportError:
    np = None

BASE = dict(zip(preview.FIELDS, (1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0)))


def write_ply(path, records, properties=None):
    properties = properties or [("float", name) for name in preview.FIELDS]
    layout = struct.Struct("<" + "".join(preview.TYPES[kind] for kind, _ in properties))
    header = "ply\nformat binary_little_endian 1.0\nelement vertex " + str(len(records)) + "\n"
    header += "".join(f"property {kind} {name}\n" for kind, name in properties) + "end_header\n"
    with path.open("wb") as output:
        output.write(header.encode("ascii"))
        for record in records:
            output.write(layout.pack(*(record[name] for _, name in properties)))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="preview-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.source, self.slow, self.fast = (self.root / name for name in ("input.ply", "slow.splat", "fast.splat"))

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(self.workspace))
        self.temporary.cleanup()

    def same_bytes(self, records, properties=None):
        write_ply(self.source, records, properties)
        slow = preview.convert_ply_to_splat(self.source, self.slow, fast=False)
        fast = preview.convert_ply_to_splat(self.source, self.fast, fast=True)
        self.assertEqual(self.slow.read_bytes(), self.fast.read_bytes())
        self.assertEqual(slow["splat_count"], len(records))
        self.assertEqual(fast["viewer_bytes"], len(records) * 32)


class ScalarAndFallbackTests(Fixture):
    def test_golden_layout_and_zero_norm(self):
        expected = struct.pack("<6f8B", 1, 2, 3, 1, 1, 1, 127, 127, 127, 127, 255, 128, 128, 128)
        for quaternion in ((1, 0, 0, 0), (0, 0, 0, 0)):
            record = {**BASE, **dict(zip(preview.FIELDS[10:], quaternion))}
            write_ply(self.source, [record])
            preview.convert_ply_to_splat(self.source, self.slow, fast=False)
            self.assertEqual(self.slow.read_bytes(), expected)

    def test_missing_numpy_uses_original_scalar_path(self):
        with patch.dict(sys.modules, {"numpy": None}):
            self.same_bytes([BASE, {**BASE, "opacity": -80}])

    def test_invalid_scalar_input_never_replaces_existing_output(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            write_ply(self.source, [{**BASE, "x": value}])
            self.slow.write_bytes(b"previous valid file")
            with self.assertRaises(ValueError):
                preview.convert_ply_to_splat(self.source, self.slow, fast=False)
            self.assertEqual(self.slow.read_bytes(), b"previous valid file")
            self.assertFalse(list(self.root.glob("*.tmp")))
        write_ply(self.source, [BASE])
        self.source.write_bytes(self.source.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            preview.convert_ply_to_splat(self.source, self.slow, fast=False)
        self.assertEqual(self.slow.read_bytes(), b"previous valid file")


@unittest.skipUnless(np is not None, "NumPy unavailable; run these comparisons in the existing inference environment")
class NumpyTests(Fixture):
    def test_reordered_mixed_types_extra_fields_and_final_partial_block(self):
        rng = random.Random(9131)
        records = []
        for index in range(8192 + 7):
            record = {name: rng.uniform(-2, 2) for name in preview.FIELDS}
            for name in preview.FIELDS[3:6]:
                record[name] = rng.uniform(-30, 3)
            record.update(opacity=rng.uniform(-120, 120), flag=255, group=-17, count=65535,
                          signed=-300, ident=4294967295, negative=-2147483648, ignored=float("nan"))
            records.append(record)
        properties = [("double" if index % 2 else "float32", name) for index, name in enumerate(preview.FIELDS)]
        properties += [("uint8", "flag"), ("int8", "group"), ("uint16", "count"), ("int16", "signed"),
                       ("uint32", "ident"), ("int32", "negative"), ("float64", "ignored")]
        rng.shuffle(properties)
        with patch.object(preview, "_numpy_batch", wraps=preview._numpy_batch) as batch:
            self.same_bytes(records, properties)
            self.assertEqual(batch.call_count, 2)

    def test_quantization_boundaries_and_extreme_quaternions(self):
        records = [BASE, {**BASE, "rot_0": 0}, {**BASE, "rot_0": 1e308, "rot_1": 1e308},
                   {**BASE, "rot_0": 1e-308}, {**BASE, "scale_0": -744, "scale_1": -100, "scale_2": -80}]
        c0 = .28209479177387814
        for integer in range(1, 255):
            color = (integer / 255 - .5) / c0
            opacity = math.log(integer / (255 - integer))
            for direction in (-math.inf, math.inf):
                records.append({**BASE, "f_dc_0": math.nextafter(color, direction),
                                "opacity": math.nextafter(opacity, direction)})
        for integer in range(1, 255):
            component = (integer - 128 - .5) / 128
            if abs(component) < 1:
                records.append({**BASE, "rot_0": math.sqrt(1 - component * component), "rot_1": component})
        for value in (1e-30, .1, .5, 1, 2, 100, 1e20):
            bits = struct.unpack("<I", struct.pack("<f", value))[0]
            a = struct.unpack("<f", struct.pack("<I", bits))[0]
            b = struct.unpack("<f", struct.pack("<I", bits + 1))[0]
            exponent = math.log((a + b) / 2)
            for direction in (-math.inf, math.inf):
                records.append({**BASE, "scale_0": math.nextafter(exponent, direction)})
        self.same_bytes(records, [("double", name) for name in preview.FIELDS])

    def test_integer_gaussian_attributes_preserve_scalar_arithmetic(self):
        record = {**BASE, "rot_0": 4294967295, "rot_1": 4294967294}
        properties = [("uint32" if name in ("rot_0", "rot_1") else "float", name) for name in preview.FIELDS]
        with patch.object(preview, "_numpy_batch", side_effect=AssertionError("Integer quaternion must use exact scalar arithmetic")):
            self.same_bytes([record], properties)

    def test_nonfinite_opacity_is_transparent_not_fatal(self):
        # SHARP 偶尔输出极少数 NaN 不透明度（实测 118 万点里 3 个），不应让整份预览失败
        write_ply(self.source, [BASE, {**BASE, "opacity": float("nan")}])
        preview.convert_ply_to_splat(self.source, self.fast)
        preview.convert_ply_to_splat(self.source, self.slow, fast=False)
        self.assertEqual(self.fast.read_bytes(), self.slow.read_bytes())
        self.assertEqual(self.fast.read_bytes()[32 + 27], 0)  # 第二个点的 alpha
        for value in (float("inf"), float("-inf")):
            write_ply(self.source, [{**BASE, "opacity": value}])
            self.same_bytes([{**BASE, "opacity": value}])

    def test_nonfinite_and_truncated_fast_input_is_atomic(self):
        for field in (f for f in preview.FIELDS if f != "opacity"):
            for value in (float("nan"), float("inf"), float("-inf")):
                write_ply(self.source, [{**BASE, field: value}])
                self.fast.write_bytes(b"previous valid file")
                with self.assertRaises(ValueError):
                    preview.convert_ply_to_splat(self.source, self.fast)
                self.assertEqual(self.fast.read_bytes(), b"previous valid file")
                self.assertFalse(list(self.root.glob("*.tmp")))
        write_ply(self.source, [BASE])
        self.source.write_bytes(self.source.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            preview.convert_ply_to_splat(self.source, self.fast)
        self.assertEqual(self.fast.read_bytes(), b"previous valid file")

    def test_overflow_matches_scalar_rejection(self):
        for change in ({"x": 1e100}, {"scale_0": 1000}, {"scale_0": 100}, {"f_dc_0": 1e308}):
            write_ply(self.source, [{**BASE, **change}], [("double", name) for name in preview.FIELDS])
            for fast in (False, True):
                with self.assertRaises(OverflowError):
                    preview.convert_ply_to_splat(self.source, self.fast, fast=fast)
                self.assertFalse(list(self.root.glob("*.tmp")))


def benchmark(source):
    if np is None:
        raise SystemExit("NumPy is not installed here; run in the existing conda inference environment.")
    workspace = Path(__file__).resolve().parent
    temporary = tempfile.TemporaryDirectory(prefix="preview-benchmark-", dir=workspace)
    root = Path(temporary.name).resolve()
    results = {}
    try:
        for name, enabled in (("scalar", False), ("numpy", True)):
            destination = root / (name + ".splat")
            started = time.perf_counter()
            metadata = preview.convert_ply_to_splat(source, destination, fast=enabled)
            elapsed = time.perf_counter() - started
            digest = hashlib.sha256()
            with destination.open("rb") as incoming:
                while block := incoming.read(1024 * 1024):
                    digest.update(block)
            results[name] = {**metadata, "wall_seconds": round(elapsed, 4), "sha256": digest.hexdigest()}
        assert results["scalar"]["sha256"] == results["numpy"]["sha256"], "Real-file output differs"
        print(json.dumps({"numpy_version": np.__version__, "equal_bytes": True, "results": results}, indent=2))
    finally:
        assert root.is_relative_to(workspace)
        temporary.cleanup()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--benchmark":
        benchmark(sys.argv[2])
    else:
        unittest.main()
