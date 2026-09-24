"""Stream SHARP's binary PLY into the viewer's standard 32-byte .splat format.

All points and float32 positions are retained. Scales are pre-exponentiated,
SH0 colors/opacity become the same bytes used by the viewer's PLY parser, and
normalized wxyz quaternions use the format's 8-bit encoding. Original PLY files
remain available because quaternion quantization is not lossless.
"""
import math
import os
from pathlib import Path
import struct
import threading
import time
import uuid

FIELDS = ("x", "y", "z", "scale_0", "scale_1", "scale_2", "f_dc_0", "f_dc_1", "f_dc_2",
          "opacity", "rot_0", "rot_1", "rot_2", "rot_3")
TYPES = {"float": "f", "float32": "f", "double": "d", "float64": "d",
         "uchar": "B", "uint8": "B", "char": "b", "int8": "b", "ushort": "H",
         "uint16": "H", "short": "h", "int16": "h", "uint": "I", "uint32": "I",
         "int": "i", "int32": "i"}
_preview_lock = threading.Lock()


def _header(stream):
    if stream.readline() != b"ply\n":
        raise ValueError("Unsupported PLY header")
    count, current, names, formats = None, None, [], []
    little_endian = False
    while stream.tell() < 65536:
        line = stream.readline()
        if not line:
            raise ValueError("Incomplete PLY header")
        words = line.decode("ascii").strip().split()
        if not words:
            continue
        if words[0] == "format":
            little_endian = words[1:] == ["binary_little_endian", "1.0"]
        elif words[0] == "element":
            current = words[1]
            if count is None and current != "vertex":
                raise ValueError("PLY vertex data must come first")
            if current == "vertex":
                count = int(words[2])
        elif words[0] == "property" and current == "vertex":
            if len(words) != 3 or words[1] not in TYPES:
                raise ValueError("Unsupported PLY vertex property")
            names.append(words[2])
            formats.append(TYPES[words[1]])
        elif words[0] == "end_header":
            if not little_endian or count is None or not 0 < count <= 10_000_000:
                raise ValueError("Unsupported PLY format/count")
            if any(name not in names for name in FIELDS):
                raise ValueError("PLY is missing Gaussian attributes")
            return count, struct.Struct("<" + "".join(formats)), tuple(names.index(name) for name in FIELDS)
    raise ValueError("PLY header too large")


def _scalar_batch(data, row_in, indexes):
    """Original scalar conversion, retained as the compatibility reference."""
    row_out = struct.Struct("<6f8B")
    sh_c0 = 0.28209479177387814
    output = bytearray(len(data) // row_in.size * row_out.size)
    for index, row in enumerate(row_in.iter_unpack(data)):
        values = [row[field] for field in indexes]
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Non-finite Gaussian attribute")
        x, y, z, sx, sy, sz, r, g, b, opacity, qw, qx, qy, qz = values
        norm = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
        quaternion = (qw / norm, qx / norm, qy / norm, qz / norm) if norm else (1, 0, 0, 0)
        rotation = [min(255, max(0, int(value * 128 + 128 + .5))) for value in quaternion]
        color = [min(255, max(0, math.floor((.5 + sh_c0 * value) * 255))) for value in (r, g, b)]
        alpha = math.floor(255 / (1 + math.exp(-max(-80, min(80, opacity)))))
        row_out.pack_into(output, index * row_out.size, x, y, z,
                          math.exp(sx), math.exp(sy), math.exp(sz), *color, alpha, *rotation)
    return output


def _numpy_layout(np, row_in, indexes):
    formats = row_in.format[1:]
    # Integer Gaussian attributes retain Python's exact integer arithmetic,
    # especially quaternion squares. Extra integer metadata is safe to ignore.
    if any(formats[index] not in "fd" for index in indexes):
        return None
    mapping = {"f": "<f4", "d": "<f8", "B": "u1", "b": "i1",
               "H": "<u2", "h": "<i2", "I": "<u4", "i": "<i4"}
    dtype = np.dtype([(str(index), mapping[code]) for index, code in enumerate(formats)], align=False)
    if dtype.itemsize != row_in.size:
        raise ValueError("PLY layout mismatch")
    return dtype


def _numpy_batch(np, data, dtype, indexes):
    """Vectorize a bounded block without changing scalar math/quantization.

    math.exp deliberately remains the same libm operation used by the scalar
    implementation: vector exp can differ by an ulp at a float32/byte boundary.
    No float16, point filtering, fused operations, or quaternion reordering.
    """
    records = np.frombuffer(data, dtype=dtype)
    values = [records[str(index)].astype(np.float64) for index in indexes]
    if not all(np.isfinite(value).all() for value in values):
        raise ValueError("Non-finite Gaussian attribute")
    count = len(records)
    output = np.empty(count, dtype=np.dtype([
        ("position", "<f4", (3,)), ("scale", "<f4", (3,)),
        ("rgba", "u1", (4,)), ("rotation", "u1", (4,)),
    ], align=False))
    with np.errstate(over="ignore", under="ignore", invalid="ignore", divide="ignore"):
        for axis in range(3):
            output["position"][:, axis] = values[axis]
            output["scale"][:, axis] = np.fromiter(map(math.exp, values[axis + 3]), dtype=np.float64, count=count)
        # struct.pack('<f') rejects finite values that overflow float32.
        if not np.isfinite(output["position"]).all() or not np.isfinite(output["scale"]).all():
            raise OverflowError("Gaussian coordinate or scale exceeds float32")

        qw, qx, qy, qz = values[10:14]
        norm = np.sqrt(((qw * qw + qx * qx) + qy * qy) + qz * qz)
        nonzero = norm != 0
        for axis, component in enumerate((qw, qx, qy, qz)):
            normalized = np.divide(component, norm, out=np.zeros(count, dtype=np.float64), where=nonzero)
            if axis == 0:
                normalized[~nonzero] = 1
            rotation = np.trunc(normalized * 128 + 128 + .5)
            output["rotation"][:, axis] = np.clip(rotation, 0, 255).astype(np.uint8)

        for axis in range(3):
            color = (.5 + 0.28209479177387814 * values[axis + 6]) * 255
            if not np.isfinite(color).all():
                raise OverflowError("Gaussian color exceeds scalar range")
            output["rgba"][:, axis] = np.clip(np.floor(color), 0, 255).astype(np.uint8)
        exponent = -np.clip(values[9], -80, 80)
        opacity_exp = np.fromiter(map(math.exp, exponent), dtype=np.float64, count=count)
        output["rgba"][:, 3] = np.floor(255 / (1 + opacity_exp)).astype(np.uint8)
    return output.tobytes()


def convert_ply_to_splat(source, destination, fast=True):
    """Atomic, bounded-memory conversion; NumPy is optional, never installed.

    fast=False forces the original scalar implementation for byte comparisons.
    """
    started = time.perf_counter()
    source, destination = Path(source), Path(destination)
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    np = None
    if fast:
        try:
            import numpy as np
        except ImportError:
            pass
    try:
        with source.open("rb") as incoming, temporary.open("wb") as outgoing:
            count, row_in, indexes = _header(incoming)
            dtype = _numpy_layout(np, row_in, indexes) if np is not None else None
            remaining = count
            while remaining:
                batch_size = min(8192, remaining)
                data = incoming.read(batch_size * row_in.size)
                if len(data) != batch_size * row_in.size:
                    raise ValueError("Truncated PLY vertex data")
                output = _numpy_batch(np, data, dtype, indexes) if dtype is not None else _scalar_batch(data, row_in, indexes)
                outgoing.write(output)
                remaining -= batch_size
        os.replace(temporary, destination)
        return {"splat_count": count, "viewer_bytes": destination.stat().st_size,
                "preview_seconds": round(time.perf_counter() - started, 3),
                "preview_engine": "numpy" if dtype is not None else "scalar"}
    finally:
        temporary.unlink(missing_ok=True)


def ensure_latest_preview(directory):
    """Upgrade a completed legacy job on CPU, at most one conversion at a time.

    A concurrent caller can still get the original PLY and retry the listing.
    This routine is called only after the gateway has authorized the job token.
    """
    from storage import read_state, valid_id
    candidates = []
    for source in directory.glob("scene_*.ply"):
        call_id = source.stem.removeprefix("scene_")
        if valid_id(call_id):
            state = read_state(call_id)
            if state and state.get("status") == "done":
                candidates.append(source)
    if not candidates:
        return None
    source = max(candidates, key=lambda item: item.stat().st_mtime)
    destination = source.with_suffix(".splat")
    if destination.is_file():
        return destination.name
    if not _preview_lock.acquire(blocking=False):
        return None
    try:
        with (directory / "preview.lock").open("a+") as lock:
            try:
                import fcntl
            except ImportError:
                fcntl = None
            if fcntl:
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return None
            try:
                if not destination.is_file():
                    convert_ply_to_splat(source, destination)
                return destination.name
            finally:
                if fcntl:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except (OSError, ValueError, OverflowError):
        # Downloading the original remains possible even if conversion fails.
        print("Optional browser preview conversion unavailable", flush=True)
        return None
    finally:
        _preview_lock.release()


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser(description="Convert SHARP PLY to standard .splat offline")
    parser.add_argument("source")
    parser.add_argument("destination")
    options = parser.parse_args()
    print(json.dumps(convert_ply_to_splat(options.source, options.destination)))
