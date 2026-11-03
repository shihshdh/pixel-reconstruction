"""Read and close the bug reports (工单) that 大肥鱼 files for users (backend/beam/tickets.py).

    python scripts/tickets.py                 # open tickets from the last 14 days
    python scripts/tickets.py list --all --days 30
    python scripts/tickets.py show <id>
    python scripts/tickets.py fixed <id> "已在 1.9.6 修复：…"
    python scripts/tickets.py close <id> "不是网站缺陷：…"

The admin key is derived from .beam-token the same way the gateway derives it from BEAM_API_TOKEN;
the token itself is never printed or sent. The gateway URL comes from .env.local (NEXT_PUBLIC_BEAM_API).
Stdlib only, so it runs with any Python 3.
"""
from pathlib import Path
import hashlib
import hmac
import json
import re
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认 GBK，中文会乱码
except (AttributeError, ValueError):
    pass


def gateway():
    text = (root / ".env.local").read_text(encoding="utf-8-sig")
    match = re.search(r"NEXT_PUBLIC_BEAM_API\s*=\s*(\S+)", text)
    if not match:
        sys.exit(".env.local 里没有 NEXT_PUBLIC_BEAM_API")
    return match.group(1).rstrip("/")


def admin_key():
    token = (root / ".beam-token").read_text(encoding="utf-8-sig").strip()
    signing = hmac.digest(token.encode(), b"ruhua-private-files-v1", "sha256")
    return hmac.new(signing, b"ruhua-tickets-admin-v1", hashlib.sha256).hexdigest()


def call(path, body=None):
    request = urllib.request.Request(gateway() + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"X-Ruhua-Admin": admin_key(), "Content-Type": "application/json"},
                                     method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        sys.exit(f"HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:200]}")


def show(item):
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(item.get("created_at", 0)))
    print(f"# {item.get('id')}  [{item.get('status')}] {item.get('severity')} · {item.get('category')} · {item.get('page')} · {when}")
    print(f"标题：{item.get('title')}")
    for name, label in (("summary", "现象"), ("steps", "步骤"), ("expected", "期望"), ("actual", "实际"), ("tried", "已尝试"), ("user_note", "用户原话")):
        if item.get(name):
            print(f"{label}：{item[name]}")
    if item.get("errors"):
        print("页面报错：\n  " + "\n  ".join(item["errors"]))
    if item.get("diagnostics"):
        print("环境诊断：\n  " + "\n  ".join(f"{k}：{v}" for k, v in item["diagnostics"].items()))
    if item.get("ua"):
        print(f"UA：{item['ua']}")
    if item.get("conversation"):
        print("对话：\n  " + "\n  ".join(f"{m['role']}: {m['content']}" for m in item["conversation"]))
    for note in item.get("notes", []):
        print(f"备注（{time.strftime('%m-%d %H:%M', time.localtime(note['at']))}）：{note['text']}")


args = sys.argv[1:] or ["list"]
command = args[0]
if command == "list":
    status = "all" if "--all" in args else "open"
    days = int(args[args.index("--days") + 1]) if "--days" in args else 14
    tickets = call(f"/tickets?status={status}&days={days}")["tickets"]
    if not tickets:
        print("没有工单。")
    for t in tickets:
        print(f"{t['id']}  [{t['status']}] {t['severity']:<6} {t['category']:<11} {t['title']}")
elif command == "show" and len(args) > 1:
    show(call(f"/tickets/{args[1]}"))
elif command in ("fixed", "close", "open") and len(args) > 1:
    status = {"fixed": "fixed", "close": "closed", "open": "open"}[command]
    print(call(f"/tickets/{args[1]}", {"status": status, "note": " ".join(args[2:])}))
else:
    print(__doc__)
