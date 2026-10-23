"""The only module that runs SHARP on GPU. All I/O routes stay on CPU."""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from storage import IMAGE_PATTERN, ROOT, hot_get, job_path, read_state, valid_id, visible, write_state

# ---- Resident model (sharp_server.py) ----
# Beam keeps this worker process alive for every task the container runs, so the model server started by
# the first task (or by a warm-up task, see warm()) serves the following ones without reloading.
# Any failure falls back to the original one-process-per-photo CLI path (run_sharp.py).
_server = None
_server_lines = None
_server_ready = None
_server_lock = threading.Lock()


def sharp_interpreter():
    # Use the same interpreter as the installed sharp console script;
    # Beam's runner and a custom conda image can have different Pythons.
    interpreter = sys.executable
    executable = shutil.which("sharp")
    if executable:
        with open(executable, "rb") as launcher:
            shebang = launcher.readline(4096).decode("utf-8", errors="ignore").strip()
        if shebang.startswith("#!/") and Path(shebang[2:]).is_file():
            interpreter = shebang[2:]
    return interpreter


def start_model_server():
    """Start the resident model if it is not running. Returns immediately; the model loads in the background."""
    global _server, _server_lines, _server_ready
    with _server_lock:
        if _server is not None and _server.poll() is None:
            return
        for cache_name in ("TORCH_HOME", "HF_HOME", "TORCH_EXTENSIONS_DIR"):
            if os.environ.get(cache_name):
                Path(os.environ[cache_name]).mkdir(parents=True, exist_ok=True)
        _server_ready = None
        _server_lines = queue.Queue()
        _server = subprocess.Popen([sharp_interpreter(), str(Path(__file__).with_name("sharp_server.py"))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
                                   cwd=str(Path(__file__).resolve().parent))

        def pump(process, lines):
            for line in process.stdout:
                lines.put(line.rstrip("\n"))
            lines.put(None)

        threading.Thread(target=pump, args=(_server, _server_lines), daemon=True).start()


def _next_line(timeout):
    try:
        return _server_lines.get(timeout=max(.1, timeout))
    except queue.Empty:
        return ""


def wait_model_server(timeout=420):
    """Block until the resident model has loaded. Returns its load timings, or None if it failed."""
    global _server_ready
    start_model_server()
    if _server_ready is not None:
        return _server_ready
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = _next_line(deadline - time.time())
        if line is None or (line and line.startswith("FAILED")):
            print("Resident model unavailable:", (line or "exited")[:300], flush=True)
            stop_model_server()
            return None
        if line and line.startswith("READY "):
            _server_ready = json.loads(line[6:])
            print("Resident model ready:", json.dumps(_server_ready), flush=True)
            return _server_ready
    print("Resident model did not load in time", flush=True)
    stop_model_server()
    return None


def stop_model_server():
    global _server, _server_ready
    with _server_lock:
        if _server is not None and _server.poll() is None:
            _server.kill()
        _server, _server_ready = None, None


def predict_resident(request, timeout=300):
    """Run one photo on the resident model. Returns False (and stops it) if anything goes wrong, so the caller
    falls back to the CLI. Budgets keep load + run + CLI fallback inside the 900 s task limit."""
    try:
        if wait_model_server(240) is None:
            return False
        _server.stdin.write(json.dumps(request) + "\n")
        _server.stdin.flush()
    except Exception as error:  # noqa: BLE001 - any launch/pipe failure means "use the CLI"
        print("Resident model unavailable, falling back to the CLI:", type(error).__name__, flush=True)
        stop_model_server()
        return False
    line = _next_line(timeout)
    if line and line.startswith("RESULT "):
        return True
    print("Resident model failed, falling back to the CLI:", (line or "no reply")[:300], flush=True)
    stop_model_server()
    return False


def on_start():
    """Beam on_start: begin loading the model as soon as the container boots (does not block)."""
    try:
        start_model_server()
    except OSError as error:
        print("Resident model could not start:", type(error).__name__, flush=True)


# ---- Warm-up ----
# The gateway dispatches a warm-up task as soon as a visitor opens the create page or picks a photo
# (gateway.py /warm). It boots the GPU container and loads the model while the photo is still being
# chosen and uploaded, then holds the container until the real task is admitted (the gateway writes
# gpu-demand.json) or the warm window (gpu-warm.json "until", extended by later /warm calls) ends.
WARM_LIMIT = 600


def warm(call_id):
    state = read_state(call_id)
    if not state or state.get("status") != "warming":
        raise ValueError("Warm-up was not admitted by the gateway")
    started = time.time()
    ready = wait_model_server()
    write_state(call_id, "warm", ready=bool(ready), load=ready, started_at=state.get("updated_at"))
    while time.time() - started < WARM_LIMIT:
        demand = hot_get("gpu-demand", ROOT / "gpu-demand.json", {}) or {}
        if demand.get("at", 0) >= state.get("updated_at", started) - 5:
            break
        window = hot_get("gpu-warm", ROOT / "gpu-warm.json", {}) or {}
        if time.time() >= window.get("until", 0):
            break
        time.sleep(.5)
    write_state(call_id, "done", warm=True, ready=bool(ready), held_seconds=round(time.time() - started, 1))
    return {"warm": True, "ready": bool(ready)}


def process(call_id, job_id, source="original.jpg", render_video=False, enhanced=False):
    if not valid_id(call_id) or not IMAGE_PATTERN.fullmatch(source):
        raise ValueError("Invalid task input")
    directory = job_path(job_id)
    # Reject arbitrary invocations and duplicate delivery of completed work. The gateway wrote the state a moment
    # ago; read_state goes through the hot Map, and the photo on the shared volume can take a few seconds to show up here.
    state = read_state(call_id)
    deadline = time.time() + 45
    while (not state or not visible(directory / source, 1)) and time.time() < deadline:
        time.sleep(.5)
        state = read_state(call_id)
    if not state or state.get("job_id") != job_id:
        raise ValueError("Task was not admitted by the gateway")
    if state.get("status") == "done":
        return state
    started = time.time()
    try:
        # A container that was not warmed up still has to load the model (about 45 s); say so instead of "reconstructing"
        loading = _server_ready is None
        write_state(call_id, "running", phase="model_load" if loading else "predicting",
                    stage="云端 GPU 已就绪 · 正在载入模型" if loading else "正在重建三维场景", job_id=job_id)
        for cache_name in ("TORCH_HOME", "HF_HOME", "TORCH_EXTENSIONS_DIR"):
            if os.environ.get(cache_name):
                Path(os.environ[cache_name]).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ruhua-") as temporary:
            work = Path(temporary)
            inputs, gaussians, renders = work / "in", work / "gs", work / "rd"
            for folder in (inputs, gaussians, renders):
                folder.mkdir()
            from PIL import Image
            with Image.open(directory / source) as image:
                image.convert("RGB").save(inputs / "photo.png")

            def run(command, timeout):
                result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
                if result.returncode:
                    # Only server logs receive internal paths and diagnostic text.
                    print((result.stderr or result.stdout)[-2000:], flush=True)
                    raise RuntimeError("模型处理失败，请稍后重试。")

            timing_path = work / "timings.json"
            preview_path = work / "preview.splat"
            # Resident model first (already loaded when a warm-up or an earlier task ran in this container);
            # the original CLI path is kept as the fallback and produces the same files.
            if not predict_resident({"call_id": call_id, "job_id": job_id, "input": str(inputs), "output": str(gaussians),
                                     "timings": str(timing_path), "preview": str(preview_path)}):
                for stale in (timing_path, preview_path):
                    stale.unlink(missing_ok=True)
                for leftover in gaussians.glob("*"):
                    leftover.unlink()
                command = [sharp_interpreter(), str(Path(__file__).with_name("run_sharp.py")),
                           "-i", str(inputs), "-o", str(gaussians),
                           "--call-id", call_id, "--job-id", job_id, "--timings", str(timing_path),
                           "--preview-output", str(preview_path)]
                checkpoint = os.environ.get("SHARP_CKPT")
                if checkpoint:
                    command += ["-c", checkpoint]
                run(command, max(60, int(840 - (time.time() - started))))
            timing_data = json.loads(timing_path.read_text(encoding="utf-8")) if timing_path.is_file() else {}
            ply = next(gaussians.rglob("*.ply"), None)
            if not ply:
                raise RuntimeError("未生成 3D 场景，请换一张照片重试。")
            fast_preview = timing_data.get("preview", {})
            predict_seconds = max(0, time.time() - started - fast_preview.get("preview_seconds", 0))
            # Versioned outputs keep existing viewing sessions and cached URLs valid.
            ply_name = "scene_" + call_id + ".ply"
            shutil.copyfile(ply, directory / (ply_name + ".tmp"))
            os.replace(directory / (ply_name + ".tmp"), directory / ply_name)
            viewer_name = None
            preview_stats = {}
            try:
                from preview import convert_ply_to_splat
                write_state(call_id, "running", phase="preparing_preview", stage="正在优化场景加载", job_id=job_id)
                viewer_name = "scene_" + call_id + ".splat"
                if (fast_preview and preview_path.is_file()
                        and preview_path.stat().st_size == fast_preview.get("splat_count", 0) * 32):
                    copy_started = time.perf_counter()
                    shutil.copyfile(preview_path, directory / (viewer_name + ".tmp"))
                    os.replace(directory / (viewer_name + ".tmp"), directory / viewer_name)
                    preview_stats = {**fast_preview, "preview_seconds": round(fast_preview["preview_seconds"] + time.perf_counter() - copy_started, 3)}
                else:
                    preview_stats = convert_ply_to_splat(ply, directory / viewer_name)
            except (OSError, ValueError, OverflowError) as error:
                print("Optional browser preview unavailable:", type(error).__name__, flush=True)
                viewer_name = None
            mp4_name = None
            warning = None
            if render_video:
                write_state(call_id, "running", phase="rendering", stage="正在渲染视频", job_id=job_id)
                try:
                    run(["sharp", "render", "-i", str(gaussians), "-o", str(renders)],
                        max(30, int(840 - (time.time() - started))))
                    mp4 = next(renders.rglob("*.mp4"), None)
                    if mp4:
                        mp4_name = "camera_" + call_id + ".mp4"
                        shutil.copyfile(mp4, directory / (mp4_name + ".tmp"))
                        os.replace(directory / (mp4_name + ".tmp"), directory / mp4_name)
                    else:
                        warning = "视频未生成；3D 场景可正常使用并在浏览器中导出视频。"
                except Exception as error:
                    print("Optional video rendering failed:", type(error).__name__, flush=True)
                    warning = "视频渲染暂不可用；3D 场景已完成，可在浏览器中导出视频。"
            result = dict(job_id=job_id, ply_file=ply_name, mp4_file=mp4_name,
                          enhanced=enhanced, predict_seconds=round(predict_seconds, 1),
                          total_seconds=round(time.time() - started, 1))
            if viewer_name:
                result.update(viewer_file=viewer_name, **preview_stats)
            if timing_data:
                result.update(timings=timing_data.get("seconds", {}), runtime=timing_data.get("runtime", {}))
            if warning:
                result["warning"] = warning
            write_state(call_id, "done", **result)
            return result
    except Exception as error:
        print("SHARP task failed:", type(error).__name__, str(error)[:500], flush=True)
        message = "生成超时，请稍后重试。" if isinstance(error, subprocess.TimeoutExpired) else str(error)
        if not isinstance(error, (RuntimeError, subprocess.TimeoutExpired)):
            message = "生成失败，请重试或换一张照片。"
        write_state(call_id, "error", job_id=job_id, message=message[:300])
        return {"status": "error", "message": message[:300]}
