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


# ---- Hot state ----
# The shared volume is eventually consistent between containers: measured 2026-10-23, a warm CPU API container kept
# reading a GPU-written state file 30–47 s out of date, and a warm GPU container could not yet see a state the gateway
# had just written. Small, frequently changing records (task states, warm-up window, GPU demand) therefore also go to
# Beam's Map (a strongly consistent key/value store both containers reach over gRPC). Readers try the Map first and
# fall back to the volume, which stays the durable copy. Only on Beam (RUHUA_STATE_MAP set); the desktop client's local
# engine and the tests use the volume alone.
_hot = None
hot_problem = ""


def _hot_map():
    global _hot, hot_problem
    # Beam does not pass the decorators' env= into these containers (measured 2026-10-23), so detect a Beam container
    # by the variables its runner always sets (STUB_ID, CONTAINER_ID) and use the fixed map name there.
    on_beam = bool(os.environ.get("STUB_ID") and os.environ.get("CONTAINER_ID"))
    name = os.environ.get("RUHUA_STATE_MAP", "").strip() or ("ruhua-states" if on_beam else "")
    if not name:
        return None
    if _hot is None:
        Map = None
        for module in ("beta9", "beam"):
            try:
                Map = __import__(module, fromlist=["Map"]).Map
                break
            except Exception as error:  # noqa: BLE001 - reported once, then the volume is used
                hot_problem += f"{module}: {type(error).__name__}: {str(error)[:160]}; "
        if Map is None:
            print("hot state unavailable:", hot_problem, flush=True)
            _hot = False
            return None
        _hot = Map(name=name)
    # Map defines __len__: an EMPTY map is falsy, so never test it with `or`/`if hot` (that kept it empty forever)
    return _hot if _hot is not None and _hot is not False else None


def hot_status():
    """For /healthz: whether the hot Map is in use and a round trip works."""
    hot = _hot_map()
    if hot is None:
        return {"hot_state": False, "hot_problem": hot_problem or "not on Beam"}
    try:
        hot.set("probe", str(time.time()), ttl=60)
        return {"hot_state": bool(hot.get("probe"))}
    except Exception as error:  # noqa: BLE001
        return {"hot_state": False, "hot_problem": type(error).__name__ + ": " + str(error)[:160]}


def hot_put(key, path, data):
    """Write durable (volume) and hot (Map) copies. The Map write is best effort."""
    atomic_json(path, data)
    hot = _hot_map()
    if hot is not None:
        try:
            hot.set(key, json.dumps(data, ensure_ascii=False), ttl=604_800)
        except Exception as error:  # noqa: BLE001 - the volume copy is still there
            print("hot state write failed:", type(error).__name__, flush=True)


def _stamp(record):
    if not isinstance(record, dict):
        return -1
    return max(float(record.get(name) or 0) for name in ("updated_at", "at", "dispatched_at", "until"))


def hot_get(key, path, default=None):
    """The newer of the Map and volume copies: the Map is fresh across containers, but a failed Map write must not
    let an older Map value shadow a newer durable record."""
    durable = read_json(path, None)
    hot = _hot_map()
    if hot is not None:
        try:
            value = hot.get(key)
            fresh = json.loads(value) if value else None
            if fresh is not None and _stamp(fresh) >= _stamp(durable):
                return fresh
        except Exception as error:  # noqa: BLE001
            print("hot state read failed:", type(error).__name__, flush=True)
    return durable if durable is not None else default


def visible(path, seconds=20):
    """True once a file written by another container shows up here. Waits only on Beam (shared volume lag)."""
    if path.is_file():
        return True
    if not (os.environ.get("RUHUA_STATE_MAP") or (os.environ.get("STUB_ID") and os.environ.get("CONTAINER_ID"))):
        return False
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(.5)
        if path.is_file():
            return True
    return False


def state_path(call_id):
    if not valid_id(call_id):
        raise ValueError("任务编号无效")
    return ROOT / "states" / (call_id + ".json")


def write_state(call_id, status, **fields):
    hot_put("state:" + call_id, state_path(call_id), {"status": status, "updated_at": time.time(), **fields})


def read_state(call_id):
    return hot_get("state:" + call_id, state_path(call_id))


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
        # 世界生成按次花 World Labs 的额度，默认每天最多 6 次；其余默认 30
        limit = int(os.environ.get("RUHUA_DAILY_" + kind.upper(), "6" if kind == "worlds" else "30"))
        if ledger.get(kind, 0) >= limit:
            raise CapacityError("今日体验额度已用完，请明天再试。")
        if kind == "jobs":
            pending = 0
            states = ROOT / "states"
            if states.exists():
                for path in states.glob("*.json"):
                    entry = read_json(path, {}) or {}
                    if entry.get("status") in ("running", "queued") and valid_id(path.stem):
                        entry = read_state(path.stem) or entry  # the volume copy may be stale
                    if entry.get("status") in ("running", "queued"):
                        # Queue deadline + 15-minute task deadline. A stale state
                        # becomes a reported error, never an endless spinner.
                        if now - entry.get("updated_at", 0) > 3600:
                            hot_put("state:" + path.stem, path, {**entry, "status": "error", "updated_at": now,
                                                                 "message": "任务等待或执行超时，请重新提交。"})
                        else:
                            pending += 1
            if pending >= int(os.environ.get("RUHUA_MAX_PENDING", "3")):
                raise CapacityError("当前生成队列已满，请稍后再试。")
            write_state(call_id, "queued", phase="queued", stage="已排队 · 等待 GPU 唤醒", job_id=job_id)
            # A warm-up task holding the GPU container (worker.warm) lets go as soon as it sees real demand
            hot_put("gpu-demand", ROOT / "gpu-demand.json", {"at": now, "call_id": call_id})
        ledger[kind] = ledger.get(kind, 0) + 1
        atomic_json(ledger_path, ledger)
