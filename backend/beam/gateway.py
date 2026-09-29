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


# Seedream 5.0 Pro first; the rest only cover accounts that have not enabled it.
# A user-supplied model is used alone, so a typo is reported instead of silently replaced.
ARK_MODELS = ("doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-260128",
              "doubao-seedream-4-5-251128", "doubao-seedream-4-0-250828")
ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
# About 2K output (2048² ≈ 4.19M px): inside every listed model's pixel range,
# including 5.0 Pro's 4.62M ceiling and 4.5's 3.69M floor.
ARK_OUTPUT_PIXELS = 2048 * 2048
ARK_INPUT_EDGE = 3072
_working_model = {}


def pad_canvas(image, ratio):
    """Original centred on a flat neutral canvas.

    A blurred copy of the photo reads to the model as existing content, so it
    only sharpened the blur and the result looked like a framed picture. Flat
    grey is unmistakably empty and the prompt names it as the area to fill.
    """
    width, height = image.size
    size = (round(width * (1 + 2 * ratio)), round(height * (1 + 2 * ratio)))
    canvas = Image.new("RGB", size, (128, 128, 128))
    canvas.paste(image, ((size[0] - width) // 2, (size[1] - height) // 2))
    return canvas


def output_size(width, height, pixels=ARK_OUTPUT_PIXELS):
    """Same aspect ratio at about `pixels`, both sides multiples of 16."""
    scale = (pixels / (width * height)) ** .5
    return round(width * scale / 16) * 16, round(height * scale / 16) * 16


def model_candidates(model):
    if model:
        return [model]
    preferred = os.environ.get("ARK_MODEL", "").strip()
    return [preferred] + [m for m in ARK_MODELS if m != preferred] if preferred else list(ARK_MODELS)


def ark_edit(image, prompt, api_key="", model=""):
    key = api_key or os.environ.get("ARK_API_KEY", "")
    if not key:
        raise HTTPException(503, "修图服务尚未配置。")
    width, height = image.size
    if not 1 / 3 <= width / height <= 3:
        raise HTTPException(400, "修图支持的图片宽高比为 1:3 至 3:1，请先裁剪图片。")
    source = image.copy()
    source.thumbnail((ARK_INPUT_EDGE, ARK_INPUT_EDGE), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    source.save(buffer, "JPEG", quality=94)
    payload = {
        "prompt": prompt, "image": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(),
        "size": "%dx%d" % output_size(width, height), "response_format": "b64_json", "watermark": False,
    }
    candidates = model_candidates(model)
    # Remember which model works per key, by hash: user keys never outlive the request.
    import hashlib
    cache = (hashlib.sha256(key.encode()).hexdigest(), tuple(candidates))
    if cache in _working_model:
        candidates = [_working_model[cache]] + [m for m in candidates if m != _working_model[cache]]
    for index, name in enumerate(candidates):
        try:
            response = requests.post(ARK_URL, headers={"Authorization": "Bearer " + key},
                                     json={**payload, "model": name}, timeout=240)
        except requests.RequestException:
            raise HTTPException(502, "修图服务暂不可用，请稍后重试。")
        try:
            error = {} if response.ok else response.json().get("error", {})
        except ValueError:
            error = {}
        code = str(error.get("code", ""))
        # Model not enabled, or its usage cap reached ("Safe Experience Mode"
        # pauses the model): try the next one.
        if (response.status_code in (403, 404) or code == "SetLimitExceeded") and index + 1 < len(candidates):
            continue
        if not response.ok:
            if code == "SetLimitExceeded":
                raise HTTPException(429, f"豆包模型 {name} 已达到账号设置的用量上限（安全体验模式），请在火山方舟控制台的开通管理里调整后重试。")
            if response.status_code in (403, 404):
                raise HTTPException(400, f"这个豆包账号没有开通模型 {name}，请在火山方舟控制台开通后重试。")
            if response.status_code == 401:
                raise HTTPException(400, "豆包 API Key 无效或已过期。")
            if code.startswith("OutputImageSensitiveContent") or code.startswith("InputImageSensitiveContent") or "Sensitive" in code:
                raise HTTPException(400, "豆包拒绝了这张图片或这条要求（内容审核），请换个说法再试。")
            if response.status_code == 429:
                raise HTTPException(429, "豆包修图请求过于频繁，请稍后再试。")
            raise HTTPException(502, "修图服务暂不可用，请稍后重试。")
        _working_model[cache] = name
        try:
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
                edited.convert("RGB").save(result, "JPEG", quality=95, subsampling=0)
                return result.getvalue()
        except (requests.RequestException, ValueError, KeyError, IndexError, OSError):
            raise HTTPException(502, "修图服务暂不可用，请稍后重试。")
    raise HTTPException(502, "修图服务暂不可用，请稍后重试。")


def outpaint_prompt(ratio, prompt):
    factor = 1 + 2 * ratio
    return (
        f"扩图（outpainting）：输入图中央是原照片，四周纯灰色（RGB 128,128,128）区域是空白画布，不是画面内容。"
        f"把灰色区域全部画成与原照片连续的真实场景，四边各向外延伸原图宽高的 {round(ratio * 100)}%。"
        f"相当于在同一机位、同一高度、同一俯仰角换用更广的镜头：视角放大 {factor:.2f} 倍"
        f"（例如原图等效 35mm，扩图后约 {35 / factor:.0f}mm），消失点、地平线与透视线沿原图延长，"
        f"光圈与景深、ISO 噪点颗粒、曝光、白平衡、色彩分级与原图完全一致。"
        f"中央原照片逐像素保持不变，不缩放、不平移、不重绘；接缝处的物体、纹理和光影连续，"
        f"最终画面不能出现灰色、边框、黑边、模糊外圈、画中画或拼贴感。\n" + prompt
    )


def _gray(image, width):
    return image.convert("L").resize((width, max(1, round(width * image.height / image.width))), Image.Resampling.BILINEAR)


def _correlation(a, b):
    """Normalised cross-correlation of two same-size greyscale images (-1..1)."""
    from PIL import ImageChops, ImageStat
    sa, sb = ImageStat.Stat(a), ImageStat.Stat(b)
    product = ImageStat.Stat(ImageChops.multiply(a, b)).mean[0] * 255
    spread = sa.stddev[0] * sb.stddev[0]
    return (product - sa.mean[0] * sb.mean[0]) / spread if spread > 1 else 0


def _search(generated, probe, box, scales, shifts):
    left, top, width, height = box
    best = (-2, box)
    for scale in scales:
        w, h = width * scale, height * scale
        for dx in shifts:
            for dy in shifts:
                x = left + (width - w) / 2 + dx * width
                y = top + (height - h) / 2 + dy * height
                if x < -1 or y < -1 or x + w > generated.width + 1 or y + h > generated.height + 1:
                    continue
                crop = generated.crop((round(x), round(y), round(x + w), round(y + h))).resize(probe.size, Image.Resampling.BILINEAR)
                score = _correlation(crop, probe)
                if score > best[0]:
                    best = (score, (x, y, w, h))
    return best


def locate_original(generated, original, box):
    """Where the model actually drew the original inside `generated`.

    Seedream keeps the photo but usually redraws it 5–20% larger, sometimes
    off-centre; pasting at the nominal box then ghosts and leaves a frame.
    Correlation rather than pixel difference, because a difference score
    locks onto repetitive texture (sea, sky) at the wrong scale. Coarse
    search on a thumbnail, then refine at higher resolution.
    Returns (box in `generated` pixels, correlation), box None if no match.
    """
    frange = lambda a, b, step: [a + i * step for i in range(int(round((b - a) / step)) + 1)]
    coarse = 400 / generated.width
    nominal = tuple(v * coarse for v in box)
    score, found = _search(_gray(generated, 400), _gray(original, 120), nominal,
                           frange(.8, 1.3, .025), frange(-.15, .15, .015))
    fine = 1024 / generated.width
    guess = tuple(v / coarse * fine for v in found)
    score, found = _search(_gray(generated, 1024), _gray(original, 240), guess,
                           frange(.985, 1.015, .005), frange(-.012, .012, .003))
    return (tuple(v / fine for v in found) if score > .5 else None), score


def protected_outpaint(original, ratio, prompt, api_key="", model=""):
    """Keep original content by compositing, independently of model compliance.
    Returns (jpeg bytes, whether the original pixels were pasted back).

    The model only supplies the outer canvas. We find where it actually drew
    the photo, rescale the whole result so that spot matches the original's
    pixels 1:1 (no black edges, no ghosting), colour-match on the overlap, and
    blend the original in with a feather inside its own edge, so there is
    neither a hard seam nor a regenerated subject.

    Because the model enlarges the photo, the canvas is padded ~15% more than
    asked and the result cropped back to the requested margin around it.

    Sometimes the model re-lays out the whole scene instead (objects move).
    No placement lines it up with the original then, and pasting duplicates
    palms, cars, suns across the seam, so the model's own full frame, which
    is coherent, is returned untouched.
    """
    from PIL import ImageStat
    padded = min(.6, (1.15 * (1 + 2 * ratio) - 1) / 2)
    canvas = pad_canvas(original, padded)
    size = canvas.size
    expanded = ark_edit(canvas, outpaint_prompt(ratio, prompt), api_key, model)
    with Image.open(io.BytesIO(expanded)) as generated:
        output = generated.convert("RGB").resize(size, Image.Resampling.LANCZOS)
    nominal = ((size[0] - original.width) / 2, (size[1] - original.height) / 2, original.width, original.height)
    found, match = locate_original(output, original, nominal)
    if found is not None:
        x, y, w, h = found
        redrawn = output.crop((round(x), round(y), round(x + w), round(y + h))).resize(original.size, Image.Resampling.BILINEAR)
    if found is None or seam_difference(redrawn, original) > 16:
        return expanded, False
    x, y, w, h = found
    scale = original.width / w
    if abs(scale - 1) > 1e-3:
        output = output.resize((round(size[0] * scale), round(size[1] * scale)), Image.Resampling.LANCZOS)
    left, top = round(x * scale), round(y * scale)
    left = min(max(left, 0), output.width - original.width)
    top = min(max(top, 0), output.height - original.height)
    # Crop to the requested margin, centred on the original where possible.
    target = (round(original.width * (1 + 2 * ratio)), round(original.height * (1 + 2 * ratio)))
    crop_w, crop_h = min(target[0], output.width), min(target[1], output.height)
    cx = min(max(left + original.width // 2 - crop_w // 2, 0), output.width - crop_w)
    cy = min(max(top + original.height // 2 - crop_h // 2, 0), output.height - crop_h)
    output = output.crop((cx, cy, cx + crop_w, cy + crop_h))
    left, top = left - cx, top - cy
    # Colour-match the generated ring to the original on the overlapping area.
    region = (left, top, left + original.width, top + original.height)
    generated_mean = ImageStat.Stat(output.crop(region)).mean
    original_mean = ImageStat.Stat(original).mean
    gains = [min(1.12, max(.88, (o + 1) / (g + 1))) for o, g in zip(original_mean, generated_mean)]
    output = Image.merge("RGB", [band.point(lambda v, k=k: min(255, round(v * k)))
                                 for band, k in zip(output.split(), gains)])
    # Feather the outermost part of the original into the generated ring;
    # wider when the model's redraw of the photo differs more from it.
    feather = max(4, round(min(original.size) * (.025 if match > .93 else .06)))
    mask = Image.new("L", original.size, 0)
    mask.paste(255, (feather, feather, original.width - feather, original.height - feather))
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
    output.paste(original, (left, top), mask)
    buffer = io.BytesIO()
    output.save(buffer, "JPEG", quality=95, subsampling=0)
    return buffer.getvalue(), True


def match_resolution(data, size):
    """Seedream answers at about 2K; bring a smaller result back to the source photo's pixel size
    (Lanczos) so an exported version is never lower-resolution than what the user started from."""
    with Image.open(io.BytesIO(data)) as edited:
        if edited.width >= size[0] and edited.height >= size[1]:
            return data
        output = edited.convert("RGB").resize(size, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    output.save(buffer, "JPEG", quality=95, subsampling=0)
    return buffer.getvalue()


def seam_difference(redrawn, original):
    """Mean grey difference (0–255) in the outer 8% band where the seam falls.

    Measured on Seedream 5.0 Pro outputs: seamless composites were ≤10,
    ones that ghosted after pasting were ≥28.
    """
    from PIL import ImageChops, ImageStat
    size = (512, max(1, round(512 * original.height / original.width)))
    a = original.convert("L").resize(size, Image.Resampling.BILINEAR)
    b = redrawn.convert("L").resize(size, Image.Resampling.BILINEAR)
    difference = ImageChops.difference(a, b)
    k = round(min(size) * .08)
    w, h = size
    strips = [(0, 0, w, k), (0, h - k, w, h), (0, k, k, h - k), (w - k, k, w, h - k)]
    total = sum(ImageStat.Stat(difference.crop(s)).sum[0] for s in strips)
    area = sum((s[2] - s[0]) * (s[3] - s[1]) for s in strips)
    return total / area


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
                (directory / source).write_bytes(protected_outpaint(normalized, .25, protect_prompt(ENHANCE_PROMPT))[0])
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
        data, preserved = protected_outpaint(incoming, pad, prompt, api_key, model) if pad else (ark_edit(incoming, prompt, api_key, model), False)
        # Composited outpaints are already at the original's scale; everything else is scaled back up to it.
        if not preserved:
            data = match_resolution(data, (round(incoming.width * (1 + 2 * pad)), round(incoming.height * (1 + 2 * pad))))
        (directory / output).write_bytes(data)
        urls = get_urls(job_id, [output])
        return {"image": output, "file_url": urls[output], "file_urls": urls,
                **({"subject_preserved": preserved} if pad else {})}

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

