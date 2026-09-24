"""Instrument the installed SHARP CLI and avoid its per-vertex Python tuples.

No changes to model weights, inference precision, SVD algorithm or geometry.
The export patch is applied only to the exact upstream statement audited on
2026-09-19; differing source uses the upstream implementation unchanged.
"""
import argparse
import hashlib
import inspect
import json
import logging
import os
from pathlib import Path
import time

TUPLE_EXPORT = "elements[:] = list(map(tuple, attributes.detach().cpu().numpy()))"
VECTOR_EXPORT = (
    "elements[:] = np.ascontiguousarray(attributes.detach().cpu().numpy(), "
    "dtype=np.float32).view(np.dtype(dtype_full)).reshape(-1)"
)


def patch_export(gaussians, predict):
    """Fail open to the original exporter, never to a changed PLY schema."""
    original = inspect.unwrap(gaussians.save_ply)
    source = inspect.getsource(original)
    if source.count(TUPLE_EXPORT) != 1:
        return False
    # Verify the replacement against the exact old serialization on a small
    # matrix before using it with a real scene. This runs on CPU in milliseconds.
    import numpy as np
    sample = np.linspace(-3.5, 4.5, 14 * 32, dtype=np.float32).reshape(32, 14)
    dtype = np.dtype([(f"field_{index}", "f4") for index in range(14)])
    expected = np.empty(len(sample), dtype=dtype)
    expected[:] = list(map(tuple, sample))
    actual = np.ascontiguousarray(sample, dtype=np.float32).view(dtype).reshape(-1)
    if expected.tobytes() != actual.tobytes():
        return False
    namespace = dict(gaussians.__dict__)
    exec(compile(source.replace(TUPLE_EXPORT, VECTOR_EXPORT), "<ruhua-vectorized-ply>", "exec"), namespace)
    optimized = namespace[original.__name__]
    gaussians.save_ply = optimized
    predict.save_ply = optimized  # CLI imported this function by value.
    return True


class StageTimer(logging.Handler):
    PHASES = {
        "No checkpoint provided. Downloading default model from %s": "model_load",
        "Loading checkpoint from %s": "model_load",
        "Processing %s": "image_load",
        "Running preprocessing.": "preprocessing",
        "Running inference.": "inference",
        "Running postprocessing.": "postprocessing",
        "Saving 3DGS to %s": "ply_write",
    }
    LABELS = {
        "import": "正在启动推理环境",
        "model_load": "正在载入模型权重",
        "image_load": "正在读取照片",
        "preprocessing": "正在准备模型输入",
        "inference": "正在进行 GPU 推理",
        "postprocessing": "正在整理三维几何",
        "ply_write": "正在写出三维场景",
    }

    def __init__(self, call_id, job_id):
        super().__init__()
        self.call_id, self.job_id = call_id, job_id
        self.started = self.changed = time.perf_counter()
        self.phase = "import"
        self.seconds = {}
        self.torch = None
        self.logger_name = "sharp.cli.predict"
        self._publish()

    def _publish(self):
        if not self.call_id:
            return
        try:
            from storage import write_state
            write_state(self.call_id, "running", job_id=self.job_id,
                        phase=self.phase, stage=self.LABELS[self.phase], timings=dict(self.seconds))
        except OSError:
            # An intermediate progress update should not abort valid inference.
            pass

    def _sync(self):
        if self.torch is not None and self.torch.cuda.is_available():
            self.torch.cuda.synchronize()

    def switch(self, phase):
        if phase == self.phase:
            return
        self._sync()  # Attribute pending GPU work to the phase that launched it.
        now = time.perf_counter()
        key = self.phase + "_seconds"
        self.seconds[key] = round(self.seconds.get(key, 0) + now - self.changed, 3)
        self.phase, self.changed = phase, now
        self._publish()

    def emit(self, record):
        if record.name == self.logger_name and record.msg in self.PHASES:
            self.switch(self.PHASES[record.msg])

    def finish(self):
        self._sync()
        now = time.perf_counter()
        key = self.phase + "_seconds"
        self.seconds[key] = round(self.seconds.get(key, 0) + now - self.changed, 3)
        self.seconds["cli_total_seconds"] = round(now - self.started, 3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", required=True)
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("-c", "--checkpoint")
    parser.add_argument("--call-id", default="")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--timings", required=True)
    parser.add_argument("--preview-output")
    arguments = parser.parse_args()
    timer = StageTimer(arguments.call_id, arguments.job_id)

    import importlib
    import torch
    predict = importlib.import_module("sharp.cli.predict")
    gaussians = importlib.import_module("sharp.utils.gaussians")
    from sharp.utils import logging as sharp_logging
    timer.torch = torch
    timer.logger_name = predict.LOGGER.name
    # Match the two allocated physical CPU cores; avoid host-wide BLAS pools.
    threads = max(1, int(os.environ.get("RUHUA_CPU_THREADS", "2")))
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass  # Some imported builds already initialized the inter-op pool.
    metadata = {
        "predict_sha256": hashlib.sha256(Path(predict.__file__).read_bytes()).hexdigest(),
        "gaussians_sha256": hashlib.sha256(Path(gaussians.__file__).read_bytes()).hexdigest(),
        "torch_version": torch.__version__, "cpu_threads": torch.get_num_threads(),
        "interop_threads": torch.get_num_interop_threads(),
        "vectorized_ply": False,
    }
    try:
        metadata["vectorized_ply"] = patch_export(gaussians, predict)
    except (ValueError, OSError, TypeError, SyntaxError, KeyError):
        # Upstream changed: retain its unmodified save_ply rather than guessing.
        pass
    configure = sharp_logging.configure

    def configure_with_timer(*args, **kwargs):
        configure(*args, **kwargs)
        logging.getLogger().addHandler(timer)

    sharp_logging.configure = configure_with_timer
    cli_args = ["-i", arguments.input, "-o", arguments.output, "--device", "cuda", "--no-render"]
    checkpoint = arguments.checkpoint
    if not checkpoint:
        cached = Path(torch.hub.get_dir()) / "checkpoints" / "sharp_2572gikvuh.pt"
        if cached.is_file():
            checkpoint = str(cached)
    if checkpoint:
        cli_args += ["-c", checkpoint]
    try:
        predict.predict_cli.main(args=cli_args, standalone_mode=False)
    finally:
        timer.finish()
        Path(arguments.timings).write_text(json.dumps({"seconds": timer.seconds, "runtime": metadata}), encoding="utf-8")
        print("RUHUA_TIMINGS " + json.dumps({"seconds": timer.seconds, "runtime": metadata}), flush=True)

    # NumPy is already loaded in this model interpreter. Produce the preview
    # here instead of starting a new environment or looping over a million
    # records in Beam's lightweight runner. The original PLY stays unchanged.
    if arguments.preview_output:
        try:
            from preview import convert_ply_to_splat
            from storage import write_state
            ply = next(Path(arguments.output).rglob("*.ply"), None)
            if ply:
                if arguments.call_id:
                    write_state(arguments.call_id, "running", job_id=arguments.job_id,
                                phase="preparing_preview", stage="正在优化场景加载")
                stats = convert_ply_to_splat(ply, arguments.preview_output, fast=True)
                Path(arguments.timings).write_text(json.dumps({"seconds": timer.seconds, "runtime": metadata, "preview": stats}), encoding="utf-8")
        except (ImportError, OSError, ValueError, OverflowError) as error:
            # The worker retains the original scalar converter as a fallback.
            print("Optional accelerated preview unavailable:", type(error).__name__, flush=True)


if __name__ == "__main__":
    main()
