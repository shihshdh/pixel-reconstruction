"""CPU-only HTTP API. Uploading, editing, polling and downloading never wake GPU."""
import base64
import io
import json
import os
import re
import time
import uuid

import requests
from fastapi import Body, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

from storage import (CapacityError, IMAGE_PATTERN, job_path, read_state,
                     reserve, valid_id, write_state)
from security import (AccessDenied, FILE_PATTERN, SigningUnavailable, allow_upload,
                      authorize, authorize_file, create_access, get_urls)

MAX_BYTES = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000
OUTPUT_PATTERN = FILE_PATTERN
ENHANCE_PROMPT = "保持原图主体、人物、构图、光影与色调，向画布四周自然延伸场景，透视与边缘无缝衔接。不要新增显眼物体、文字或水印。"
SUBJECT_PROTECTION = (
    "主体保护约束：保持原图人物数量、身份、脸型、眼鼻口形状、表情、姿态、手指、肢体、"
    "衣物轮廓和整体构图；不得增减人物、重塑五官、改变身材或制造多余肢体。"
    "只修改用户明确点名的区域和属性，未指定的区域保持原样，不重绘主体。"
    "这些约束优先于泛化的美化、增强或风格化要求。"
)


def protect_prompt(prompt, strength="gentle"):
    if strength not in ("gentle", "balanced"):
        raise HTTPException(400, "修图强度只能选择 gentle 或 balanced。")
    degree = (
        "轻柔调整：采用能实现要求的最小改动，保留原有纹理、细节和自然色调，避免磨皮、锐化光晕与过度饱和。"
        if strength == "gentle" else
        "适度调整：允许用户点名区域出现更明确的效果，但不得扩大修改范围或弱化主体保护约束。"
    )
    return SUBJECT_PROTECTION + "\n" + degree + "\n用户要求：\n" + prompt


def dispatch(**payload):
    url = os.environ.get("RUHUA_GPU_URL", "").strip()
    token = os.environ.get("BEAM_API_TOKEN", "").strip()
    if not url.startswith("https://") or not token:
        raise HTTPException(503, "生成服务尚未配置，请联系站点维护者。")
    try:
        # Beam's deployed task queue HTTP API accepts named function inputs.
        response = requests.post(url, json=payload,
                                 headers={"Authorization": "Bearer " + token}, timeout=25)
        if not response.ok:
            raise HTTPException(503, "生成队列暂不可用，请稍后再试。")
        body = response.json()
        if body.get("ok") is False or body.get("error"):
            raise HTTPException(503, "生成队列暂不可用，请稍后再试。")
        return body.get("task_id")
    except (requests.RequestException, ValueError):
        raise HTTPException(503, "暂时无法连接生成队列，请稍后再试。")


def admission(call_id, job_id, kind="jobs"):
    try:
        reserve(call_id, job_id, kind)
    except CapacityError as error:
        raise HTTPException(429, str(error))


def get_job(job_id):
    if not valid_id(job_id):
        raise HTTPException(404, "任务不存在")
    directory = job_path(job_id)
    if not directory.is_dir():
        raise HTTPException(404, "任务不存在")
    return directory


def private_job(job_id, job_token):
    try:
        authorize(job_id, job_token)
    except AccessDenied:
        raise HTTPException(403, "无权访问此任务，请在创建它的浏览器中打开。")
    return get_job(job_id)


def pad_canvas(image, ratio):
    width, height = image.size
    size = (int(width * (1 + 2 * ratio)), int(height * (1 + 2 * ratio)))
    background = image.resize(size).filter(ImageFilter.GaussianBlur(40))
    background.paste(image, ((size[0] - width) // 2, (size[1] - height) // 2))
    return background


def ark_edit(image, prompt, api_key="", model=""):
    key = api_key or os.environ.get("ARK_API_KEY", "")
    if not key:
        raise HTTPException(503, "修图服务尚未配置。")
    image.thumbnail((2048, 2048))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=92)
    payload = {
        "model": model or os.environ.get("ARK_MODEL", "doubao-seedream-4-0-250828"),
        "prompt": prompt, "image": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(),
        "size": "2048x2048", "response_format": "b64_json",
        "sequential_image_generation": "disabled", "watermark": False,
    }
    # Keep the source aspect ratio; square sizing would distort portrait inputs.
    width, height = image.size
    if not 1 / 3 <= width / height <= 3:
        raise HTTPException(400, "修图支持的图片宽高比为 1:3 至 3:1，请先裁剪图片。")
    # A common scale preserves aspect ratio. Round both sides up to 16px,
    # ensuring the minimum pixel area also survives quantization.
    import math
    scale = max(1, (1024 * 1024 / (width * height)) ** .5)
    output_width = math.ceil(width * scale / 16) * 16
    output_height = math.ceil(height * scale / 16) * 16
    payload["size"] = f"{output_width}x{output_height}"
    try:
        response = requests.post("https://ark.cn-beijing.volces.com/api/v3/images/generations",
                                 headers={"Authorization": "Bearer " + key}, json=payload, timeout=180)
        response.raise_for_status()
        entry = response.json()["data"][0]
        if entry.get("b64_json"):
            data = base64.b64decode(entry["b64_json"], validate=True)
        else:
            # Response URL is supplied only by the trusted image provider.
            download = requests.get(entry["url"], timeout=60)
            download.raise_for_status()
            data = download.content
        with Image.open(io.BytesIO(data)) as edited:
            result = io.BytesIO()
            edited.convert("RGB").save(result, "JPEG", quality=94)
            return result.getvalue()
    except (requests.RequestException, ValueError, KeyError, IndexError, OSError):
        raise HTTPException(502, "修图服务暂不可用，请稍后重试。")


def protected_outpaint(original, ratio, prompt, api_key="", model=""):
    """Keep original content by compositing, independently of model compliance.

    The model only supplies the outer canvas. Output uses the pre-thumbnail
    canvas dimensions, so original pixels occupy their exact center location.
    JPEG encoding may alter pixel values slightly; the central content is never
    replaced by generated faces/bodies. No feathering crosses the original area.
    """
    canvas = pad_canvas(original, ratio)
    size = canvas.size  # ark_edit thumbnails its input; save geometry first.
    expanded = ark_edit(canvas, "仅补全原图外侧新增画布，中心原图不得修改。\n" + prompt, api_key, model)
    with Image.open(io.BytesIO(expanded)) as generated:
        output = generated.convert("RGB").resize(size, Image.Resampling.LANCZOS)
    output.paste(original, ((size[0] - original.width) // 2, (size[1] - original.height) // 2))
    buffer = io.BytesIO()
    output.save(buffer, "JPEG", quality=95, subsampling=0)
    return buffer.getvalue()


def create_app():
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    app = FastAPI(title="Pixel Reconstruction · Beam serverless", docs_url=None, redoc_url=None, openapi_url=None)
    # Beam's public ASGI proxy supplies Access-Control-Allow-Origin: *.
    # CORSMiddleware here creates two origin values, rejected by browsers.

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(SigningUnavailable)
    async def signing_unavailable(request, error):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content={"detail": "服务认证配置暂不可用。"})

    @app.get("/healthz")
    def healthz():
        configured = bool(os.environ.get("RUHUA_GPU_URL") and os.environ.get("BEAM_API_TOKEN"))
        return {"ok": configured, "device": "Beam · RTX 4090 · 按需启动", "serverless": True,
                "enhance": bool(os.environ.get("ARK_API_KEY")), "gpu_on_demand": True,
                "assist": bool(os.environ.get("DEEPSEEK_API_KEY")),
                "assist_vision": bool(os.environ.get("DEEPSEEK_API_KEY")),
                "assist_actions": bool(os.environ.get("DEEPSEEK_API_KEY")),
                "assist_search": bool(os.environ.get("DEEPSEEK_API_KEY") and os.environ.get("BOCHA_API_KEY"))}

    @app.post("/assist")
    async def assist_chat(request: Request):
        # Whale companion chat. CPU-only; never touches jobs, files or the GPU queue.
        from assist import handle, MAX_ASSIST_BODY
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_ASSIST_BODY:
                raise HTTPException(413, "消息和截图过大，请缩小后重试。")
            body.extend(chunk)
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(400, "请求格式无效。")
        return await run_in_threadpool(handle, payload, request.client.host if request.client else "",
                                      request.headers.get("x-forwarded-for", ""))

    @app.post("/generate")
    def generate(request: Request, image: UploadFile = File(...), render_video: bool = Form(False), enhance: bool = Form(False)):
        if not allow_upload(request.client.host if request.client else "", request.headers.get("x-forwarded-for", "")):
            raise HTTPException(429, "上传过于频繁，请一分钟后再试。")
        if enhance and not os.environ.get("ARK_API_KEY"):
            raise HTTPException(503, "修图服务尚未配置，请先关闭扩图增强。")
        data = image.file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "图片不能超过 20MB。")
        try:
            with Image.open(io.BytesIO(data)) as incoming:
                incoming.load()
                normalized = ImageOps.exif_transpose(incoming).convert("RGB")
                normalized.thumbnail((4096, 4096))
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise HTTPException(400, "无法读取这张图片，请使用 JPG、PNG、WebP 或 HEIC。")
        call_id = job_id = uuid.uuid4().hex
        admission(call_id, job_id)
        directory = job_path(job_id)
        directory.mkdir(parents=True, exist_ok=False)
        job_token = create_access(job_id)
        try:
            normalized.save(directory / "original.jpg", "JPEG", quality=95)
            source = "original.jpg"
            if enhance:
                admission(call_id, job_id, "edits")
                source = "edit_" + uuid.uuid4().hex + ".jpg"
                (directory / source).write_bytes(protected_outpaint(normalized, .25, protect_prompt(ENHANCE_PROMPT)))
            dispatch(call_id=call_id, job_id=job_id, source=source,
                     render_video=render_video, enhanced=enhance)
        except Exception as error:
            message = error.detail if isinstance(error, HTTPException) else "上传处理失败，请重试。"
            write_state(call_id, "error", job_id=job_id, message=message)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(500, message)
        return {"call_id": call_id, "job_id": job_id, "job_token": job_token,
                "file_urls": get_urls(job_id, ["original.jpg", source])}

    @app.get("/status/{call_id}")
    def status(call_id: str, job_token: str = Header(default="", alias="X-Ruhua-Token")):
        if not valid_id(call_id):
            raise HTTPException(404, "任务不存在")
        state = read_state(call_id)
        if not state:
            raise HTTPException(404, "任务不存在")
        job_id = state.get("job_id", "")
        private_job(job_id, job_token)
        if state.get("status") in ("queued", "running") and time.time() - state.get("updated_at", 0) > 3600:
            write_state(call_id, "error", job_id=state.get("job_id"), message="任务等待或执行超时，请重新提交。")
            state = read_state(call_id)
        # Legacy jobs may have received a CPU-generated preview via /files.
        ply_name = state.get("ply_file", "")
        if ply_name and OUTPUT_PATTERN.fullmatch(ply_name):
            preview_name = ply_name.removesuffix(".ply") + ".splat"
            if (job_path(job_id) / preview_name).is_file():
                state = {**state, "viewer_file": preview_name}
        if state.get("status") == "done" and state.get("viewer_file"):
            from mobile_preview import get_mobile_preview
            mobile = get_mobile_preview(job_path(job_id), state["viewer_file"])
            if mobile:
                state = {**state, "mobile_viewer_file": mobile["viewer_file"], "mobile_preview": mobile}
        return {**state, "file_urls": get_urls(job_id, ["original.jpg", state.get("ply_file"), state.get("viewer_file"), state.get("mobile_viewer_file"), state.get("mp4_file")])}

    @app.get("/file/{job_id}/{filename}")
    def file(job_id: str, filename: str, expires: str = "", sig: str = "", accept: str = Header(default="")):
        try:
            authorize_file(job_id, filename, expires, sig)
        except AccessDenied:
            raise HTTPException(403, "下载链接无效或已过期，请重新打开作品。")
        directory = get_job(job_id)
        if not OUTPUT_PATTERN.fullmatch(filename):
            raise HTTPException(404, "文件不存在")
        path = directory / filename
        if not path.is_file():
            raise HTTPException(404, "文件不存在或尚未生成")
        media = "image/jpeg" if filename.endswith(".jpg") else "video/mp4" if filename.endswith(".mp4") else "application/octet-stream"
        from transfer import MEDIA_TYPE, accepts_transfer, prepare_transfer, release_transfer, transfer_etag
        packet = None
        if filename.endswith(".splat") and accepts_transfer(accept):
            prepared = prepare_transfer(path)
            if prepared != path.resolve():
                packet, path, media = prepared, prepared, MEDIA_TYPE

        class DownloadResponse(FileResponse):
            # Preserve Starlette's Range/conditional handling with fewer sends.
            chunk_size = 256 * 1024

            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    if packet is not None:
                        release_transfer(packet)

        headers = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Vary": "Accept"}
        if packet is not None:
            headers["ETag"] = transfer_etag(packet)
        return DownloadResponse(path, media_type=media, headers=headers)

    @app.get("/files/{job_id}")
    def files(job_id: str, job_token: str = Header(default="", alias="X-Ruhua-Token"), preview: str = "", source: str = ""):
        directory = private_job(job_id, job_token)
        if preview not in ("", "mobile"):
            raise HTTPException(400, "预览类型无效。")
        if source:
            from mobile_preview import FULL_PATTERN
            if preview != "mobile" or not FULL_PATTERN.fullmatch(source):
                raise HTTPException(400, "预览源文件无效。")
            selected = directory / source
            if not selected.is_file() or selected.resolve().parent != directory.resolve():
                raise HTTPException(404, "指定场景不存在或尚未生成。")
            viewer_file = source
        else:
            from preview import ensure_latest_preview
            viewer_file = ensure_latest_preview(directory)
        mobile = None
        if viewer_file:
            from mobile_preview import ensure_mobile_preview, get_mobile_preview
            if preview == "mobile":
                try:
                    mobile = ensure_mobile_preview(directory, viewer_file)
                except (OSError, ValueError, OverflowError):
                    raise HTTPException(503, "轻量预览暂不可用，请稍后重试。")
            else:
                mobile = get_mobile_preview(directory, viewer_file)
        elif preview == "mobile":
            raise HTTPException(409, "场景仍在准备，请稍后再试。")
        names = [path.name for path in directory.iterdir()
                 if path.is_file() and OUTPUT_PATTERN.fullmatch(path.name)]
        return {"file_urls": get_urls(job_id, names), **({"viewer_file": viewer_file} if viewer_file else {}),
                **({"mobile_viewer_file": mobile["viewer_file"], "mobile_preview": mobile} if mobile else {})}

    @app.post("/edit")
    @app.post("/edit-image")
    def edit(payload: dict = Body(...), job_token: str = Header(default="", alias="X-Ruhua-Token")):
        job_id = str(payload.get("job_id", ""))
        directory = private_job(job_id, job_token)
        api_key = str(payload.get("ark_api_key", "") or "").strip()
        model = str(payload.get("ark_model", "") or "").strip()
        if api_key and not re.fullmatch(r"[A-Za-z0-9._\-]{8,256}", api_key):
            raise HTTPException(400, "豆包 API Key 格式无效，请填写密钥本身。")
        if model and not re.fullmatch(r"[A-Za-z0-9._\-]{1,160}", model):
            raise HTTPException(400, "豆包模型名称格式无效。")
        if not api_key and not os.environ.get("ARK_API_KEY"):
            raise HTTPException(503, "修图服务尚未配置。")
        prompt = str(payload.get("prompt", "")).strip()
        if not prompt or len(prompt) > 4000:
            raise HTTPException(400, "请输入 1–4000 字的修图要求。")
        strength = payload.get("edit_strength", "gentle")
        if strength not in ("gentle", "balanced"):
            raise HTTPException(400, "修图强度只能选择 gentle 或 balanced。")
        source = str(payload.get("base", "original.jpg") or "original.jpg")
        if not IMAGE_PATTERN.fullmatch(source) or not (directory / source).is_file():
            raise HTTPException(400, "图片版本不存在。")
        try:
            pad = float(payload.get("pad_ratio", 0) or 0)
            if not 0 <= pad <= .5:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, "扩图比例必须在 0–0.5 之间。")
        history = payload.get("history", [])
        if isinstance(history, list) and history:
            prompt = "已有修改（已体现在当前图像中）：\n" + "\n".join(str(item)[:120] for item in history[-8:]) + "\n本次要求：\n" + prompt
        prompt = protect_prompt(prompt, strength)
        admission(uuid.uuid4().hex, payload["job_id"], "edits")
        with Image.open(directory / source) as original:
            incoming = original.convert("RGB")
        output = "edit_" + uuid.uuid4().hex + ".jpg"
        # User credentials remain in request memory, never in task state or files.
        data = protected_outpaint(incoming, pad, prompt, api_key, model) if pad else ark_edit(incoming, prompt, api_key, model)
        (directory / output).write_bytes(data)
        urls = get_urls(job_id, [output])
        return {"image": output, "file_url": urls[output], "file_urls": urls,
                **({"subject_preserved": True} if pad else {})}

    @app.post("/rerender")
    def rerender(payload: dict = Body(...), job_token: str = Header(default="", alias="X-Ruhua-Token")):
        job_id = str(payload.get("job_id", ""))
        directory = private_job(job_id, job_token)
        source = str(payload.get("source", ""))
        if not IMAGE_PATTERN.fullmatch(source) or not (directory / source).is_file():
            raise HTTPException(400, "图片版本不存在。")
        call_id = uuid.uuid4().hex
        admission(call_id, job_id)
        try:
            dispatch(call_id=call_id, job_id=job_id, source=source,
                     render_video=False, enhanced=source != "original.jpg")
        except HTTPException as error:
            write_state(call_id, "error", job_id=job_id, message=error.detail)
            raise
        return {"call_id": call_id, "job_id": job_id}

    return app

