"""Check both lines of 大肥鱼 on the live gateway: official DeepSeek and the Ark-hosted DeepSeek backup.

    python scripts/assist-route-check.py            # both routes
    python scripts/assist-route-check.py ark        # only the backup line

Sends one short chat per route with X-Ruhua-Assist-Route (honoured only with the admin key, which is
derived from .beam-token like scripts/tickets.py; the token itself is never printed or sent).
Each check spends one chat from the daily ledger. Stdlib only.
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
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass


def gateway():
    text = (root / ".env.local").read_text(encoding="utf-8-sig")
    return re.search(r"NEXT_PUBLIC_BEAM_API\s*=\s*(\S+)", text).group(1).rstrip("/")


def admin_key():
    token = (root / ".beam-token").read_text(encoding="utf-8-sig").strip()
    signing = hmac.digest(token.encode(), b"ruhua-private-files-v1", "sha256")
    return hmac.new(signing, b"ruhua-tickets-admin-v1", hashlib.sha256).hexdigest()


def check(route):
    body = json.dumps({"messages": [{"role": "user", "content": "怎么把场景导出成视频？一句话回答。"}],
                       "context": {"page": "studio"}}).encode()
    request = urllib.request.Request(gateway() + "/assist", data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Ruhua-Admin": admin_key(), "X-Ruhua-Assist-Route": route})
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=95) as response:
            data = json.load(response)
            print(f"{route:9} OK   {time.time() - started:5.1f} s  {data.get('mood')}  {data.get('reply', '')[:80]}")
            return True
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:160]
        print(f"{route:9} HTTP {error.code} {time.time() - started:5.1f} s  {detail}")
    except Exception as error:  # noqa: BLE001 - report any transport failure
        print(f"{route:9} ERR  {time.time() - started:5.1f} s  {type(error).__name__}")
    return False


if __name__ == "__main__":
    print("gateway:", gateway())
    with urllib.request.urlopen(gateway() + "/healthz", timeout=30) as response:
        health = json.load(response)
    print("assist:", health.get("assist"), " backup:", health.get("assist_backup"))
    routes = sys.argv[1:] or ["deepseek", "ark"]
    sys.exit(0 if all([check(route) for route in routes]) else 1)
