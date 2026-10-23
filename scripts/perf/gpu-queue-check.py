"""云端显影排队实测：预热 → 隔一会儿上传（模拟挑照片、上传）→ 记录每个阶段的时间；再立刻传第二张看热容器。
    python scripts/perf/gpu-queue-check.py <照片> [--base https://…v25…] [--wait 20] [--no-warm]
花两次 GPU（各约一分钱）和两次每日生成额度。只打印阶段与耗时，不打印凭证。"""
import argparse, json, time, urllib.request, uuid, sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("photo")
parser.add_argument("--base", default="https://ruhua-api-aa5d4d3-v25.app.beam.cloud")
parser.add_argument("--wait", type=float, default=20)
parser.add_argument("--no-warm", action="store_true")
parser.add_argument("--second", action="store_true", help="再立刻传一张，看热容器")
args = parser.parse_args()
T0 = time.time()
log = lambda *a: print(f"{time.time() - T0:7.1f}s", *a, flush=True)

def call(method, path, body=None, headers=None, timeout=180):
    req = urllib.request.Request(args.base + path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def upload():
    data = Path(args.photo).read_bytes()
    boundary = uuid.uuid4().hex
    parts = [f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\nContent-Type: image/png\r\n\r\n".encode(), data, b"\r\n"]
    for k, v in (("render_video", "false"), ("enhance", "false")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    parts.append(f"--{boundary}--\r\n".encode())
    return call("POST", "/generate", b"".join(parts), {"Content-Type": "multipart/form-data; boundary=" + boundary})

def follow(accepted):
    token = {"X-Ruhua-Token": accepted["job_token"]}
    started, last = time.time(), None
    while True:
        st = call("GET", "/status/" + accepted["call_id"], headers=token, timeout=60)
        key = (st.get("status"), st.get("stage"))
        if key != last:
            log(f"[{time.time() - started:5.1f}s since upload]", st.get("status"), "·", st.get("stage") or st.get("message") or "")
            last = key
        if st.get("status") in ("done", "error"):
            return st
        time.sleep(1.5)

if not args.no_warm:
    log("warm →", call("POST", "/warm", b"{}", {"Content-Type": "application/json"}))
    time.sleep(args.wait)
log("upload …")
first = upload(); log("accepted")
done = follow(first)
print(json.dumps({k: done.get(k) for k in ("status", "total_seconds", "predict_seconds", "preview_seconds", "timings", "runtime")}, ensure_ascii=False, indent=1))
if args.second:
    log("second upload right away …")
    second = upload(); log("accepted")
    done2 = follow(second)
    print(json.dumps({k: done2.get(k) for k in ("status", "total_seconds", "predict_seconds", "timings")}, ensure_ascii=False, indent=1))
