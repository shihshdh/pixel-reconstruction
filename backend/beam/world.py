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
        # 上一次提交 World Labs 已经收下、但网关没来得及记下（容器中途被回收）：凭标签找回，不再花一次额度
        found = _find_tagged(request_id)
        if found:
            return {"operation_id": _adopt(directory, found, request_id)}
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
        # 标签让世界在任务记录丢了、operation 过期（三小时）之后仍然找得回来（见 _find_tagged）
        "tags": _tags(job_id, request_id),
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
        # 网关没记下但 World Labs 收到了（提交途中容器被回收）：按标签找到世界，记成一条“找回的任务”
        found = _find_tagged(request_id)
        if found:
            return {"operation_id": _adopt(directory, found, request_id), "model": found.get("model")}
    raise HTTPException(404, "没有找到这次提交。")


# ---------------- 找回：operation 过期、记录丢失时凭标签找世界 ----------------
# World Labs 的 operation 只保留三小时（expires_at），之后 GET 返回 404。生成完没被查过的任务（关了页面、
# 第二天才回来）如果只认 operation，就永远停在“最后一步”。每次生成都带上标签：提交编号与作品编号，
# operation 查不到时按标签在 worlds:list 里找到世界，合成一个“已完成”的 operation 交给前端。
RECOVERED = "recovered-"


def _tags(job_id, request_id):
    tags = ["pixel-reconstruction", "j" + job_id[:31]]
    if request_id.startswith("req_") and len(request_id) <= 36:
        tags.append(request_id[4:])
    return tags


def _find_tagged(request_id=None, job_id=None, created_after=None):
    """worlds:list 按标签找（只给作品编号时，再按显示名兜底：加标签之前生成的世界）；
    找不到或接口出错返回 None（找回只是兜底，不能让查询报错）"""
    tag = request_id[4:] if request_id and request_id.startswith("req_") else ("j" + job_id[:31] if job_id else None)
    if not tag:
        return None
    query = {"tags": [tag], "page_size": 20, "sort_by": "created_at"}
    if not request_id and created_after:
        # 旧世界没有标签：按时间取最近的，再用显示名（"Pixel Reconstruction <作品编号前 8 位>"）认
        query = {"page_size": 50, "sort_by": "created_at", "created_after": created_after + "Z"}
    try:
        listing = call("POST", "/worlds:list", query, timeout=30)
    except HTTPException:
        return None
    worlds = [w for w in listing.get("worlds") or [] if isinstance(w, dict) and ID.fullmatch(str(w.get("world_id") or w.get("id") or ""))]
    if "tags" not in query:
        worlds = [w for w in worlds if tag in (w.get("tags") or []) or w.get("display_name") == "Pixel Reconstruction " + job_id[:8]]
    if created_after:
        worlds = [w for w in worlds if str(w.get("created_at") or "") >= created_after]
    worlds.sort(key=lambda w: str(w.get("created_at") or ""), reverse=True)
    return worlds[0] if worlds else None


def _adopt(directory, found, request_id=None):
    world_id = str(found.get("world_id") or found.get("id"))
    operation_id = RECOVERED + world_id
    record = _record(directory)
    record["operations"].setdefault(operation_id, {"model": found.get("model"), "created": time.time(), "recovered": True,
                                                   **({"request_id": request_id} if request_id else {})})
    record["operations"][operation_id]["world_id"] = world_id
    _save(directory, record)
    return operation_id


def _finished(world_id):
    """把一个已经生成好的世界包装成“已完成”的 operation（字段与 World Labs 的一致）"""
    data = call("GET", "/worlds/" + world_id, timeout=30)
    snapshot = data.get("world") if isinstance(data.get("world"), dict) else data
    return {"operation_id": RECOVERED + world_id, "done": True, "error": None, "recovered": True,
            "metadata": {"world_id": world_id, "progress": {"status": "SUCCEEDED", "description": "World generation completed successfully"}},
            "response": snapshot}


def operation(directory, operation_id):
    record = _record(directory)
    if not ID.fullmatch(operation_id) or operation_id not in record["operations"]:
        raise HTTPException(404, "没有找到这个生成任务。")
    item = record["operations"][operation_id]
    if operation_id.startswith(RECOVERED):
        return _finished(item["world_id"])
    try:
        data = call("GET", "/operations/" + operation_id, timeout=30)
    except HTTPException as error:
        if error.status_code != 404:
            raise
        # operation 过期了（三小时）：世界通常早就生成好了。先用记下的 world_id，再按标签找
        if item.get("world_id"):
            return _finished(item["world_id"])
        created = item.get("created")
        after = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(created - 120)) if created else None
        found = _find_tagged(item.get("request_id"), None, after) or _find_tagged(None, directory.name, after)
        if found:
            world_id = str(found.get("world_id") or found.get("id"))
            item["world_id"] = world_id
            _save(directory, record)
            return _finished(world_id)
        return {"operation_id": operation_id, "done": True, "expired": True,
                "error": {"message": "这次生成的任务已经过期，也没有找到生成好的世界，请重新生成。"}}
    snapshot = data.get("response") or {}
    world_id = (data.get("metadata") or {}).get("world_id") or snapshot.get("id") or snapshot.get("world_id")
    if world_id and ID.fullmatch(str(world_id)) and item.get("world_id") != world_id:
        item["world_id"] = str(world_id)
        _save(directory, record)
    return data


def world(directory, world_id):
    record = _record(directory)
    if not ID.fullmatch(world_id) or not any(item.get("world_id") == world_id for item in record["operations"].values()):
        raise HTTPException(404, "没有找到这个世界。")
    return call("GET", "/worlds/" + world_id, timeout=30)
