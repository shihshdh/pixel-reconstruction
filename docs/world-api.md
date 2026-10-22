# 「走进世界」后端接口约定

前端：`lib/world.ts`、`components/WorldMaker.tsx`、`components/WorldWalk.tsx`。后端：`backend/beam/world.py`，挂在 Beam 网关
（`backend/beam/gateway.py`）上，是一层很薄的代理，把 World Labs World API 转出去；**API key 只放在后端**。
API v23 起已接入（2026-10-22）。测试：`backend/beam/test_world.py`（离线）、`scripts/verify-world-live.cjs`（真实网关 + World Labs）、
`scripts/verify-world-recovery.cjs`（提交失败与找回）。

网关的 `/healthz` 没有 `world: true` 时前端自动进入“演示模式”：流程、等待与界面完全一样，最后走进的是这件作品自己的三维场景。

## 配置

| 项 | 说明 |
|---|---|
| `WORLDLABS_API_KEY` | Beam Secrets。本地只放在 git 忽略的 `.beam-tools/worldlabs.env`，由 `scripts/beam-secrets.py` 写入；World API 的鉴权头是 `WLT-Api-Key: <key>` |
| `RUHUA_DAILY_WORLDS` | 全站每天最多发起几次生成，默认 6 |
| 基础地址 | `https://api.worldlabs.ai` |
| `/healthz` | 返回里加 `"world": bool(os.environ.get("WORLDLABS_API_KEY"))`，前端据此从演示切到正式 |

## 1. 发起生成 `POST /world/generate`

请求头带作品凭证 `X-Ruhua-Token`（与 `/edit`、`/rerender` 相同的校验）。

```json
{ "job_id": "…", "model": "marble-1.1", "text_prompt": "可选", "image": "original.jpg", "request_id": "req_<32 位十六进制>" }
```

- `request_id`：前端生成的提交编号。提交实测要等二十多秒，页面中途关掉或断网时，
  前端凭它调接口 1b 找回任务；同一个编号再提交直接返回原任务，不重复花额度。
- 先查余额，不够这一档就 402（不占每日次数）；够了才记一次每日次数，再调 World Labs。

- `model`：`marble-1.0-draft` | `marble-1.1` | `marble-1.1-plus`，其他值拒绝。
- `image`：这件作品里的哪张图（默认 `original.jpg`；修图后的版本也可以）。只允许作品自己的文件名。
- 后端读出这张图，调用：

```http
POST https://api.worldlabs.ai/marble/v1/worlds:generate
WLT-Api-Key: <key>
Content-Type: application/json

{
  "display_name": "Pixel Reconstruction <job_id 前 8 位>",
  "model": "marble-1.1",
  "world_prompt": {
    "type": "image",
    "image_prompt": { "source": "data_base64", "data_base64": "<base64>", "extension": "jpg" },
    "text_prompt": "可选"
  },
  "permission": { "public": false }
}
```

  图大于约 10MB 时改用 `POST /marble/v1/media-assets:prepare_upload` 先上传，再用 `"source": "media_asset"`。
- 返回给前端：`{ "operation_id": "<World API 返回的 operation_id>" }`。
- 建议把 `operation_id → job_id` 记下来，后面两个接口校验“这个任务属于这件作品”。

## 1b. 找回提交 `GET /world/requests/{request_id}?job_id=…`

返回 `{ "operation_id": "…", "model": "…" }`；还没提交成功或请求根本没到时 404。前端的做法：
点下“创建场景”就先把任务记成“生成中”（`operationId` 为空、带 `requestId`）；服务明确拒绝（有 HTTP 状态码）就撤掉任务并显示原因；
断网或超时则继续等，轮询凭 `requestId` 找回，五分钟都找不到算失败（这种情况额度没有花）。

## 2. 查询进度 `GET /world/operations/{operation_id}?job_id=…`

转发 `GET https://api.worldlabs.ai/marble/v1/operations/{operation_id}`，**原样返回** JSON 即可。前端读这些字段：

- `done`、`error`（字符串或 `{ message }`）
- `metadata.progress.status`（`IN_PROGRESS` / `SUCCEEDED` / `FAILED`）、`metadata.world_id`
- `response`：完成时的 world 快照（可能不完整，前端会再调接口 3）。注意 World Labs 的 world 用的是 `world_id` 字段，
  不是 `id`——前后端两种都认。网关第一次看到 world_id 时记进作品目录的 `world.json`，接口 3 据此校验归属

前端轮询间隔 4 秒（页面在后台时 15 秒）。

## 3. 取世界 `GET /world/worlds/{world_id}?job_id=…`

转发 `GET https://api.worldlabs.ai/marble/v1/worlds/{world_id}`，原样返回（或包在 `{ "world": … }` 里）。前端用到：

| 字段 | 用途 |
|---|---|
| `assets.splats.spz_urls["100k" / "500k" / "full_res"]` | 三档高斯点，漫游里的“流畅 / 标准 / 精细” |
| `assets.splats.semantics_metadata.metric_scale_factor`、`ground_plane_offset` | 换算到米、地面对齐 |
| `assets.mesh.collider_mesh_url` | 碰撞网格（.glb），走路不穿墙 |
| `assets.caption` | 世界模型写的画面描述，显示在卡片和漫游界面 |
| `assets.thumbnail_url`、`assets.imagery.pano_url` | 卡片缩略图、载入时的垫底 |
| `world_marble_url` | “在 Marble 中打开” |

速写（`marble-1.0-draft`）的 `semantics_metadata` 是 `null`：没有尺度与地面偏移，引擎按 1 和 0 处理，
碰撞网格按数据自动对齐（实测 2026-10-22 对得上）。

文件都在 `cdn.marble.worldlabs.ai`，实测地址不带签名；前端仍在每次走进世界前重新调一次这个接口，以防以后改成会过期的地址。

## 跨域

漫游引擎在浏览器里直接 `fetch` 上面的 spz / glb 地址。实测（2026-10-22）`cdn.marble.worldlabs.ai` 对任何来源都返回
`Access-Control-Allow-Origin: *`，也支持 Range（206），网站、客户端（tauri.localhost）、本地开发都能直接读，不需要中转。
若以后变了，就在网关加 `GET /world/asset?url=…` 中转（只放行 World Labs 的域名），并在接口 3 返回前改写 URL。

## 费用参考（2026-10，官方定价）

| 模型 | 单张照片 | 约合 |
|---|---|---|
| marble-1.0-draft | 230 credits | $0.18 |
| marble-1.1 | 1,580 credits | $1.26 |
| marble-1.1-plus | 1,580–3,080 credits | $1.26–$2.46 |

生成标准世界约 5 分钟；速写实测约 30 秒（含提交）。高质量网格导出另收 3,500 credits，前端没有用到。
