"""Stop CPU API deployments older than the version the site uses (.env.local).

Run from the project root inside WSL with the Beam venv:
    .venv-beam/bin/python scripts/stop-old-beam-api.py

Only the CPU API ("ruhua-api") is touched, never the GPU queue, and nothing is
stopped unless the current version is listed as active. The token is read the
same way scripts/beam-secrets.py does and is never printed. A summary goes to
artifacts/beam-stop-latest.json.
"""
from pathlib import Path
import json
import os
import re
import sys
import time

root = Path(__file__).resolve().parents[1]
token = (root / ".beam-token").read_text(encoding="utf-8-sig").strip()
os.environ["BEAM_TOKEN"] = token
import beam  # noqa: E402,F401  Select Beam gateway defaults before creating SDK clients.
from beta9.channel import ServiceClient  # noqa: E402
from beta9.config import ConfigContext  # noqa: E402
from beta9.clients.gateway import ListDeploymentsRequest, StopDeploymentRequest  # noqa: E402

summary_path = root / "artifacts" / "beam-stop-latest.json"
summary_path.parent.mkdir(exist_ok=True)


def finish(status, **extra):
    data = {"status": status, "time": time.strftime("%Y-%m-%d %H:%M:%S"), **extra}
    summary_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n== " + status + " ==", json.dumps(extra, ensure_ascii=False), flush=True)
    sys.exit(0 if status == "done" else 1)


match = re.search(r"https://(ruhua-api)-[a-z0-9]+-v(\d+)\.app\.beam\.cloud", (root / ".env.local").read_text(encoding="utf-8-sig"))
if not match:
    finish("failed", step="read-current", detail=".env.local has no ruhua-api URL")
name, current = match.group(1), int(match.group(2))
print(f"Site uses {name} v{current}; stopping older active versions of {name} only.", flush=True)

config = ConfigContext(token=token, gateway_host="gateway.beam.cloud", gateway_port=443)
with ServiceClient(config=config) as client:
    listed = client.gateway.list_deployments(ListDeploymentsRequest(limit=500))
    if not listed.ok:
        finish("failed", step="list", detail=listed.err_msg)
    rows = sorted((d for d in listed.deployments if d.name == name), key=lambda d: d.version)
    table = [{"version": d.version, "active": d.active, "id": d.id, "type": d.stub_type} for d in rows]
    for row in table:
        print(f"  v{row['version']:<3} {'active ' if row['active'] else 'stopped'} {row['id']}", flush=True)
    if not any(d.version == current and d.active for d in rows):
        finish("failed", step="safety", detail=f"v{current} is not listed as active; nothing stopped", deployments=table)
    stopped, errors = [], []
    for d in rows:
        if d.active and d.version < current:
            result = client.gateway.stop_deployment(StopDeploymentRequest(id=d.id))
            (stopped if result.ok else errors).append({"version": d.version, "id": d.id, **({} if result.ok else {"error": result.err_msg})})
            print(f"  stop v{d.version}: {'ok' if result.ok else 'FAILED ' + result.err_msg}", flush=True)
finish("done" if not errors else "failed", current=current, stopped=stopped, errors=errors)
