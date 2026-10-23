"""Resident SHARP model for one GPU container.

worker.py starts this once per container with the interpreter that has torch/sharp
installed (Beam's runner Python does not). The model is loaded and warmed up a
single time; every following photo only pays for inference and export (~10 s
instead of ~55 s, of which ~47 s was importing torch and reading the 2.6GB
checkpoint from the shared volume).

The per-photo path is the CLI's own (`load_rgb` -> `predict_image` -> `save_ply`,
with the same audited vectorized PLY export as run_sharp.py), so outputs match
`sharp predict`. Protocol: one JSON request per stdin line, one reply line per
request on the original stdout ("READY {...}", "RESULT {...}", "ERROR <text>").
Everything else (library logs, prints) is sent to stderr so it cannot corrupt
the protocol.
"""
import json
import os
from pathlib import Path
import sys
import time
import traceback

PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8")
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

CHECKPOINT_NAME = "sharp_2572gikvuh.pt"
LABELS = {
    "image_load": "正在读取照片",
    "preprocessing": "正在准备模型输入",
    "inference": "正在进行 GPU 推理",
    "postprocessing": "正在整理三维几何",
    "ply_write": "正在写出三维场景",
    "preparing_preview": "正在优化场景加载",
}


def reply(kind, payload):
    PROTOCOL.write(kind + " " + (payload if isinstance(payload, str) else json.dumps(payload)) + "\n")
    PROTOCOL.flush()


class Model:
    def __init__(self):
        started = time.perf_counter()
        import importlib
        import torch
        self.torch = torch
        self.predict = importlib.import_module("sharp.cli.predict")
        self.gaussians = importlib.import_module("sharp.utils.gaussians")
        self.io = importlib.import_module("sharp.utils.io")
        imported = time.perf_counter()
        threads = max(1, int(os.environ.get("RUHUA_CPU_THREADS", "2")))
        torch.set_num_threads(threads)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        from run_sharp import patch_export
        try:
            self.vectorized_ply = patch_export(self.gaussians, self.predict)
        except (ValueError, OSError, TypeError, SyntaxError, KeyError):
            self.vectorized_ply = False
        checkpoint = os.environ.get("SHARP_CKPT", "")
        if not checkpoint:
            cached = Path(torch.hub.get_dir()) / "checkpoints" / CHECKPOINT_NAME
            checkpoint = str(cached) if cached.is_file() else ""
        state = (torch.load(checkpoint, weights_only=True) if checkpoint
                 else torch.hub.load_state_dict_from_url(self.predict.DEFAULT_MODEL_URL, progress=False))
        predictor = self.predict.create_predictor(self.predict.PredictorParams())
        predictor.load_state_dict(state)
        del state
        predictor.eval()
        self.device = torch.device("cuda")
        self.predictor = predictor.to(self.device)
        loaded = time.perf_counter()
        # The first inference selects convolution algorithms and loads kernels (15–30 s on a cold GPU).
        # Do it now on a blank frame so the first real photo runs at normal speed.
        import numpy as np
        self.predict.predict_image(self.predictor, np.zeros((512, 768, 3), dtype=np.uint8), 600.0, self.device)
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        self.ready = {
            "import_seconds": round(imported - started, 3), "model_load_seconds": round(loaded - imported, 3),
            "warmup_seconds": round(time.perf_counter() - loaded, 3), "device": torch.cuda.get_device_name(0),
            "vectorized_ply": self.vectorized_ply,
        }
        import hashlib
        self.runtime = {
            "predict_sha256": hashlib.sha256(Path(self.predict.__file__).read_bytes()).hexdigest(),
            "gaussians_sha256": hashlib.sha256(Path(self.gaussians.__file__).read_bytes()).hexdigest(),
            "torch_version": torch.__version__, "cpu_threads": torch.get_num_threads(),
            "interop_threads": torch.get_num_interop_threads(), "vectorized_ply": self.vectorized_ply,
            "resident_model": True, "gpu": self.ready["device"],
        }

    def run(self, request):
        torch = self.torch
        call_id, job_id = request.get("call_id", ""), request.get("job_id", "")
        seconds = {}
        clock = [time.perf_counter(), None]

        def phase(name):
            # Stage boundaries synchronize CUDA so GPU work is attributed to the phase that launched it.
            torch.cuda.synchronize()
            now = time.perf_counter()
            if clock[1]:
                key = clock[1] + "_seconds"
                seconds[key] = round(seconds.get(key, 0) + now - clock[0], 3)
            clock[0], clock[1] = now, name
            if name and call_id:
                try:
                    from storage import write_state
                    write_state(call_id, "running", job_id=job_id, phase=name, stage=LABELS[name], timings=dict(seconds))
                except OSError:
                    pass

        started = time.perf_counter()
        source = Path(request["input"])
        if source.is_dir():
            source = next(p for p in sorted(source.iterdir()) if p.suffix.lower() in (".png", ".jpg", ".jpeg"))
        output = Path(request["output"])
        output.mkdir(parents=True, exist_ok=True)
        phase("image_load")
        image, _, f_px = self.io.load_rgb(source)
        height, width = image.shape[:2]
        phase("inference")
        gaussians = self.predict.predict_image(self.predictor, image, f_px, self.device)
        phase("ply_write")
        ply = output / (source.stem + ".ply")
        self.predict.save_ply(gaussians, f_px, (height, width), ply)
        del gaussians
        phase(None)
        seconds["cli_total_seconds"] = round(time.perf_counter() - started, 3)
        result = {"seconds": seconds, "runtime": self.runtime}
        if request.get("preview"):
            try:
                from preview import convert_ply_to_splat
                phase("preparing_preview")
                result["preview"] = convert_ply_to_splat(ply, request["preview"], fast=True)
                phase(None)
            except (ImportError, OSError, ValueError, OverflowError) as error:
                print("Optional accelerated preview unavailable:", type(error).__name__, flush=True)
        if request.get("timings"):
            Path(request["timings"]).write_text(json.dumps(result), encoding="utf-8")
        torch.cuda.empty_cache()
        return result


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        model = Model()
    except Exception as error:  # noqa: BLE001 - reported to the worker, which falls back to the CLI
        traceback.print_exc()
        reply("FAILED", str(error)[:300] or type(error).__name__)
        return
    reply("READY", model.ready)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply("RESULT", model.run(json.loads(line)))
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            reply("ERROR", ("out of memory" if "out of memory" in str(error).lower() else type(error).__name__ + ": " + str(error))[:300])


if __name__ == "__main__":
    main()
