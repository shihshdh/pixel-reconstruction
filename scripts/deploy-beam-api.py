"""Deploy the CPU API to Beam, verify it, and point the site at the new version.

Run from the project root inside WSL with the Beam venv:
    .venv-beam/bin/python scripts/deploy-beam-api.py

Only the CPU API is deployed (the GPU queue is untouched). Credentials stay in
.beam-token / Beam Secrets: this script never reads them itself, and the saved
log is redacted. The old API version keeps running; stop it by hand once the
new one is confirmed.
"""
from pathlib import Path
import json
import re
import subprocess
import sys
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
artifacts = root / "artifacts"
artifacts.mkdir(exist_ok=True)
log_path = artifacts / "beam-deploy-latest.log"
summary_path = artifacts / "beam-deploy-latest.json"
URL = re.compile(r"https://ruhua-api-[a-z0-9]+-v(\d+)\.app\.beam\.cloud")
# Files that carry the public CPU API address (same set as the v12 switch).
TARGETS = [".env.local", "netlify/edge-functions/scene-file.ts", "README.md", "scripts/verify-full-resume.cjs"]


def redact(line: str) -> str:
    line = re.sub(r"(?i)(bearer|authorization:?|token[=:])\s*\S+", r"\1 [redacted]", line)
    return re.sub(r"(?<![A-Za-z0-9/._-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9/._-])", "[redacted]", line)


def finish(status: str, **extra):
    summary = {"status": status, "time": time.strftime("%Y-%m-%d %H:%M:%S"), **extra}
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n== " + status + " ==", json.dumps(extra, ensure_ascii=False), flush=True)
    sys.exit(0 if status == "deployed" else 1)


env_text = (root / ".env.local").read_text(encoding="utf-8-sig")
old = URL.search(env_text)
if not old:
    finish("failed", step="read-old-url", detail=".env.local has no ruhua-api URL")
old_url, old_version = old.group(0), int(old.group(1))
print(f"Current API: v{old_version}", flush=True)

print("[1/3] Deploying CPU API (beam_app.py:api) ...", flush=True)
lines = []
process = subprocess.Popen([sys.executable, str(root / "scripts/beam-cli.py"), "deploy", "beam_app.py:api"],
                           cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for raw in process.stdout:
    clean = redact(raw.rstrip("\n"))
    lines.append(clean)
    print(clean, flush=True)
code = process.wait()
log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
if code:
    finish("failed", step="deploy", exit_code=code, log=str(log_path.relative_to(root)))

found = [(int(m.group(1)), m.group(0)) for line in lines for m in URL.finditer(line)]
newer = sorted(v for v in found if v[0] > old_version)
if not newer:
    finish("failed", step="find-new-url", detail="deploy output had no newer version URL", log=str(log_path.relative_to(root)))
new_version, new_url = newer[-1]

print(f"[2/3] Checking v{new_version} /healthz ...", flush=True)
health = None
for attempt in range(6):
    try:
        with urllib.request.urlopen(new_url + "/healthz", timeout=60) as response:
            health = json.loads(response.read().decode("utf-8"))
        break
    except Exception as error:  # cold start: retry a few times
        print(f"  not ready yet ({type(error).__name__}), retrying ...", flush=True)
        time.sleep(15)
if not health or health.get("ok") is not True or health.get("assist") is not True:
    finish("failed", step="healthz", new_version=new_version, health=health)

print(f"[3/3] Switching the site from v{old_version} to v{new_version} ...", flush=True)
changed = []
for name in TARGETS:
    path = root / name
    if not path.is_file():
        continue
    data = path.read_bytes()
    if old_url.encode() in data:
        path.write_bytes(data.replace(old_url.encode(), new_url.encode()))
        changed.append(name)
finish("deployed", old_version=old_version, new_version=new_version, new_url=new_url, health_ok=True, assist=True, files_updated=changed)
