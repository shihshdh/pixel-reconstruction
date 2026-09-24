"""Deploy from this directory: beam deploy beam_app.py:gpu / :api."""
import os

from beam import Image, QueueDepthAutoscaler, TaskPolicy, Volume, asgi, task_queue

DATA_PATH = "/ruhua-data"
DATA_VOLUME = Volume(name="ruhua-data", mount_path=DATA_PATH)
SINGLE_CONTAINER = QueueDepthAutoscaler(min_containers=0, max_containers=1, tasks_per_container=1)

# Keep nvcc: gsplat compiles CUDA kernels and cannot use a CUDA runtime-only image.
# This is the same PyTorch/CUDA family as the working local deployment.
GPU_IMAGE = (
    Image(python_version="python3.11", base_image="pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel")
    .with_envs({"TORCH_CUDA_ARCH_LIST": "8.9", "MAX_JOBS": "2", "DEBIAN_FRONTEND": "noninteractive"})
    .add_commands([
        "apt-get update && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 ninja-build && rm -rf /var/lib/apt/lists/*",
        "python -m pip install --no-cache-dir ninja gsplat==1.5.3 pillow-heif==0.21.0",
        "python -m pip install --no-cache-dir https://github.com/apple/ml-sharp/archive/refs/heads/main.zip",
        "python -c 'import torch, sharp, gsplat; print(torch.__version__)'",
    ])
)


@task_queue(
    name="ruhua-gpu", app="ruhua", image=GPU_IMAGE,
    gpu="RTX4090", gpu_count=1, cpu=2, memory="16Gi",
    workers=1, keep_warm_seconds=0, retries=0, timeout=900,
    task_policy=TaskPolicy(max_retries=0, timeout=900, ttl=2700),
    max_pending_tasks=3, authorized=True, autoscaler=SINGLE_CONTAINER,
    volumes=[DATA_VOLUME],
    env={"RUHUA_DATA": DATA_PATH, "TORCH_HOME": DATA_PATH + "/cache/torch",
         "HF_HOME": DATA_PATH + "/cache/huggingface",
         "TORCH_EXTENSIONS_DIR": DATA_PATH + "/cache/torch-extensions",
         "TORCH_CUDA_ARCH_LIST": "8.9", "MAX_JOBS": "2"},
)
def gpu(call_id: str, job_id: str, source: str = "original.jpg", render_video: bool = False, enhanced: bool = False):
    from worker import process
    return process(call_id, job_id, source, render_video, enhanced)


API_IMAGE = Image(python_version="python3.11").add_python_packages([
    "fastapi==0.115.6", "python-multipart==0.0.20", "requests==2.32.3",
    "pillow==11.0.0", "pillow-heif==0.21.0",
])

# Only server-side secrets. The browser never receives the Beam account token.
API_SECRETS = ["RUHUA_GPU_URL", "BEAM_API_TOKEN"]
if os.environ.get("RUHUA_ENABLE_ARK") == "1":
    API_SECRETS += ["ARK_API_KEY"]
# Whale companion chat: only attach the key after scripts/beam-secrets.py stored it.
if os.environ.get("RUHUA_ENABLE_ASSIST") == "1":
    API_SECRETS += ["DEEPSEEK_API_KEY"]
# Companion web search (博查 Bocha): only attach after scripts/beam-secrets.py stored it.
if os.environ.get("RUHUA_ENABLE_SEARCH") == "1":
    API_SECRETS += ["BOCHA_API_KEY"]


# Sites allowed to call the API from a browser. scripts/beam-cli.py adds the current Netlify site
# (recorded in .netlify-site.json by scripts/netlify-new-site.cjs) through RUHUA_EXTRA_ORIGINS.
ALLOWED_ORIGINS = ["https://gausssharp.netlify.app", "https://pixel-reconstruction.netlify.app",
                   "http://localhost:3000", "http://127.0.0.1:3000"]
for _origin in os.environ.get("RUHUA_EXTRA_ORIGINS", "").split(","):
    _origin = _origin.strip().rstrip("/")
    if _origin.startswith("https://") and "/" not in _origin[8:] and _origin not in ALLOWED_ORIGINS:
        ALLOWED_ORIGINS.append(_origin)


@asgi(
    name="ruhua-api", app="ruhua", image=API_IMAGE,
    cpu=0.5, memory="1Gi", workers=1, concurrent_requests=8,
    keep_warm_seconds=0, timeout=300, max_pending_tasks=20,
    authorized=False,
    autoscaler=QueueDepthAutoscaler(min_containers=0, max_containers=1, tasks_per_container=8),
    volumes=[DATA_VOLUME], secrets=API_SECRETS,
    env={"RUHUA_DATA": DATA_PATH, "RUHUA_DAILY_JOBS": "30", "RUHUA_DAILY_EDITS": "30", "RUHUA_DAILY_CHATS": "300", "RUHUA_DAILY_SEARCHES": "200",
         "RUHUA_MAX_PENDING": "3", "RUHUA_ALLOWED_ORIGINS": ",".join(ALLOWED_ORIGINS)},
)
def api():
    from gateway import create_app
    return create_app()
