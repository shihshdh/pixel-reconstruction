# Pixel Reconstruction · Beam Serverless 后端

本目录是独立部署包。只上传这里的 Python 源码，不上传前端、照片、`.env.local` 或账户密钥文件。

## 运行结构

浏览器 → CPU FastAPI → 私有 GPU 任务队列。CPU 与 GPU 通过 `ruhua-data` 持久卷共享任务状态与成果。

| 项目 | 配置 |
| --- | --- |
| 推理 GPU | RTX 4090，24GB 显存，1 张 |
| GPU 容器 | 2 CPU、16GiB RAM、最多 1 个、最少 0 个 |
| CPU API | 0.5 CPU、1GiB RAM、最多 1 个、最少 0 个 |
| 空闲保温 | 两者 `keep_warm_seconds=0` |
| 执行保护 | GPU 单任务 900 秒，失败不自动重试，队列最多 3 个 |
| 请求额度 | 每日最多 30 次生成/重建、30 次修图（UTC 日期） |
| 输入 | 最多 20MB，JPG/PNG/WebP/HEIC，解码后最长边 4096 |

只有 `/generate` 和 `/rerender` 会入 GPU 队列。状态轮询、文件下载、健康检查、豆包修图全在 CPU 上执行，不维持 GPU 在线。GPU 权重与 gsplat 编译缓存保存在持久卷，首次生成可能较慢。服务收缩由 Beam 调度器执行，`0` 表示不额外保温，并非承诺结束的同一毫秒计费停止。

## 部署

在 Linux/WSL 的 Python 虚拟环境安装 `beam-client==0.2.211` 并登录 Beam。进入本目录执行：

```sh
beam deploy beam_app.py:gpu
```

在 Beam 的 Secrets 页面设置以下服务端 Secret：

- `RUHUA_GPU_URL`：上述 GPU 队列的部署 URL。
- `BEAM_API_TOKEN`：允许调用该私有队列的 Beam Token。
- `ARK_API_KEY`：可选，站长的豆包修图 Key。

然后部署 CPU API：

```sh
# 已设置 ARK_API_KEY 时：
RUHUA_ENABLE_ARK=1 beam deploy beam_app.py:api

# 不提供站长豆包 Key 时：
beam deploy beam_app.py:api
```

前端只配置 **CPU API URL**，不能使用 GPU URL，也不能把 Beam Token 写进任何 `NEXT_PUBLIC_*` 变量。每次部署可能产生新版本 URL；更新前端前应先验证该 URL。不要用 `beam serve` 代替正式部署，它的开发会话会持续占用资源。

## 接口约定

- `GET /healthz`：配置与修图能力；不唤醒 GPU。
- `POST /generate`：multipart 字段 `image`、`render_video`、`enhance`；返回 `call_id`、`job_id`、仅返回一次的 `job_token` 和 `file_urls`。省钱默认 `render_video=false`，网页可自行渲染/导出运镜。
- `GET /status/{call_id}`：必须 `X-Ruhua-Token: <job_token>`（原始 Token，不带 Bearer 前缀）；返回 `queued` / `running` / `done` / `error`，以及 `stage` 和当前成果的 `file_urls`。
- `GET /files/{job_id}`：必须相同 `X-Ruhua-Token`；返回该任务所有允许文件的最新 `file_urls`。
- `GET /file/{job_id}/{filename}?expires=...&sig=...`：必须有效签名链接，返回原图、修图、PLY 或 MP4；裸文件地址拒绝访问。
- `POST /edit`（别名 `/edit-image`）：JSON `job_id`、`prompt`、`base`、`pad_ratio`、`history`；可选 `ark_api_key`、`ark_model`、`edit_strength`（`gentle` 默认，或 `balanced`）。用户 Key 只用于当前请求，不写入状态/文件或返回前端。
- `POST /rerender`：JSON `job_id`、`source`；使用修图结果重新推理。

`/edit`、`/edit-image`、`/rerender` 也必须使用该任务的 `X-Ruhua-Token`。Beam 代理会自行校验 `Authorization`，因此该头不能用于浏览器任务凭据；只有服务端调用私有 GPU 队列时使用 Beam 账户的 Authorization。任务 Token 由 32 字节安全随机数生成，持久卷只保存 SHA-256 摘要；任务 ID 本身不能授权访问。旧任务没有 `access.json` 时同样拒绝，未提供兼容绕过。前端须私密保存任务 Token，勿放入 URL 或日志。

`file_urls` 和 `file_url` 是相对于 CPU API 的路径，前端须用后端 base URL 解析。下载链接有效期 24 小时，可凭任务 Token 调用 `/files` 刷新；签名派生自服务器 Beam Secret，浏览器无法取得该 Secret。链接本身在有效期内可供持有人访问，请勿公开转发。所有响应 `Cache-Control: private, no-store`、`Referrer-Policy: no-referrer`；IP 每 60 秒最多 3 次上传，代理 IP 限流仅是补充，不能代替身份认证或全站额度。

成果文件使用 `scene_<call_id>.ply`、`camera_<call_id>.mp4` 和 `edit_<uuid>.jpg`，前端须使用接口返回的文件名，不可假定固定 `scene.ply` 或数字编辑序号。版本化文件避免重新渲染后缓存仍显示旧场景。

浏览器优先使用可选 `viewer_file=scene_<call_id>.splat`，原始 `ply_file` 始终保留用于下载。`.splat` 为当前查看器支持的每点 32 字节格式，保留全量点及 float32 XYZ，预先换算尺度和 RGBA，旋转四元数按标准格式量化为 8 位，因此不是完全无损格式。转换失败时仍返回原 PLY，不报废任务。

旧任务通过鉴权后的 `/files/{job_id}` 会为最新已完成 PLY 在 CPU 上补建预览，返回 `viewer_file` 与签名链接；再次请求直接复用，不启动 GPU。`/status` 也会发现已有预览。预览和 PLY 使用同一套 Token/24 小时签名权限，不能通过裸地址访问。

本地样本实测：1,179,648 个点，从 66,061,086 字节 PLY 转为 37,748,736 字节 `.splat`，减少 42.86%，转换耗时约 2.38 秒。使用项目固定版本查看器抽查 8,192 点：XYZ 与 RGBA 一致，尺度相对误差小于 6e-8，最大旋转误差约 0.851°；实际网络和设备的加载耗时仍需浏览器实测。

### 无损下载传输

支持原生 `DecompressionStream` 的浏览器对签名 `.splat` 请求发送 `Accept: application/vnd.pixel-reconstruction.splat+gzip`。CPU 网关先验证原有签名，再使用 `transfer.py` 对每 65,536 点的 32 字节记录按字节列重排，以 gzip level 1 压缩。响应是自定义 MIME 的传输包，不设置 HTTP `Content-Encoding`；浏览器通过 `lib/scene-transfer.ts` 恢复原始 `.splat` 后交给查看器及 IndexedDB，因此这层优化不丢点、不改坐标、颜色或旋转。

协议为 20 字节头（`PRSGZ001`、小端 uint32 原始长度、块内点数、变换编号 1）加一个 gzip 流。解码限制 320MiB，检查实际长度、gzip 校验与取消信号，并定期让出主线程。损坏包在原有三次 GET 上限内回退原文件；旧浏览器、旧 API 或节省不足 5% 时直接使用原文件。图库与查看器共享一次完整的下载及解包。

网关沿用 0.5 CPU / 1GiB 与零保温设置，编码临时缓存上限 160MiB，活跃下载有租约保护；临时缓存不写持久卷，容器终止后消失。没有增加 GPU 任务、实例或持久存储。CPU 压缩本身仍需少量计算；收益在于减少网络传输，不保证所有网络条件下同等加速。

本地 Linux Python/zlib 对真实 37,748,736 字节预览压为 27,647,024 字节，逐字节还原一致；编码约 0.96 秒，解码并校验约 0.43 秒。这是本地样本，云端及浏览器实测记录见根目录 README。

```sh
python -m unittest discover -s backend/beam -p 'test_*.py'
python scripts/benchmark-transfer.py
node scripts/test-scene-transfer.cjs
node scripts/check-asset-download.cjs
```

```sh
python backend/beam/preview.py artifacts/landing.ply artifacts/landing-preview.splat
node backend/beam/verify_preview.cjs artifacts/landing.ply artifacts/landing-preview.splat
```

当前 `sharp predict` 每个任务使用独立子进程，故每次都会加载模型；持久缓存避免重复下载权重/编译内核，但不能保留已经缩容的 GPU 显存。Beam 容器启动较快不等于整条推理、结果写卷、下载和浏览器解码会立即完成。改用 `on_start` 也无法在 `keep_warm_seconds=0` 时消除下一次冷启动；本版保持零保温以控制空闲费用，未为速度改成长驻 GPU。

### 预览转换快路径

`preview.py` 支持 `fast=True`（默认）：已有 NumPy 时按 8192 点分块处理布局、归一化与量化；无 NumPy 时保持标量实现，不自动安装包。指数仍使用原来的 `math.exp`，旋转加法顺序、取整、全部点、float32 输出布局均保持一致。混合字段、乱序属性、末块和非法数据通过测试；真实 1,179,648 点文件的两种输出 SHA-256 完全一致，本地 Linux 样本从 2.97 秒降为 0.58 秒。

GPU worker 让 `run_sharp.py` 在已经加载 NumPy 的模型解释器中生成临时预览，再原子复制到共享卷。这样避免 Beam runner 使用另一 Python 环境而找不到 NumPy；不会另启动进程、换 GPU 或改模型。快路径异常时保留旧转换，原 PLY 不变。`preview_engine` 记录实际使用 `numpy` 还是 `scalar`，`preview_seconds` 包含预览转换与最终预览复制时间。

2026-09-19 云端同图验证：v2 对照总计 50.3 秒、预览 7.143 秒；v3 总计 46.1 秒、预览 2.669 秒，`preview_engine=numpy`，点数与文件大小保持不变。预测阶段约 40.9/41.2 秒，没有把模型推理波动误称为优化。保留相同 GPU/CPU/RAM 与 min=0/max=1/keep_warm=0。

更新 GPU 路由的 Secret 后，需要重新部署 CPU API，让部署快照绑定新地址；单独更新 Secret 并等待容器缩零不足以证明切换成功。验收应检查新版本特有的 `preview_engine` 等运行时字段，然后再停旧版本。本版运行入口为 CPU API v8 / 私有 GPU v3。

### 推理阶段计时与保守加速

`run_sharp.py` 包装实际安装的 SHARP CLI，并显式使用 `--no-render`。原版 `sharp predict` 的渲染选项本来就默认关闭；只有用户要求视频时，worker 才另行执行视频渲染。`predict_seconds` 是整个预测进程耗时，包含加载和后处理，不能理解为纯 GPU 神经网络前向时间。

2026-09-19 审阅的 Apple 上游实现中，`sharp/utils/gaussians.py` 将协方差移到 CPU，以 float64 对大量 3×3 矩阵做 SVD；`save_ply` 又把数组逐行变成 Python tuple。这些操作与 CLI 导入、权重读取一起可能占据明显时间，实际占比必须看计时，不能凭约 52.7 秒的总耗时判断是哪一步慢。

当前包装器保持 SVD 算法与 float64 精度，只把 PLY 输出中的已知 tuple-list 赋值替换为 NumPy 结构化数组视图，避免逐点 Python 对象。先做小矩阵的字节一致性自检；上游语句不匹配或检查未通过就保留原实现。记录安装版本 `predict.py`、`gaussians.py` 的 SHA-256，防止 main 更新后误认自己验证过同一实现。CPU 线程数匹配分配的 2 核，未增加容器资源或保温时间。

成功结果中的 `timings` 分别给出导入、载入权重、输入读取、预处理、前向推理、后处理、PLY 写出的时间；阶段边界同步 CUDA，避免把尚未完成的 GPU 工作错误归入后一步。`runtime.vectorized_ply` 标识向量化补丁是否实际启用。

2026-09-19 GPU v2 真实云端验收：任务总耗时 55.2 秒，预测子进程 45.4 秒，紧凑预览转换 7.5 秒；导入 14.121 秒、模型加载 17.852 秒、读取 0.610 秒、预处理 0.571 秒、前向推理 2.187 秒、后处理 6.010 秒、PLY 写出 1.170 秒。向量化补丁实际启用，任务结束后 GPU 缩至零。此样本复用了磁盘权重、没有保留显存模型；总耗时没有显著低于此前约 54 秒样本，不应宣称端到端推理大幅加速。当前主要交付改进是预览文件缩小 42.86%、结果可可靠下载显示，以及各阶段可测量。

后续如果计时证明模型加载占比高，可以把 `create_predictor` / 权重载入 / `eval().to('cuda')` 放入 Beam `on_start`，任务直接调用 `predict_image` 和 `save_ply`，让同一容器连续处理排队任务时复用模型。仍保持最少 0 个、保温 0 秒；独立冷任务仍需加载。若主要耗时在 CPU SVD，应先比较 CPU 配置的总单任务成本；不要直接降低精度、改 SVD 或增加 GPU 保温来掩盖问题。

审阅依据：[Apple predict.py](https://github.com/apple/ml-sharp/blob/main/src/sharp/cli/predict.py)、[Apple gaussians.py](https://github.com/apple/ml-sharp/blob/main/src/sharp/utils/gaussians.py)。这些是可变化的 main 链接，运行时哈希才对应该次实际安装源码。

修图强度通过提示词约束修改范围与幅度，不能保证生成模型绝不改变人物。`pad_ratio>0` 的扩图另有实际合成保护：保留扩图前原图，将模型结果恢复到扩图画布的相同比例与尺寸，再把完整原图贴回中心，只有外围使用模型生成内容，此时返回 `subject_preserved=true`。中心仍会经过 JPEG 编码，但不使用模型重绘的人物；若同时要求修改原图中心，扩图模式会优先保留原图。普通修图不返回此保护标记。

Beam 的公共 ASGI 代理自动提供 CORS；这里不再添加 CORSMiddleware，避免产生浏览器不接受的重复 `Access-Control-Allow-Origin`。CORS 不是认证；任务访问由上述 Token/签名校验独立保护。每日额度是应用保护，不等于 Beam 账户级费用硬上限。安全版本上线后须停止旧版本 CPU API，否则旧地址仍可能绕过新限制。

## 验证与边界

本地语法验证：

```sh
python -m py_compile beam_app.py gateway.py storage.py worker.py
python -m unittest test_security.py
```

云端验收应包含：上传真实照片、等待 `done`、下载有效 PLY、浏览器跨域请求、再生成、待空闲后查看 GPU 容器数量为 0。GPU 镜像须保留 CUDA **devel**，因为 gsplat 可能编译 CUDA 内核；不能简单改成 runtime 镜像。当前 SHARP 安装来源是 Apple 官方仓库的 main，后续更新应在验证后固定已通过的 commit。

豆包需要有效 API Key 与支持的图片模型；新增用户 Key 不代表已经验证该账户额度。单张照片 SHARP 不会推理出可靠的完整背面，全景/多视角一致的完整三维重建需要另一条模型流程。

任务状态与照片/成果持久保存，容器停止不会删除；目前没有自动清理。请按自己的保留需求管理 Beam Volume，并查看账户是否有存储费用。

## 官方依据

- [任务队列](https://docs.beam.cloud/v2/task-queue/running-tasks)
- [ASGI 服务](https://docs.beam.cloud/v2/endpoint/web-server)
- [容器保温](https://docs.beam.cloud/v2/endpoint/keep-warm)
- [共享持久卷](https://docs.beam.cloud/v2/data/volume)
- [实时价格](https://www.beam.cloud/pricing)

2026-09-19 查到的 RTX 4090 serverless GPU 明细价为 `$0.000191667/秒`，约 `$0.69/GPU 小时`，CPU 与 RAM 另计；这不是整套配置的总价。应以实际账单和云端任务时间为准。

