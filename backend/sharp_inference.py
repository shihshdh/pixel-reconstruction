"""
入画 · Modal GPU 后端
=====================

把 Apple ml-sharp 包装成三个 HTTP 接口：

  POST /generate            上传照片 -> 返回任务 id（立刻返回，不阻塞）
  GET  /status/{call_id}    轮询任务状态 -> 完成后返回文件名
  GET  /file/{job}/{name}   下载生成的 .ply 和 .mp4

部署（在项目根目录执行）：
    modal deploy backend/sharp_inference.py

部署成功后终端会打印一个 URL，长这样：
    https://你的workspace--sharp-web-api.modal.run
把它填进前端的 .env.local 里（NEXT_PUBLIC_MODAL_API）。

第一次部署要构建镜像（装 CUDA 环境 + 下载 1.4GB 模型权重），
大概 10~20 分钟，之后再 deploy 都是秒级。
"""

import modal

# ---------------------------------------------------------------
# 1. GPU 镜像：CUDA 12.4 + ml-sharp + 模型权重
# ---------------------------------------------------------------
# 用 nvidia 的 devel 镜像是因为里面带 nvcc 编译器，
# gsplat（运镜渲染器）安装时需要它来编译 CUDA kernel。
# TORCH_CUDA_ARCH_LIST=8.6 对应 A10G 显卡，提前指定，
# 让编译发生在"构建镜像"这一次，而不是每次冷启动。
gpu_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11"
    )
    .apt_install("git", "wget", "ffmpeg", "libgl1", "libglib2.0-0")
    .env({"TORCH_CUDA_ARCH_LIST": "8.6"})
    .run_commands(
        # 安装顺序有讲究：先 torch，再带着 nvcc 编译 gsplat（烤进镜像），
        # 最后装 ml-sharp（它的 gsplat 依赖此时已满足，不会重复构建）
        "pip install torch==2.8.0 torchvision==0.23.0",
        "pip install ninja",
        "pip install gsplat==1.5.3 --no-build-isolation",
        "git clone --depth 1 https://github.com/apple/ml-sharp /opt/ml-sharp",
        "pip install /opt/ml-sharp",
    )
    .pip_install("pillow", "pillow-heif")  # 兼容 iPhone 的 HEIC 照片
    # 把 1.4GB 权重直接烤进镜像，免得每次冷启动重新下载
    .run_commands(
        "wget -q https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
        " -O /opt/sharp_ckpt.pt"
    )
)

# API 调度层用轻量镜像就够了（它不跑模型，只收发请求）
api_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]"
)

# 结果存储：一块云端硬盘，GPU 写、API 读
results_vol = modal.Volume.from_name("sharp-results", create_if_missing=True)
RESULTS_DIR = "/results"
CKPT = "/opt/sharp_ckpt.pt"

app = modal.App("sharp-web")


# ---------------------------------------------------------------
# 2. 核心任务：照片 -> 高斯 .ply -> 运镜 .mp4
# ---------------------------------------------------------------
@app.function(
    image=gpu_image,
    gpu="A10G",
    timeout=1500,           # 给首次 gsplat 编译留足余量
    scaledown_window=300,   # 闲置 5 分钟才关机，连续生成不用反复冷启动
    volumes={RESULTS_DIR: results_vol},
)
def process(job_id: str, render_video: bool = True) -> dict:
    import glob
    import shutil
    import subprocess
    import time
    from pathlib import Path

    t0 = time.time()
    job_dir = Path(RESULTS_DIR) / job_id
    results_vol.reload()  # 同步到最新，确保能看到 API 刚写入的照片

    # ---- 2.1 整理输入：任何格式统一转成 PNG ----
    src = next(job_dir.glob("input.*"), None)
    if src is None:
        raise RuntimeError(f"任务 {job_id} 找不到输入图片")

    work = Path("/tmp/work")
    in_dir, gs_dir, rd_dir = work / "in", work / "gs", work / "rd"
    for d in (in_dir, gs_dir, rd_dir):
        d.mkdir(parents=True, exist_ok=True)

    from PIL import Image
    import pillow_heif

    pillow_heif.register_heif_opener()
    Image.open(src).convert("RGB").save(in_dir / "photo.png")

    def run(cmd: list[str], step: str):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout)[-1200:]
            raise RuntimeError(f"{step} 失败：\n{tail}")

    # ---- 2.2 SHARP 推理：一张照片 -> 3D 高斯点云 ----
    run(
        ["sharp", "predict", "-i", str(in_dir), "-o", str(gs_dir), "-c", CKPT],
        "SHARP 推理",
    )
    plys = glob.glob(str(gs_dir / "**/*.ply"), recursive=True)
    if not plys:
        raise RuntimeError("推理完成但没找到 .ply 输出")
    predict_done = time.time()

    # ---- 2.3 运镜渲染：沿相机轨迹渲染成 mp4（gsplat，需要 CUDA）----
    mp4 = None
    if render_video:
        run(
            ["sharp", "render", "-i", str(gs_dir), "-o", str(rd_dir), "-c", CKPT],
            "运镜渲染",
        )
        mp4s = glob.glob(str(rd_dir / "**/*.mp4"), recursive=True)
        mp4 = mp4s[0] if mp4s else None

    # ---- 2.4 把成果写回云端硬盘 ----
    shutil.copy(plys[0], job_dir / "scene.ply")
    if mp4:
        shutil.copy(mp4, job_dir / "camera_move.mp4")
    results_vol.commit()

    return {
        "job_id": job_id,
        "ply_file": "scene.ply",
        "mp4_file": "camera_move.mp4" if mp4 else None,
        "predict_seconds": round(predict_done - t0, 1),
        "total_seconds": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------
# 3. HTTP 接口层（FastAPI），前端直接调这里
# ---------------------------------------------------------------
@app.function(image=api_image, volumes={RESULTS_DIR: results_vol})
@modal.asgi_app()
def api():
    import uuid
    from pathlib import Path

    from fastapi import FastAPI, File, Form, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse

    web = FastAPI(title="ruhua-api")
    web.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # 个人项目先全放开，正式上线可以收紧到你的域名
        allow_methods=["*"],
        allow_headers=["*"],
    )

    MAX_MB = 20

    @web.get("/healthz")
    def healthz():
        return {"ok": True, "device": "Modal · A10G"}

    @web.post("/generate")
    async def generate(
        image: UploadFile = File(...),
        render_video: bool = Form(True),
    ):
        data = await image.read()
        if len(data) > MAX_MB * 1024 * 1024:
            raise HTTPException(413, f"图片超过 {MAX_MB}MB")

        job_id = uuid.uuid4().hex[:12]
        suffix = Path(image.filename or "photo.jpg").suffix.lower() or ".jpg"
        job_dir = Path(RESULTS_DIR) / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / f"input{suffix}").write_bytes(data)
        results_vol.commit()  # 让 GPU 容器能看到这张图

        call = process.spawn(job_id, render_video)
        return {"call_id": call.object_id, "job_id": job_id}

    @web.get("/status/{call_id}")
    def status(call_id: str):
        fc = modal.FunctionCall.from_id(call_id)
        try:
            result = fc.get(timeout=0)
            return {"status": "done", **result}
        except TimeoutError:
            return {"status": "running"}
        except Exception as e:  # 任务内部报错会在这里冒出来
            return {"status": "error", "message": str(e)[:1500]}

    @web.get("/file/{job_id}/{filename}")
    def file(job_id: str, filename: str):
        if filename not in ("scene.ply", "camera_move.mp4"):
            raise HTTPException(404)
        results_vol.reload()
        path = Path(RESULTS_DIR) / job_id / filename
        if not path.exists():
            raise HTTPException(404, "文件不存在或还没生成完")
        media = "video/mp4" if filename.endswith(".mp4") else "application/octet-stream"
        return FileResponse(path, media_type=media, filename=filename)

    return web
