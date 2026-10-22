"""「走进世界」：World Labs World API（Marble）的薄代理。CPU 网关里运行，从不唤醒 GPU。

API key 只在 Beam Secrets（WORLDLABS_API_KEY）。前端约定见 docs/world-api.md：
发起生成、查询进度、取世界三个接口；operation 与 world 原样转发，前端自己整理字段。
每件作品的世界任务记在它的目录里（world.json），查询时据此确认任务属于这件作品。
"""
import base64
import io
import os
import re
import time

import requests
from fastapi import HTTPException
from PIL import Image, ImageOps

from storage import IMAGE_PATTERN, atomic_json, read_json

API = "https://api.worldlabs.ai/marble/v1"
# 单张照片（非全景）的每次生成费用（credits，官方价目 2026-10）；Plus 按世界大小浮动，取上限
MODELS = {"marble-1.0-draft": 230, "marble-1.1": 1580, "marble-1.1-plus": 3080}
ID = re.compile(r"[A-Za-z0-9_-]{6,128}")
MAX_SIDE = 2048  # Marble 不需要更大的输入；缩小后请求只有一两 MB


def configured():
    return bool(os.environ.get("WORLDLABS_API_KEY", "").strip())


def _key():
    key = os.environ.get("WORLDLABS_API_KEY", "").strip()
    if not key:
        raise HTTPException(503, "世界模型尚未配置。")
    return key


def call(method, path, payload=None, timeout=60):
    try:
        response = requests.request(method, API + path, json=payload, timeout=timeout,
                                    headers={"WLT-Api-Key": _key(), "Accept": "application/json"})
    except requests.RequestException:
        raise HTTPException(502, "暂时连不上 World Labs，请稍后重试。")
    if response.status_code == 429:
        raise HTTPException(429, "World Labs 当前请求较多，请稍后重试。")
    if response.status_code in (401, 403):
        raise HTTPException(503, "世界模型的服务凭证无效，请联系站长。")
    if response.status_code == 402:
        raise HTTPException(402, "世界模型的额度已用完，请联系站长充值。")
    if not response.ok:
        detail = ""
        try:
            body = response.json()
            detail = str(body.get("detail") or body.get("message") or body.get("error") or "")[:200]
        except ValueError:
            pass
        if response.status_code == 404:
            raise HTTPException(404, "没有找到这个世界或任务。")
        raise HTTPException(502, "World Labs 返回错误（%d）%s" % (response.status_code, "：" + detail if detail else "。"))
    try:
        return response.json()
    except ValueError:
        raise HTTPException(502, "World Labs 返回了无效响应。")


def _record(directory):
    return read_json(directory / "world.json", {"operations": {}})


def _save(directory, record):
    atomic_json(directory / "world.json", record)


def encode_photo(path):
    """作品照片 → JPEG base64（按拍摄方向转正，长边不超过 2048）"""
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=92, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def generate(directory, job_id, payload, admit):
    """发起生成。admit() 记一次每日额度（先查余额，余额不够不占额度）。

    request_id 由前端生成：提交要等二三十秒，页面中途关掉或断网时，前端凭它找回任务（见 lookup）；
    同一个 request_id 再提交一次直接返回原任务，不会重复花额度。
    """
    _key()
    request_id = str(payload.get("request_id") or "")
    if request_id and not ID.fullmatch(request_id):
        raise HTTPException(400, "提交编号无效。")
    if request_id:
        for operation_id, item in _record(directory)["operations"].items():
            if item.get("request_id") == request_id:
                return {"operation_id": operation_id}
    model = str(payload.get("model") or "marble-1.1")
    if model not in MODELS:
        raise HTTPException(400, "模型只能选择速写、标准或广阔。")
    prompt = str(payload.get("text_prompt") or "").strip()
    if len(prompt) > 600:
        raise HTTPException(400, "补充描述最多 600 字。")
    source = str(payload.get("image") or "original.jpg")
    if not IMAGE_PATTERN.fullmatch(source) or not (directory / source).is_file():
        raise HTTPException(400, "图片版本不存在。")
    remaining = call("GET", "/credits", timeout=20).get("remaining_credits", 0)
    if remaining < MODELS[model]:
        raise HTTPException(402, "世界模型的额度不够这一档（剩余 %d，需要约 %d），可以先试试“速写”。" % (remaining, MODELS[model]))
    admit()
    prompt_body = {"type": "image",
                   "image_prompt": {"source": "data_base64", "data_base64": encode_photo(directory / source), "extension": "jpg"}}
    if prompt:
        prompt_body["text_prompt"] = prompt
    result = call("POST", "/worlds:generate", {
        "display_name": "Pixel Reconstruction " + job_id[:8],
        "model": model,
        "world_prompt": prompt_body,
        "permission": {"public": False},
    }, timeout=120)
    operation_id = str(result.get("operation_id") or "")
    if not ID.fullmatch(operation_id):
        raise HTTPException(502, "World Labs 没有返回任务编号。")
    record = _record(directory)
    record["operations"][operation_id] = {"model": model, "source": source, "created": time.time(),
                                          **({"request_id": request_id} if request_id else {})}
    _save(directory, record)
    return {"operation_id": operation_id}


def lookup(directory, request_id):
    """按前端的提交编号找回任务；还没提交成功（或根本没到）时 404"""
    if ID.fullmatch(request_id):
        for operation_id, item in _record(directory)["operations"].items():
            if item.get("request_id") == request_id:
                return {"operation_id": operation_id, "model": item.get("model")}
    raise HTTPException(404, "没有找到这次提交。")


def operation(directory, operation_id):
    record = _record(directory)
    if not ID.fullmatch(operation_id) or operation_id not in record["operations"]:
        raise HTTPException(404, "没有找到这个生成任务。")
    data = call("GET", "/operations/" + operation_id, timeout=30)
    snapshot = data.get("response") or {}
    world_id = (data.get("metadata") or {}).get("world_id") or snapshot.get("id") or snapshot.get("world_id")
    if world_id and ID.fullmatch(str(world_id)) and record["operations"][operation_id].get("world_id") != world_id:
        record["operations"][operation_id]["world_id"] = str(world_id)
        _save(directory, record)
    return data


def world(directory, world_id):
    record = _record(directory)
    if not ID.fullmatch(world_id) or not any(item.get("world_id") == world_id for item in record["operations"].values()):
        raise HTTPException(404, "没有找到这个世界。")
    return call("GET", "/worlds/" + world_id, timeout=30)
