"""查看所有 World Labs 账号的余额（不扣积分，只调 GET /credits；只显示密钥末 4 位）。
    python scripts/worldlabs-credits.py
主账号：.beam-tools/worldlabs.env；更多账号：.beam-tools/worldlabs-pool.env（一行一个密钥）。
加新密钥：把它追加到 worldlabs-pool.env → python scripts/beam-secrets.py（WSL 的 .venv-beam）→ 部署网关。
"""
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.worldlabs.ai/marble/v1"
TIERS = {"速写": 230, "标准": 1580, "广阔": 3080}


def keys():
    found = []
    main = ROOT / ".beam-tools/worldlabs.env"
    if main.is_file():
        m = re.search(r'(?im)^\s*WORLDLABS_API_KEY\s*=\s*([^\s"\r\n]+)', main.read_text(encoding="utf-8-sig"))
        if m:
            found.append(m.group(1))
    pool = ROOT / ".beam-tools/worldlabs-pool.env"
    if pool.is_file():
        for line in pool.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                key = line.split("=", 1)[1].strip() if "=" in line else line
                if key not in found:
                    found.append(key)
    return found


def balance(key):
    try:
        r = requests.get(API + "/credits", headers={"WLT-Api-Key": key, "Accept": "application/json"}, timeout=20)
        return r.status_code, (r.json().get("remaining_credits") if r.ok else None)
    except Exception as e:  # noqa: BLE001
        return type(e).__name__, None


if __name__ == "__main__":
    ks = keys()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(balance, ks))
    total = 0
    for i, (key, (status, credits)) in enumerate(zip(ks, results)):
        label = "主账号" if i == 0 else f"账号 {i + 1}"
        print(f"{label}  …{key[-4:]}  HTTP {status}  余额 {credits if credits is not None else '-'}")
        total += credits or 0
    best = max((c or 0) for _, c in results) if results else 0
    print(f"合计 {total:.0f}；单个账号最多 {best:.0f}")
    for name, cost in TIERS.items():
        print(f"  {name}（约 {cost}）：{'可以' if best >= cost else '余额不够'}，共约 {int(sum((c or 0) // cost for _, c in results))} 次")
