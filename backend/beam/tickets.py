"""Bug reports (工单) that the site companion files for a user, with the user's consent.

The browser sends what the user saw and a diagnostic snapshot; this module validates, scrubs
credentials, rate-limits and stores one JSON file per report on the data volume. The maintainer
reads and closes them with scripts/tickets.py, authenticated by a key derived from the server's
own BEAM_API_TOKEN (never sent to browsers). Nothing here touches jobs, files or the GPU queue.
"""
import hashlib
import hmac
import json
import re
import secrets
import time

from security import allow_upload, signing_key
from storage import ROOT, admission_lock, atomic_json, read_json

MAX_TICKET_BODY = 64_000
DAILY_LIMIT = 300            # reports per UTC day across the site
SEVERITIES = ("low", "normal", "high")
CATEGORIES = ("upload", "reconstruct", "download", "studio", "export", "world", "edit", "gallery", "assistant", "performance", "display", "other")
STATUSES = ("open", "fixed", "closed")
ID_PATTERN = re.compile(r"\d{8}-\d{6}-[0-9a-f]{6}")
TEXT_LIMITS = {"title": 80, "summary": 1500, "steps": 1500, "expected": 600, "actual": 1000, "user_note": 1200, "page": 40, "ua": 300, "version": 40}

_SCRUB = [
    # Signed download links and any other query-string credentials.
    (re.compile(r"(https?://[^\s?#]+)\?[^\s]*"), r"\1?[已隐藏]"),
    (re.compile(r"(/(?:scene-)?file/[^\s?#]+)\?[^\s]*"), r"\1?[已隐藏]"),
    (re.compile(r"(?i)\b(sig|expires|token|key|secret)=[^\s&]+"), r"\1=[已隐藏]"),
    (re.compile(r"\b(?:sk|ak|pk)-[A-Za-z0-9_\-]{8,}", re.I), "[已隐藏的密钥]"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}"), "Bearer [已隐藏]"),
    # Capability tokens (43-char url-safe base64) and other long secrets. 32-hex job ids are kept:
    # they are not access grants and they let the maintainer find the job.
    (re.compile(r"(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9_\-])"), "[已隐藏]"),
]


class TicketRejected(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def scrub(text):
    text = str(text).replace("\x00", "")
    for pattern, replacement in _SCRUB:
        text = pattern.sub(replacement, text)
    return text


def _text(value, limit):
    return scrub(value)[:limit].strip() if isinstance(value, (str, int, float)) else ""


def clean_report(payload):
    if not isinstance(payload, dict):
        raise TicketRejected(400, "工单格式无效。")
    report = {name: _text(payload.get(name, ""), limit) for name, limit in TEXT_LIMITS.items()}
    if not report["title"] or not (report["summary"] or report["actual"]):
        raise TicketRejected(400, "工单缺少标题或问题描述。")
    report["severity"] = payload.get("severity") if payload.get("severity") in SEVERITIES else "normal"
    report["category"] = payload.get("category") if payload.get("category") in CATEGORIES else "other"
    errors = payload.get("errors") if isinstance(payload.get("errors"), list) else []
    report["errors"] = [_text(item, 300) for item in errors[:12] if _text(item, 300)]
    diagnostics = payload.get("diagnostics") if isinstance(payload.get("diagnostics"), dict) else {}
    report["diagnostics"] = {_text(key, 40): _text(value, 300) for key, value in list(diagnostics.items())[:40] if _text(key, 40)}
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), list) else []
    report["conversation"] = [{"role": item.get("role") if item.get("role") in ("user", "assistant") else "user", "content": _text(item.get("content", ""), 600)}
                              for item in conversation[-8:] if isinstance(item, dict) and _text(item.get("content", ""), 600)]
    return report


def file_report(payload, client_host="", forwarded_for=""):
    report = clean_report(payload)
    if not allow_upload(client_host, forwarded_for, "ticket-ips", 2):
        raise TicketRejected(429, "提交过于频繁，请一分钟后再试。")
    now = time.time()
    day = time.strftime("%Y%m%d", time.gmtime(now))
    folder = ROOT / "tickets" / day
    with admission_lock():
        folder.mkdir(parents=True, exist_ok=True)
        if sum(1 for _ in folder.glob("*.json")) >= DAILY_LIMIT:
            raise TicketRejected(429, "今天的工单数量已达上限，请明天再试或联系站长。")
        ticket_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)) + "-" + secrets.token_hex(3)
        atomic_json(folder / (ticket_id + ".json"), {"id": ticket_id, "created_at": now, "status": "open", "notes": [], **report})
    return {"ok": True, "ticket": ticket_id}


def admin_key():
    return hmac.new(signing_key(), b"ruhua-tickets-admin-v1", hashlib.sha256).hexdigest()


def authorize_admin(header):
    if not isinstance(header, str) or not re.fullmatch(r"[0-9a-f]{64}", header) or not hmac.compare_digest(header, admin_key()):
        raise TicketRejected(403, "无权查看工单。")


def _path(ticket_id):
    if not isinstance(ticket_id, str) or not ID_PATTERN.fullmatch(ticket_id):
        raise TicketRejected(404, "工单不存在。")
    path = ROOT / "tickets" / ticket_id[:8] / (ticket_id + ".json")
    if not path.is_file():
        raise TicketRejected(404, "工单不存在。")
    return path


def list_reports(status="open", days=14):
    days = max(1, min(int(days), 90))
    cutoff = time.strftime("%Y%m%d", time.gmtime(time.time() - days * 86400))
    base = ROOT / "tickets"
    found = []
    if base.is_dir():
        for folder in sorted((p for p in base.iterdir() if p.is_dir() and p.name >= cutoff), reverse=True):
            for path in sorted(folder.glob("*.json"), reverse=True):
                item = read_json(path, {})
                if status in ("", "all") or item.get("status") == status:
                    found.append({key: item.get(key) for key in ("id", "created_at", "status", "severity", "category", "title", "page")})
    return {"tickets": found[:200]}


def get_report(ticket_id):
    return read_json(_path(ticket_id), {})


def update_report(ticket_id, status, note=""):
    if status not in STATUSES:
        raise TicketRejected(400, "状态无效。")
    path = _path(ticket_id)
    with admission_lock():
        item = read_json(path, {})
        item["status"] = status
        if note:
            item.setdefault("notes", []).append({"at": time.time(), "text": scrub(note)[:1000]})
        atomic_json(path, item)
    return {"ok": True, "id": ticket_id, "status": status}


def parse(body):
    if len(body) > MAX_TICKET_BODY:
        raise TicketRejected(413, "工单内容过大。")
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise TicketRejected(400, "工单格式无效。")
