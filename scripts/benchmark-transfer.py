"""Local-only, real-file benchmark for the exact CPU transport encoder."""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend/beam"))
import transfer

source = root / "artifacts/landing-preview.splat"
with tempfile.TemporaryDirectory(prefix="transfer-benchmark-", dir=root / "artifacts") as directory:
    transfer.CACHE_ROOT = Path(directory)
    started = time.perf_counter()
    packet = transfer.prepare_transfer(source)
    encoded = time.perf_counter()
    assert packet != source.resolve(), "Sample must use compressed transport"
    data = packet.read_bytes()
    magic, length, block_rows, flags = transfer.HEADER.unpack_from(data)
    assert magic == transfer.MAGIC and flags == 1
    shuffled = gzip.decompress(data[transfer.HEADER.size:])
    restored = bytearray(length)
    for offset in range(0, length, block_rows * 32):
        block = shuffled[offset:offset + block_rows * 32]
        rows = len(block) // 32
        for column in range(32):
            restored[offset + column:offset + len(block):32] = block[column * rows:(column + 1) * rows]
    assert hashlib.sha256(restored).digest() == hashlib.sha256(source.read_bytes()).digest()
    finished = time.perf_counter()
    report = {"rawBytes": length, "wireBytes": len(data), "encodeSeconds": encoded - started, "decodeAndVerifySeconds": finished - encoded, "identical": True}
    transfer.release_transfer(packet)
    (root / "artifacts/transfer-python-benchmark.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
