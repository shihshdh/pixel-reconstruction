"""Lossless, CPU-only .splat transport; cache lives only on container temp disk.

prepare_transfer() leases a returned packet until release_transfer() is called.
The caller must authorize the source first. Raw fallbacks need no release.
"""
import hashlib
import os
from pathlib import Path
import re
import struct
import tempfile
import threading
import zlib

MEDIA_TYPE = "application/vnd.pixel-reconstruction.splat+gzip"
MAGIC = b"PRSGZ001"
HEADER = struct.Struct("<8sIII")
BLOCK_ROWS = 65536
MAX_RAW_BYTES = 320 * 1024 * 1024
CACHE_LIMIT_BYTES = 160 * 1024 * 1024
CACHE_ROOT = Path(tempfile.gettempdir()) / "pixel-scene-transfer"
_CACHE_NAME = re.compile(r"^[0-9a-f]{64}(?:\.(?:prsgz|raw)|-[a-zA-Z0-9_]+\.tmp)$")
_lock = threading.Lock()
_leases = {}


def accepts_transfer(value):
    for entry in value.split(","):
        parts = [part.strip().lower() for part in entry.split(";")]
        if parts[0] != MEDIA_TYPE:
            continue
        try:
            quality = next((float(part[2:]) for part in parts[1:] if part.startswith("q=")), 1.0)
        except ValueError:
            continue
        if 0 < quality <= 1:
            return True
    return False


def _owned_file(path, root):
    # Never follow a cache symlink, recurse into directories, or delete a source.
    return (path.parent.resolve() == root and not path.is_symlink()
            and path.resolve().parent == root and path.is_file())


def _make_room(root, reserve=0):
    entries = [(path, path.stat()) for path in root.iterdir()
               if _CACHE_NAME.fullmatch(path.name) and _owned_file(path, root)]
    size, count = sum(item.st_size for _, item in entries), len(entries)
    for path, item in sorted(entries, key=lambda entry: entry[1].st_mtime_ns):
        if size + reserve <= CACHE_LIMIT_BYTES and count < 256:
            break
        if _leases.get(path, 0):
            continue
        try:
            path.unlink()
        except OSError:
            continue
        size -= item.st_size
        count -= 1
    return size + reserve <= CACHE_LIMIT_BYTES and count < 256


class _NotWorthCompressing(Exception):
    pass


class _BoundedWriter:
    def __init__(self, stream, limit):
        self.stream, self.limit = stream, limit

    def write(self, data):
        if self.stream.tell() + len(data) > self.limit:
            raise _NotWorthCompressing()
        return self.stream.write(data)

    def flush(self):
        self.stream.flush()


def prepare_transfer(source):
    """Return a leased packet path when >=5% smaller, otherwise the raw source.

    One encoder per container, 2 MiB input blocks plus small per-column slices;
    no numpy, Node, GPU, persistent volume writes, or account credentials.
    """
    source = Path(source)
    temporary = None
    try:
        source = source.resolve(strict=True)
        info = source.stat()
        if (source.suffix != ".splat" or not source.is_file() or info.st_size < 64
                or info.st_size % 32 or info.st_size > MAX_RAW_BYTES):
            return source
        key = hashlib.sha256(f"{source}\0{info.st_mtime_ns}\0{info.st_size}".encode()).hexdigest()
        with _lock:
            CACHE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
            root = CACHE_ROOT.resolve()
            packet, skipped = root / (key + ".prsgz"), root / (key + ".raw")
            if _owned_file(packet, root):
                with packet.open("rb") as cached:
                    valid = cached.read(HEADER.size) == HEADER.pack(MAGIC, info.st_size, BLOCK_ROWS, 1)
                if valid:
                    _leases[packet] = _leases.get(packet, 0) + 1
                    return packet
            if _owned_file(skipped, root):
                return source
            limit = min(CACHE_LIMIT_BYTES, info.st_size * 95 // 100)
            if not _make_room(root, reserve=limit):
                return source
            try:
                with tempfile.NamedTemporaryFile(mode="wb", prefix=key + "-", suffix=".tmp", dir=root, delete=False) as outgoing:
                    temporary = Path(outgoing.name)
                    bounded = _BoundedWriter(outgoing, limit)
                    bounded.write(HEADER.pack(MAGIC, info.st_size, BLOCK_ROWS, 1))
                    # zlib's gzip wrapper emits mtime=0 without a buffered file
                    # finalizer, including when an incompressible stream aborts.
                    compressed = zlib.compressobj(level=1, wbits=31)
                    with source.open("rb") as incoming:
                        remaining = info.st_size
                        while remaining:
                            block = incoming.read(min(BLOCK_ROWS * 32, remaining))
                            if not block or len(block) % 32:
                                raise ValueError("Source changed during transfer encoding")
                            for column in range(32):
                                bounded.write(compressed.compress(block[column::32]))
                            remaining -= len(block)
                    bounded.write(compressed.flush())
                    latest = source.stat()
                    if (latest.st_size, latest.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
                        raise ValueError("Source changed during transfer encoding")
                os.replace(temporary, packet)
                temporary = None
                _leases[packet] = _leases.get(packet, 0) + 1
                return packet
            except _NotWorthCompressing:
                # Memoize the raw choice for this exact source version.
                skipped.touch(exist_ok=True)
                return source
            finally:
                if temporary and _owned_file(temporary, root):
                    temporary.unlink(missing_ok=True)
    except (OSError, ValueError, OverflowError):
        # Optional transport must never prevent downloading the original.
        return source


def transfer_etag(path):
    """Stable across cache hits and container restarts for this exact encoding.

    The cache stem binds the immutable source path, mtime_ns and size. Encoding
    is deterministic (gzip mtime=0); include every representation parameter so
    byte-range retries never combine different compression versions.
    """
    path = Path(path)
    representation = f"{path.stem}|{MAGIC!r}|{BLOCK_ROWS}|transform=1|level=1|{zlib.ZLIB_RUNTIME_VERSION}|{path.stat().st_size}"
    return '"prsgz-' + hashlib.sha256(representation.encode()).hexdigest() + '"'


def release_transfer(path):
    with _lock:
        path = Path(path)
        count = _leases.get(path, 0)
        if count <= 1:
            _leases.pop(path, None)
        else:
            _leases[path] = count - 1
