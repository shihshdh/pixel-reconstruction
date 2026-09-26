"""Pixel Reconstruction · 本机显卡引擎（Windows 客户端专用）。

客户端启动时在后台拉起本进程，只监听 127.0.0.1。HTTP 接口直接复用 Beam 网关
（gateway.py）的代码：任务 Token、签名下载链接、状态、文件、修图完全一致，前端不用
区分两种后端。唯一的区别是 dispatch：Beam 把任务送进云端 GPU 队列，这里送进本机
队列，由常驻显存的 SHARP 模型处理——模型只在引擎启动时载入一次，之后每张照片
只需要推理本身的几秒钟。

    python engine.py --port 47821 --data <任务目录> --parent-pid <客户端进程号>

客户端启动时传入自己的进程号（--parent-pid）：客户端退出（包括被强制结束）时引擎随之退出，
不会留下占着显存的孤儿进程。
"""
import argparse
import os
import queue
import secrets
import sys
import threading
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 打包后 Beam 模块和本文件在同一目录；开发时在 ../beam。
for candidate in (HERE, HERE.parent / "beam"):
    if (candidate / "gateway.py").is_file():
        sys.path.insert(0, str(candidate))
        break

ENGINE_NAME = "pixel-reconstruction-local-engine"
ALLOWED_ORIGINS = {
    "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
    "http://localhost:3000", "http://127.0.0.1:3000",
}
CHECKPOINT_NAME = "sharp_2572gikvuh.pt"
# 实测 RTX 5070 Ti 笔记本（12GB）推理时显存占用约 3.6GB（含 PyTorch 缓存），留出余量。
MIN_MEMORY_GB = 6
CHECKPOINT_URL = "https://ml-site.cdn-apple.com/models/sharp/" + CHECKPOINT_NAME


def configure_environment(data):
    """必须在导入 gateway/storage/security 之前设置：这些模块在导入时读取环境变量。"""
    data.mkdir(parents=True, exist_ok=True)
    os.environ["RUHUA_DATA"] = str(data)
    # security.py 用这个变量派生下载链接的签名密钥。本机没有 Beam 账户，
    # 这里是一个只存在于本机数据目录的随机密钥，重启后保持不变，旧链接仍可刷新。
    secret_path = data / "signing.key"
    if not secret_path.is_file():
        secret_path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    os.environ["BEAM_API_TOKEN"] = secret_path.read_text(encoding="utf-8").strip()
    # 本机算力不设每日额度；队列只保留少量任务，避免误触连点堆积。
    os.environ["RUHUA_DAILY_JOBS"] = "1000000"
    os.environ["RUHUA_DAILY_EDITS"] = "1000000"
    os.environ["RUHUA_MAX_PENDING"] = "4"
    cache = data / "cache"
    os.environ.setdefault("TORCH_EXTENSIONS_DIR", str(cache / "torch-extensions"))


class Engine:
    """一个 GPU、一个工作线程、一个常驻模型。"""

    def __init__(self):
        self.tasks = queue.Queue()
        self.phase = "loading"  # loading | ready | error
        self.message = "正在载入模型"
        self.device = ""
        self.memory_gb = 0.0
        self.load_seconds = 0.0
        self.predictor = None
        threading.Thread(target=self._run, name="gpu-worker", daemon=True).start()

    # ---- 模型 ----
    def _load(self):
        started = time.perf_counter()
        import importlib
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("NO_GPU：没有检测到可用的 NVIDIA 显卡（CUDA）")
        properties = torch.cuda.get_device_properties(0)
        self.device = properties.name
        self.memory_gb = round(properties.total_memory / 1024 ** 3, 1)
        if self.memory_gb < MIN_MEMORY_GB:
            # 显存太小的卡（多为入门独显）跑 1536 输入的模型会爆显存，交给云端。
            raise RuntimeError(f"NO_GPU：{self.device} 只有 {self.memory_gb}GB 显存，至少需要 {MIN_MEMORY_GB}GB")
        self.torch = torch
        self.predict = importlib.import_module("sharp.cli.predict")
        self.gaussians = importlib.import_module("sharp.utils.gaussians")
        self.io = importlib.import_module("sharp.utils.io")
        # 与 Beam 相同的 PLY 向量化写出：先做字节一致性自检，不一致就保留原实现。
        try:
            from run_sharp import patch_export
            self.vectorized_ply = patch_export(self.gaussians, self.predict)
        except Exception:
            self.vectorized_ply = False
        self.message = "正在载入模型权重"
        checkpoint = os.environ.get("SHARP_CKPT", "")
        if not checkpoint:
            cached = Path(torch.hub.get_dir()) / "checkpoints" / CHECKPOINT_NAME
            checkpoint = str(cached) if cached.is_file() else ""
        if checkpoint:
            state = torch.load(checkpoint, weights_only=True, map_location="cpu")
        else:
            self.message = "首次使用，正在下载模型权重（约 2.6GB）"
            state = torch.hub.load_state_dict_from_url(CHECKPOINT_URL, progress=False, map_location="cpu")
        predictor = self.predict.create_predictor(self.predict.PredictorParams())
        predictor.load_state_dict(state)
        del state
        self.predictor = predictor.eval().to("cuda")
        # 预热：第一次推理要载入 CUDA 内核、选卷积算法，实测多花约 15–30 秒。
        # 在后台用一张空白图先跑一遍，用户的第一张照片就是正常速度。预热期间提交的任务照常排队。
        self.message = "正在预热显卡"
        import numpy as np
        blank = np.zeros((512, 768, 3), dtype=np.uint8)
        self.predict.predict_image(self.predictor, blank, 600.0, torch.device("cuda"))
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        self.load_seconds = round(time.perf_counter() - started, 1)
        self.phase, self.message = "ready", "本机显卡已就绪"
        print(f"[engine] 模型已载入 {self.device}，用时 {self.load_seconds}s", flush=True)

    def _run(self):
        try:
            self._load()
        except Exception as error:
            traceback.print_exc()
            self.phase = "error"
            self.message = str(error)[:300] or "模型载入失败"
        while True:
            call_id, job_id, source, render_video, enhanced = self.tasks.get()
            from storage import write_state
            if self.phase != "ready":
                write_state(call_id, "error", job_id=job_id, message="本机显卡引擎不可用：" + self.message)
                continue
            try:
                self._process(call_id, job_id, source, render_video, enhanced)
            except Exception as error:
                traceback.print_exc()
                message = "显存不足，请关闭占用显卡的程序后重试。" if "out of memory" in str(error).lower() else "本机生成失败，请重试或换一张照片。"
                write_state(call_id, "error", job_id=job_id, message=message)
            finally:
                try:
                    self.torch.cuda.empty_cache()
                except Exception:
                    pass

    # ---- 单个任务：与 worker.py 的产物、文件名、状态字段一致 ----
    def _process(self, call_id, job_id, source, render_video, enhanced):
        import shutil
        import tempfile
        from PIL import Image
        from preview import convert_ply_to_splat
        from storage import job_path, write_state
        torch = self.torch
        started = time.time()
        directory = job_path(job_id)
        seconds = {}

        def stage(phase, label):
            write_state(call_id, "running", job_id=job_id, phase=phase, stage=label, timings=dict(seconds))

        def mark(name, since):
            torch.cuda.synchronize()
            seconds[name + "_seconds"] = round(time.perf_counter() - since, 3)
            return time.perf_counter()

        with tempfile.TemporaryDirectory(prefix="ruhua-local-") as temporary:
            work = Path(temporary)
            stage("image_load", "正在读取照片")
            clock = time.perf_counter()
            photo = work / "photo.png"
            with Image.open(directory / source) as image:
                image.convert("RGB").save(photo)
            image, _, f_px = self.io.load_rgb(photo)
            height, width = image.shape[:2]
            clock = mark("image_load", clock)
            stage("inference", "正在用本机显卡重建三维场景")
            gaussians = self.predict.predict_image(self.predictor, image, f_px, torch.device("cuda"))
            clock = mark("inference", clock)
            stage("ply_write", "正在写出三维场景")
            ply = work / "scene.ply"
            self.predict.save_ply(gaussians, f_px, (height, width), ply)
            clock = mark("ply_write", clock)
            predict_seconds = time.time() - started

            ply_name = "scene_" + call_id + ".ply"
            shutil.copyfile(ply, directory / (ply_name + ".tmp"))
            os.replace(directory / (ply_name + ".tmp"), directory / ply_name)

            stage("preparing_preview", "正在优化场景加载")
            viewer_name, preview_stats = "scene_" + call_id + ".splat", {}
            try:
                preview_stats = convert_ply_to_splat(ply, directory / viewer_name, fast=True)
            except (OSError, ValueError, OverflowError) as error:
                print("[engine] 预览转换失败：", type(error).__name__, flush=True)
                viewer_name = None

            mp4_name, warning = None, None
            if render_video:
                stage("rendering", "正在用本机显卡渲染视频")
                try:
                    metadata = self.gaussians.SceneMetaData(float(f_px), (width, height), "linearRGB")
                    video = work / "camera.mp4"
                    self.predict.render_gaussians(gaussians, metadata, video)
                    if video.is_file():
                        mp4_name = "camera_" + call_id + ".mp4"
                        shutil.copyfile(video, directory / (mp4_name + ".tmp"))
                        os.replace(directory / (mp4_name + ".tmp"), directory / mp4_name)
                except Exception as error:
                    print("[engine] 视频渲染失败：", type(error).__name__, str(error)[:300], flush=True)
                if not mp4_name:
                    warning = "视频渲染暂不可用；3D 场景已完成，可在工作室中导出视频。"
            del gaussians

        result = dict(job_id=job_id, ply_file=ply_name, mp4_file=mp4_name, enhanced=enhanced,
                      predict_seconds=round(predict_seconds, 1), total_seconds=round(time.time() - started, 1),
                      timings=seconds, compute="local",
                      runtime={"device": self.device, "vectorized_ply": self.vectorized_ply,
                               "torch_version": torch.__version__})
        if viewer_name:
            result.update(viewer_file=viewer_name, **preview_stats)
        if warning:
            result["warning"] = warning
        write_state(call_id, "done", **result)
        print(f"[engine] 完成 {call_id[:8]}：{result['total_seconds']}s {seconds}", flush=True)


def create_app(engine):
    import gateway
    import transfer
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse
    from starlette.middleware.cors import CORSMiddleware

    def dispatch(call_id, job_id, source="original.jpg", render_video=False, enhanced=False):
        if engine.phase == "error":
            raise HTTPException(503, "本机显卡引擎不可用：" + engine.message)
        engine.tasks.put((call_id, job_id, source, render_video, enhanced))
        return call_id

    # gateway 的路由在调用时才查这些模块级名字，替换即生效。
    gateway.dispatch = dispatch
    gateway.allow_upload = lambda *args, **kwargs: True
    # 回环地址上压缩只会多花 CPU：直接发送原始 .splat（前端本来就支持回退）。
    transfer.accepts_transfer = lambda accept: False

    app = gateway.create_app()
    # 助手聊天与健康检查不走本机：前者只在云端有密钥，后者换成本机状态。
    app.router.routes = [route for route in app.router.routes
                         if getattr(route, "path", "") not in ("/healthz", "/assist")]

    @app.get("/healthz")
    def healthz():
        return {"ok": engine.phase == "ready", "engine": ENGINE_NAME, "local": True,
                "phase": engine.phase, "message": engine.message,
                "device": engine.device, "memory_gb": engine.memory_gb,
                "load_seconds": engine.load_seconds, "queued": engine.tasks.qsize(),
                "enhance": bool(os.environ.get("ARK_API_KEY"))}

    @app.middleware("http")
    async def local_origin_only(request, call_next):
        # 浏览器跨域请求必带 Origin：只接受客户端自己的页面，别的网站无法借用本机显卡。
        origin = request.headers.get("origin")
        if origin and origin not in ALLOWED_ORIGINS:
            return JSONResponse(status_code=403, content={"detail": "只接受 Pixel Reconstruction 客户端的请求。"})
        return await call_next(request)

    app.add_middleware(CORSMiddleware, allow_origins=sorted(ALLOWED_ORIGINS), allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Ruhua-Token", "Accept", "Range"],
                       expose_headers=["Content-Length", "Content-Type", "Content-Range", "ETag"], max_age=600)
    app.add_middleware(PrivateNetworkPreflight)  # 最外层：CORS 预检在这里补上私有网络许可
    return app


class PrivateNetworkPreflight:
    """WebView2 从客户端页面访问 127.0.0.1 时会做私有网络预检，需要显式放行。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "OPTIONS":
            return await self.app(scope, receive, send)

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), (b"access-control-allow-private-network", b"true")]
            await send(message)

        await self.app(scope, receive, send_with_header)


def watch_parent(pid):
    """等客户端进程结束后退出。

    不用 stdin 管道判断：Windows 上后台线程阻塞读管道会卡住 uvicorn 启动（实测）。
    WaitForSingleObject 经 ctypes 调用时释放 GIL，不影响其他线程。
    """
    import ctypes
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if handle:
        kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
    os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=47821)
    parser.add_argument("--data", required=True)
    parser.add_argument("--parent-pid", type=int, default=0, help="客户端进程号；它结束时引擎退出")
    arguments = parser.parse_args()
    configure_environment(Path(arguments.data))
    if arguments.parent_pid and os.name == "nt":
        threading.Thread(target=watch_parent, args=(arguments.parent_pid,), daemon=True).start()
    engine = Engine()
    import uvicorn
    print(f"[engine] 监听 http://127.0.0.1:{arguments.port}", flush=True)
    uvicorn.run(create_app(engine), host="127.0.0.1", port=arguments.port, log_level="warning",
                access_log=False)


if __name__ == "__main__":
    main()
