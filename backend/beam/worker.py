"""The only module that runs SHARP on GPU. All I/O routes stay on CPU."""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from storage import IMAGE_PATTERN, job_path, read_state, valid_id, write_state


def process(call_id, job_id, source="original.jpg", render_video=False, enhanced=False):
    if not valid_id(call_id) or not IMAGE_PATTERN.fullmatch(source):
        raise ValueError("Invalid task input")
    directory = job_path(job_id)
    # Reject arbitrary invocations and duplicate delivery of completed work.
    state = read_state(call_id)
    if not state or state.get("job_id") != job_id:
        raise ValueError("Task was not admitted by the gateway")
    if state.get("status") == "done":
        return state
    started = time.time()
    try:
        write_state(call_id, "running", phase="predicting", stage="正在重建三维场景", job_id=job_id)
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

            # Use the same interpreter as the installed sharp console script;
            # Beam's runner and a custom conda image can have different Pythons.
            interpreter = sys.executable
            executable = shutil.which("sharp")
            if executable:
                with open(executable, "rb") as launcher:
                    shebang = launcher.readline(4096).decode("utf-8", errors="ignore").strip()
                if shebang.startswith("#!/") and Path(shebang[2:]).is_file():
                    interpreter = shebang[2:]
            timing_path = work / "timings.json"
            preview_path = work / "preview.splat"
            command = [interpreter, str(Path(__file__).with_name("run_sharp.py")),
                       "-i", str(inputs), "-o", str(gaussians),
                       "--call-id", call_id, "--job-id", job_id, "--timings", str(timing_path),
                       "--preview-output", str(preview_path)]
            checkpoint = os.environ.get("SHARP_CKPT")
            if checkpoint:
                command += ["-c", checkpoint]
            run(command, 720)
            import json
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
