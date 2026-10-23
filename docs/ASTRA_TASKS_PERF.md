# ASTRA 任务书 · 性能与云端稳定性（2026-10-23）

背景：用户反馈四个问题——生成世界卡在最后一步、云端渲染一直排队、点「走进世界」要等很久、手机卡顿发热；
另外要特别优化国内网络。Claude 负责前端（`components/`、`lib/`、`app/`、`world-engine/`）和部署；
你负责下面两件**互不冲突**的事。**不要修改这些文件**：`components/**`、`lib/**`、`app/**`、`world-engine/**`、
`backend/beam/{gateway,worker,world,storage,security,beam_app,sharp_server}.py`（Claude 正在改，发现问题写进报告即可）。
完成后把结果写进 `docs/ASTRA_REPORT_PERF.md`（一行一个可验证结论：做了什么、怎么验证、结果数字）。不要 commit 到 main，不要部署 Beam / Netlify。

## T1 · GitHub Actions 上的 iOS 模拟器测试（用户点名要的“GitHub 上的虚拟 iOS 环境”）

目标：在 macOS runner 的 iOS Simulator 里用**真正的 Mobile Safari** 打开网站，拿到截图和工作量数据。

1. 新建 `.github/workflows/ios-sim.yml`：`workflow_dispatch`（输入 `url`：留空就在 runner 上构建本仓库并本地起静态服务；填了就测这个线上地址）
   + `push` 到 `ci/ios-sim` 分支时触发。runner 用 `macos-15`（仓库是公开的，免费）。
   - 构建：Node 22，`npm ci`，`npx next build`（静态导出到 `out/`），环境变量 `NEXT_PUBLIC_BEAM_API=https://ruhua-api-aa5d4d3-v24.app.beam.cloud`
     （以后版本号会变：做成 workflow 输入，默认值用这个）。`public/world/engine.js` 已在仓库里，不需要构建 world-engine。
   - 静态服务：`out/` 用任意静态服务器（如 `npx serve out -l 3000`，注意 `.js` 的 MIME）。
2. 驱动 Safari：用 `safaridriver`（`sudo safaridriver --enable`）+ WebDriver 能力
   `{"platformName":"iOS","safari:useSimulator":true,"safari:deviceType":"iPhone"}`（或指定 `safari:deviceName` 为 runner 上有的 iPhone 机型），
   脚本写在 `scripts/perf/ios-sim.mjs`（webdriverio 或 selenium-webdriver，作为 devDependency 只在 workflow 里 `npm i --no-save` 装，不要改 package.json 的依赖）。
3. 场景（与 `scripts/perf/phone-load.cjs` 对齐，先读这个文件）：
   - 首页展示页静置 8 秒 → 点「直接进入」→ 概览静置 8 秒 → 慢慢滚到底再滚回 → 「创作」页 → 「作品库」页。
   - 页面加载后用 `executeScript` 注入计数：对每个 `canvas` 调 `getContext('webgl2') || getContext('webgl')` 拿到**已有的**上下文，
     包装它的 `drawArrays/drawElements/drawArraysInstanced/drawElementsInstanced`，按 `document.timeline.currentTime` 归帧，
     统计每个画布每秒帧数、像素/秒；再统计 `requestAnimationFrame` 次数（包装 window.requestAnimationFrame）、`document.getAnimations()` 中无限循环的数量；
     以及每段的长任务（`PerformanceObserver` longtask 如果 Safari 不支持就跳过）与 `performance.now()` 帧间隔分布（自己挂一个 rAF 采样 p50/p95 帧间隔）。
   - 每个场景 `xcrun simctl io booted screenshot` 截图。
   - 「走进世界」引擎单测：写一个 `scripts/perf/ios/world-test.html`（不放进 public，由 runner 的静态服务额外挂载），
     `import('/world/engine.js')` 后 `createWorldEngine` 载入这三个公开文件（World Labs CDN，无签名）：
     100k `https://cdn.marble.worldlabs.ai/5bfe2aa9-240e-40ec-a325-8a227a81e3f6/dc80afc3-313d-4740-9930-c64e05a6cdd6_sand_100k.spz`，
     500k `https://cdn.marble.worldlabs.ai/5bfe2aa9-240e-40ec-a325-8a227a81e3f6/1e47e85b-e670-40e1-9f89-3bfa028b19cf_sand_500k.spz`，
     碰撞网格 `https://cdn.marble.worldlabs.ai/5bfe2aa9-240e-40ec-a325-8a227a81e3f6/9ea4c254.glb`；接口见 `lib/world-engine-types.ts`，
     参考 `world-engine/test/index.html`。记录从调用到 `onReady` 的秒数、之后 8 秒的帧数。
   - 结果写 `ios-sim-results.json`，连同截图用 `actions/upload-artifact` 上传。
4. 先在本机把脚本逻辑用 Playwright WebKit 跑通一遍（`npx playwright install webkit`），再推到 `ci/ios-sim` 分支跑 Actions
   （`gh workflow run` / `gh run watch`，仓库 `shihshdh/pixel-reconstruction`）。可以推这个分支，不要推 main。
   GitHub runner 的模拟器没有真 GPU，帧率不代表真机——报告里重点写“能不能正常显示、有没有报错、各画布在空闲时是不是还在一直画”。
5. 报告里附：最后一次成功运行的链接、截图列表、results.json 的摘要。

## T2 · 后端新逻辑的测试与审阅（只新增测试文件）

Claude 刚改了 GPU 排队相关的后端（未部署），请为它写离线测试并审阅：
- 新文件 `backend/beam/test_gpu_queue.py`（unittest，沿用 `test_world.py` 的写法：`patch.object(storage, "ROOT", 临时目录)`，网络全部 mock）。
- 覆盖：
  1. `gateway.dispatch_job` 记录 `beam-tasks/<call_id>.json`（task_id、payload、dispatches）。
  2. `gateway.watch_queue`：等待 <15 秒不查 Beam；Beam 报 `PENDING` 时给出“正在唤醒云端 GPU”的 stage；`RUNNING` 时“已启动 · 正在载入模型”；
     `FAILED/ERROR/EXPIRED/TIMEOUT/CANCELLED` 或 `COMPLETE` 但状态仍是 queued 超过 30 秒 → 第一次自动重新派发、第二次记成 error；Beam 接口出错时原样返回。
  3. `/warm`：未配置 GPU 返回 warming false；同一 IP 一分钟超过 6 次被限流；已有进行中的预热只延长 `gpu-warm.json` 的 until；
     有排队/运行中的真任务时不预热；每日上限 `RUHUA_DAILY_WARMS`；预热不计入 `RUHUA_MAX_PENDING`（`storage.reserve` 只数 queued/running）。
  4. `storage.reserve` 对 jobs 写出 `gpu-demand.json`。
  5. `worker.warm`：状态不是 warming 时拒绝；见到 `gpu-demand.json` 的 at 晚于预热开始就立即返回；窗口 until 过了就返回（mock `wait_model_server`）。
  6. `worker.process` 在 `predict_resident` 返回 False 时走原来的 `run_sharp.py` 子进程（mock `subprocess.run`），产物文件名与状态字段和以前一致。
  7. `sharp_server.py` 的协议：用一个假的 `Model`（不导入 torch）验证 READY / RESULT / ERROR 三种行、stdout 只有协议行。
- 跑法：`cd backend/beam && D:/anaconda/envs/sharp/python.exe -m unittest discover -s . -p "test_*.py"`（这个环境有 fastapi；当前 77 个测试全过）。
- 审阅：读 `git diff -- backend/beam` 的改动，凡是你认为会出错的地方（竞态、Beam 任务队列行为、异常路径、费用风险）写进报告，标明文件和行号。
