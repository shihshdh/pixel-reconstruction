"""Lazy, CPU-only reduced .splat previews for authorized mobile viewers.

Full-resolution sources never change. One deterministic random sample per
equal-sized stratum avoids the stripes caused by sampling every nth pixel.
Only a small source block and the selected rows are held in memory.
"""
import math
import os
from pathlib import Path
import re
import struct
import threading
import uuid

from storage import atomic_json, read_json

VERSION = 1
MAX_POINTS = 147456
MAX_SOURCE_BYTES = 320 * 1024 * 1024
BLOCK_ROWS = 8192
FULL_PATTERN = re.compile(r"^scene_[0-9a-f]{32}\.splat$")
_lock = threading.Lock()
_xyz_scale = struct.Struct("<6f")
_scales = struct.Struct("<3f")


def _paths(directory, full_name):
    if not isinstance(full_name, str) or not FULL_PATTERN.fullmatch(full_name):
        raise ValueError("Invalid full preview name")
    directory = Path(directory)
    source = directory / full_name
    destination = directory / (source.stem + "_mobile.splat")
    metadata = destination.with_suffix(".json")
    return source, destination, metadata


def _public(record):
    return {key: record[key] for key in ("version", "viewer_file", "viewer_bytes", "splat_count",
                                       "source_file", "source_bytes", "source_splat_count", "scale_multiplier")}


def get_mobile_preview(directory, full_name):
    """Inspect only metadata/stat; never read the large full-resolution asset."""
    try:
        source, destination, metadata = _paths(directory, full_name)
        info = source.stat()
        if not 0 < info.st_size <= MAX_SOURCE_BYTES or info.st_size % 32:
            return None
        record = read_json(metadata, {})
        count = min(info.st_size // 32, MAX_POINTS)
        if (record.get("version") != VERSION or record.get("source_file") != full_name
                or record.get("source_bytes") != info.st_size or record.get("source_mtime_ns") != info.st_mtime_ns
                or record.get("splat_count") != count or record.get("viewer_file") != destination.name
                or record.get("viewer_bytes") != count * 32 or destination.stat().st_size != count * 32):
            return None
        return _public(record)
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _generate(source, destination, metadata):
    info = source.stat()
    if not 0 < info.st_size <= MAX_SOURCE_BYTES or info.st_size % 32:
        raise ValueError("Invalid full preview size")
    total, count = info.st_size // 32, min(info.st_size // 32, MAX_POINTS)
    scale = min(1.65, (total / count) ** .25)
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    seed, selected, next_index = 9131, 0, None

    def choose(index):
        nonlocal seed
        start, end = index * total // count, (index + 1) * total // count
        seed = (1664525 * seed + 1013904223) & 0xffffffff
        # High bits avoid low-bit LCG periodicity when the stratum is 8 rows.
        return start + (seed * (end - start) >> 32)

    try:
        with source.open("rb") as incoming, temporary.open("wb") as outgoing:
            base = 0
            while base < total:
                rows = min(BLOCK_ROWS, total - base)
                block = incoming.read(rows * 32)
                if len(block) != rows * 32:
                    raise ValueError("Truncated full preview")
                if count == total:
                    outgoing.write(block)  # Small scenes remain byte-identical.
                    selected += rows
                else:
                    output = bytearray()
                    while selected < count:
                        if next_index is None:
                            next_index = choose(selected)
                        if next_index >= base + rows:
                            break
                        offset = (next_index - base) * 32
                        values = _xyz_scale.unpack_from(block, offset)
                        if not all(math.isfinite(value) for value in values):
                            raise ValueError("Invalid Gaussian attribute")
                        row = bytearray(block[offset:offset + 32])
                        _scales.pack_into(row, 12, *(value * scale for value in values[3:]))
                        output.extend(row)
                        selected += 1
                        next_index = None
                    outgoing.write(output)
                base += rows
            latest = source.stat()
            if (latest.st_size, latest.st_mtime_ns) != (info.st_size, info.st_mtime_ns) or selected != count:
                raise ValueError("Source changed during mobile preview generation")
        os.replace(temporary, destination)
        record = {"version": VERSION, "viewer_file": destination.name, "viewer_bytes": count * 32,
                  "splat_count": count, "source_file": source.name, "source_bytes": info.st_size,
                  "source_splat_count": total, "source_mtime_ns": info.st_mtime_ns, "scale_multiplier": scale}
        atomic_json(metadata, record)
        return _public(record)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_mobile_preview(directory, full_name):
    """Call only after job authorization and only for an explicit mobile request."""
    existing = get_mobile_preview(directory, full_name)
    if existing:
        return existing
    source, destination, metadata = _paths(directory, full_name)
    with _lock:
        # File lock also prevents duplicate work across overlapping deployments.
        with (Path(directory) / "mobile-preview.lock").open("a+") as lock:
            try:
                import fcntl
            except ImportError:
                fcntl = None
            if fcntl:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                existing = get_mobile_preview(directory, full_name)
                return existing or _generate(source, destination, metadata)
            finally:
                if fcntl:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
