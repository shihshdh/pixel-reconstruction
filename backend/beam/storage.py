"""Persistent state shared by the CPU gateway and GPU worker.

Beam Volumes expose a shared filesystem. No in-memory-only job registry and no
GPU requests are needed for polling. Atomic replacement prevents partial JSON.
"""
import contextlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(os.environ.get("RUHUA_DATA", "/ruhua-data"))
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
IMAGE_PATTERN = re.compile(r"^(original\.jpg|edit_[a-f0-9]{32}\.jpg)$")
_lock = threading.Lock()


def valid_id(value):
    return isinstance(value, str) and bool(ID_PATTERN.fullmatch(value))


def job_path(job_id):
    if not valid_id(job_id):
        raise ValueError("任务编号无效")
    return ROOT / "jobs" / job_id


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def state_path(call_id):
    if not valid_id(call_id):
        raise ValueError("任务编号无效")
    return ROOT / "states" / (call_id + ".json")


def write_state(call_id, status, **fields):
    atomic_json(state_path(call_id), {"status": status, "updated_at": time.time(), **fields})


def read_state(call_id):
    return read_json(state_path(call_id))


@contextlib.contextmanager
def admission_lock():
    # One CPU replica and one process: this lock serializes all admission paths.
    # Also use a file lock on Linux for safety during overlapping deployments.
    with _lock:
        ROOT.mkdir(parents=True, exist_ok=True)
        with (ROOT / "admission.lock").open("a+") as lock_file:
            try:
                import fcntl
            except ImportError:
                fcntl = None
            if fcntl:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


class CapacityError(Exception):
    pass


def reserve(call_id, job_id, kind="jobs"):
    """Count accepted work durably; failed work still consumes the daily budget."""
    with admission_lock():
        now = time.time()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        ledger_path = ROOT / "limits" / (day + ".json")
        ledger = read_json(ledger_path, {"jobs": 0, "edits": 0})
        limit = int(os.environ.get("RUHUA_DAILY_" + kind.upper(), "30"))
        if ledger.get(kind, 0) >= limit:
            raise CapacityError("今日体验额度已用完，请明天再试。")
        if kind == "jobs":
            pending = 0
            states = ROOT / "states"
            if states.exists():
                for path in states.glob("*.json"):
                    entry = read_json(path, {})
                    if entry.get("status") in ("running", "queued"):
                        # Queue deadline + 15-minute task deadline. A stale state
                        # becomes a reported error, never an endless spinner.
                        if now - entry.get("updated_at", 0) > 3600:
                            atomic_json(path, {**entry, "status": "error", "updated_at": now,
                                               "message": "任务等待或执行超时，请重新提交。"})
                        else:
                            pending += 1
            if pending >= int(os.environ.get("RUHUA_MAX_PENDING", "3")):
                raise CapacityError("当前生成队列已满，请稍后再试。")
            write_state(call_id, "queued", phase="queued", stage="已排队 · 等待 GPU 唤醒", job_id=job_id)
        ledger[kind] = ledger.get(kind, 0) + 1
        atomic_json(ledger_path, ledger)
