"""
入画 · 本地 GPU 后端
====================

跟 Modal 版完全相同的三个接口，但跑在你自己的显卡上（RTX 5070）：

  POST /generate            上传照片 -> 返回任务 id
  GET  /status/{call_id}    轮询任务状态
  GET  /file/{job}/{name}   下载 .ply 和 .mp4

前端不用改任何代码，只要把 .env.local 改成：
  NEXT_PUBLIC_MODAL_API=http://localhost:8000
然后重启 npm run dev。

启动本服务（在装好 SHARP 的环境里，见《本地GPU指南.md》）：
  pip install fastapi uvicorn pillow pillow-heif
  python backend/local_server.py
"""

import glob
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parent / "local_jobs"
ROOT.mkdir(exist_ok=True)

# 可选：手动指定权重路径；不设的话 sharp 第一次运行会自动下载并缓存
CKPT = os.environ.get("SHARP_CKPT", "")
MAX_MB = 20

# ---------------------------------------------------------------
# 可选：豆包（火山方舟 Seedream）扩图增强
# 启用方式：启动前设置环境变量 ARK_API_KEY（见《启动入画.bat》）。
# 绝对不要把 key 写进代码、传进 git 或发给别人。
# ---------------------------------------------------------------
ARK_API_KEY = os.environ.get("ARK_API_KEY", "")
ARK_MODEL = os.environ.get("ARK_MODEL", "doubao-seedream-4-0-250828")
ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"

def _ark_i2i(img, prompt: str) -> bytes:
    """Seedream 图生图：输入 PIL 图，返回结果图字节。"""
    import base64
    import io as _io

    import requests

    img = img.convert("RGB")
    img.thumbnail((2048, 2048))
    buf = _io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    b64 = base64.b64encode(buf.getvalue()).decode()
    w, h = img.size
    tw = max(1024, w // 16 * 16)
    th = max(1024, h // 16 * 16)
    resp = requests.post(
        ARK_URL,
        headers={"Authorization": f"Bearer {ARK_API_KEY}"},
        json={
            "model": ARK_MODEL,
            "prompt": prompt,
            "image": f"data:image/jpeg;base64,{b64}",
            "size": f"{tw}x{th}",
            "sequential_image_generation": "disabled",
            "response_format": "url",
            "watermark": False,
        },
        timeout=180,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"豆包接口 {resp.status_code}：{resp.text[:500]}")
    data = resp.json()["data"][0]
    if data.get("url"):
        import requests as _rq

        return _rq.get(data["url"], timeout=120).content
    import base64 as _b64

    return _b64.b64decode(data["b64_json"])


def pad_canvas(img, ratio: float):
    """扩图预处理：原图居中，四周填放大模糊的自身。
    给模型一块"看得见的待补全区域"，远比纯文字提示有效。"""
    from PIL import ImageFilter

    w, h = img.size
    W = int(w * (1 + 2 * ratio)) // 2 * 2
    H = int(h * (1 + 2 * ratio)) // 2 * 2
    bg = img.resize((W, H)).filter(ImageFilter.GaussianBlur(40))
    bg.paste(img, ((W - w) // 2, (H - h) // 2))
    return bg


ENHANCE_PROMPT = (
    "扩展这张照片的画面边界（outpainting）：保持原图区域的内容、构图、人物、"
    "光影与色调完全不变，向四周自然延伸场景各约25%，延伸部分必须与原图的"
    "透视、季节、天气、画质无缝衔接，照片级写实；同时轻微提升整体清晰度与"
    "细节。不要新增显眼物体，不要任何文字或水印。"
)


def ai_enhance(img_path: Path) -> bool:
    """一键增强（旧接口，保留兼容）：扩图画布 + 补全提示词。"""
    if not ARK_API_KEY:
        return False
    from PIL import Image

    img = pad_canvas(Image.open(img_path).convert("RGB"), 0.25)
    img_path.write_bytes(_ark_i2i(img, ENHANCE_PROMPT))
    return True

# 任务表放内存里就够了（重启服务后历史任务查不到，文件还在 local_jobs 里）
jobs: dict[str, dict] = {}

app = FastAPI(title="ruhua-local")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Chrome 从 https 网站访问 localhost 时会做"私有网络"预检，放行它
@app.middleware("http")
async def allow_private_network(request, call_next):
    response = await call_next(request)
    if request.method == "OPTIONS":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


_device_cache: dict[str, str] = {}


@app.get("/healthz")
def healthz():
    """前端用来探测服务是否在线，并显示显卡型号"""
    if "name" not in _device_cache:
        try:
            import torch

            _device_cache["name"] = (
                torch.cuda.get_device_name(0)
                if torch.cuda.is_available()
                else "CPU（未检测到 CUDA）"
            )
        except Exception:
            _device_cache["name"] = "未知设备"
    return {
        "ok": True,
        "device": _device_cache["name"],
        "enhance": bool(ARK_API_KEY),
    }


def run_pipeline(job_id: str, render_video: bool, enhance: bool = False):
    t0 = time.time()
    job_dir = ROOT / job_id
    try:
        # ---- 输入统一转 PNG（兼容 iPhone 的 HEIC）----
        src = next(job_dir.glob("input.*"))
        in_dir, gs_dir, rd_dir = job_dir / "in", job_dir / "gs", job_dir / "rd"
        for d in (in_dir, gs_dir, rd_dir):
            d.mkdir(exist_ok=True)

        from PIL import Image

        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except ImportError:
            pass
        Image.open(src).convert("RGB").save(in_dir / "photo.png")
        Image.open(src).convert("RGB").save(job_dir / "original.jpg", quality=90)

        # ---- 可选：豆包扩图增强（失败自动降级用原图，不报废任务）----
        did_enhance = False
        if enhance:
            try:
                did_enhance = ai_enhance(in_dir / "photo.png")
            except Exception as e:
                print(f"[警告] AI 增强失败，已用原图继续：{e}")

        def run(cmd: list[str], step: str):
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                tail = (r.stderr or r.stdout)[-1200:]
                raise RuntimeError(f"{step} 失败：\n{tail}")

        # ---- SHARP 推理 ----
        cmd = ["sharp", "predict", "-i", str(in_dir), "-o", str(gs_dir)]
        if CKPT:
            cmd += ["-c", CKPT]
        run(cmd, "SHARP 推理")
        plys = glob.glob(str(gs_dir / "**/*.ply"), recursive=True)
        if not plys:
            raise RuntimeError("推理完成但没找到 .ply 输出")
        t1 = time.time()

        # ---- 运镜渲染（需要本机 gsplat 内核可用）----
        # Windows 上没编译 gsplat 时这一步会失败：自动跳过，
        # 照样返回 .ply——网页里的实时运镜不受任何影响。
        mp4 = None
        if render_video:
            try:
                cmd = ["sharp", "render", "-i", str(gs_dir), "-o", str(rd_dir)]
                if CKPT:
                    cmd += ["-c", CKPT]
                run(cmd, "运镜渲染")
                mp4s = glob.glob(str(rd_dir / "**/*.mp4"), recursive=True)
                mp4 = mp4s[0] if mp4s else None
            except Exception as e:
                print(f"[警告] 运镜渲染不可用，已跳过（只返回 3D 场景）：{e}")

        shutil.copy(plys[0], job_dir / "scene.ply")
        if mp4:
            shutil.copy(mp4, job_dir / "camera_move.mp4")

        jobs[job_id] = {
            "status": "done",
            "result": {
                "job_id": job_id,
                "ply_file": "scene.ply",
                "mp4_file": "camera_move.mp4" if mp4 else None,
                "enhanced": did_enhance,
                "predict_seconds": round(t1 - t0, 1),
                "total_seconds": round(time.time() - t0, 1),
            },
        }
    except Exception as e:
        jobs[job_id] = {"status": "error", "message": str(e)[:1500]}


@app.post("/generate")
async def generate(
    image: UploadFile = File(...),
    render_video: bool = Form(True),
    enhance: bool = Form(False),
):
    data = await image.read()
    if len(data) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, f"图片超过 {MAX_MB}MB")

    job_id = uuid.uuid4().hex[:12]
    job_dir = ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(image.filename or "photo.jpg").suffix.lower() or ".jpg"
    (job_dir / f"input{suffix}").write_bytes(data)

    jobs[job_id] = {"status": "running"}
    threading.Thread(
        target=run_pipeline, args=(job_id, render_video, enhance), daemon=True
    ).start()
    # 本地版的 call_id 就是 job_id，跟 Modal 版返回结构保持一致
    return {"call_id": job_id, "job_id": job_id}


@app.get("/status/{call_id}")
def status(call_id: str):
    j = jobs.get(call_id)
    if not j:
        return {"status": "error", "message": "任务不存在（服务可能重启过）"}
    if j["status"] == "done":
        return {"status": "done", **j["result"]}
    return j


@app.post("/edit")
def edit(payload: dict = Body(...)):
    """豆包修图对话：对某个版本的图片执行一次编辑，存为新版本。"""
    if not ARK_API_KEY:
        raise HTTPException(400, "后端未配置 ARK_API_KEY")
    job_id = str(payload.get("job_id", ""))
    prompt = str(payload.get("prompt", "")).strip()
    pad = float(payload.get("pad_ratio", 0) or 0)
    base_name = str(payload.get("base", "")).strip()
    job_dir = ROOT / job_id
    if not job_id or not job_dir.exists():
        raise HTTPException(404, "任务不存在")
    if not prompt:
        raise HTTPException(400, "提示词为空")

    # 多轮上下文：把此前的修改指令拼进提示词，
    # 让模型听得懂"刚才""再""上一次"这类指代
    history = payload.get("history") or []
    if isinstance(history, list) and history:
        hist = "\n".join(
            f"{i + 1}. {str(h)[:120]}" for i, h in enumerate(history[-8:])
        )
        prompt = (
            "以下是用户此前对这张图片的修改指令记录（按顺序，修改效果已体现在"
            "当前输入图中），供你理解\u201c刚才\u201d\u201c再\u201d这类指代：\n"
            f"{hist}\n\n现在请在当前输入图的基础上，执行这条新指令：\n{prompt}"
        )

    from PIL import Image

    edits = sorted(
        job_dir.glob("edit_*.jpg"), key=lambda p: int(p.stem.split("_")[1])
    )
    if (
        base_name
        and re.fullmatch(r"(original\.jpg|edit_\d+\.jpg)", base_name)
        and (job_dir / base_name).exists()
    ):
        src_path = job_dir / base_name
    elif edits:
        src_path = edits[-1]
    elif (job_dir / "original.jpg").exists():
        src_path = job_dir / "original.jpg"
    else:
        src_path = next(job_dir.glob("input.*"))

    img = Image.open(src_path).convert("RGB")
    if pad > 0:
        img = pad_canvas(img, min(pad, 0.5))
    try:
        out = _ark_i2i(img, prompt)
    except Exception as e:
        raise HTTPException(502, f"豆包接口失败：{str(e)[:600]}")
    n = int(edits[-1].stem.split("_")[1]) + 1 if edits else 1
    (job_dir / f"edit_{n}.jpg").write_bytes(out)
    return {"image": f"edit_{n}.jpg"}


def run_rerender(call_id: str, job_id: str, source: str):
    """用某个修图版本重新跑 SHARP，覆盖 scene.ply。"""
    t0 = time.time()
    job_dir = ROOT / job_id
    try:
        in_dir, gs_dir = job_dir / "re_in", job_dir / "re_gs"
        for d in (in_dir, gs_dir):
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True, exist_ok=True)
        from PIL import Image

        Image.open(job_dir / source).convert("RGB").save(in_dir / "photo.png")
        cmd = ["sharp", "predict", "-i", str(in_dir), "-o", str(gs_dir)]
        if CKPT:
            cmd += ["-c", CKPT]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout)[-1200:])
        plys = glob.glob(str(gs_dir / "**/*.ply"), recursive=True)
        if not plys:
            raise RuntimeError("重新推理完成但没找到 .ply")
        shutil.copy(plys[0], job_dir / "scene.ply")
        jobs[call_id] = {
            "status": "done",
            "result": {
                "job_id": job_id,
                "ply_file": "scene.ply",
                "mp4_file": None,
                "enhanced": True,
                "total_seconds": round(time.time() - t0, 1),
            },
        }
    except Exception as e:
        jobs[call_id] = {"status": "error", "message": str(e)[:1500]}


@app.post("/rerender")
def rerender(payload: dict = Body(...)):
    job_id = str(payload.get("job_id", ""))
    source = str(payload.get("source", ""))
    job_dir = ROOT / job_id
    if not job_dir.exists():
        raise HTTPException(404, "任务不存在")
    if not re.fullmatch(r"(original\.jpg|edit_\d+\.jpg)", source) or not (
        job_dir / source
    ).exists():
        raise HTTPException(400, "图片版本无效")
    call_id = uuid.uuid4().hex[:12]
    jobs[call_id] = {"status": "running"}
    threading.Thread(
        target=run_rerender, args=(call_id, job_id, source), daemon=True
    ).start()
    return {"call_id": call_id}


@app.get("/file/{job_id}/{filename}")
def file(job_id: str, filename: str):
    ok_names = ("scene.ply", "camera_move.mp4", "original.jpg")
    if filename not in ok_names and not re.fullmatch(r"edit_\d+\.jpg", filename):
        raise HTTPException(404)
    path = ROOT / job_id / filename
    if not path.exists():
        raise HTTPException(404, "文件不存在或还没生成完")
    media = (
        "video/mp4" if filename.endswith(".mp4")
        else "image/jpeg" if filename.endswith(".jpg")
        else "application/octet-stream"
    )
    return FileResponse(path, media_type=media, filename=filename)


if __name__ == "__main__":
    print("入画 · 本地后端启动：http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
