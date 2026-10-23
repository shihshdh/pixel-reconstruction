- T2 最终快照：新增 backend/beam/test_gpu_queue.py 共 23 项离线测试，覆盖任务书 7 类要求与 4 项审阅回归；sharp Python 全套执行 100 项、3.195 s、100 通过、0 error、0 expectedFailure；[运行日志](../artifacts/perf/gpu-queue-tests.txt)，[7 个源码 SHA-256](../artifacts/perf/gpu-queue-source-hashes.json)；测试前后哈希一致，退出码 0。
- T2 协议：真实 sharp_server.py 的 main/reply 在 FakeModel 子进程中执行，未导入 torch；stdout 恰好 3 行 READY / RESULT / ERROR，模型日志进入 stderr；ResidentProtocolTests 正常通过。
- T2 已修复（Claude 修改，ASTRA 只写测试）：gateway.py:118 进入 admission_lock 后重新读取任务状态；原先 queued 快照覆盖 worker done 的 1 次终态覆盖可复现问题已被 test_gpu_queue.py:245 的正常断言阻止，当前结果 done。
- T2 已修复（Claude 修改）：gateway.py:118–129 在同一锁内重新检查派发记录；2 个同步进入的轮询当前仅重发 1 次，加原任务共 2 次，原先共 3 次的问题不再复现；回归 test_gpu_queue.py:259 正常通过，夹具异常不再被 expectedFailure 隐藏。
- T2 已修复（Claude 修改）：worker.py:98–110 已把 wait_model_server/Popen 启动异常纳入回退；模拟 1 个 OSError 时 predict_resident 正常返回 False，CLI 回退产物名 scene_<call_id>.ply/.splat 及 done 状态契约同时通过；回归 test_gpu_queue.py:287 与 process 测试。
- T2 已修复（Claude 修改）：storage.py:106/112 用时间戳选择 Map/volume 较新记录；模拟 Map 写失败后，volume 的 done（NOW+1）不会再被旧 Map queued（NOW）遮蔽；FakeMap 离线回归 test_gpu_queue.py:295 正常通过。
- T2 超时预算复审：worker.py 的 resident 加载/推理等待已从 420/600 s 降到 240/300 s；worker.py:210 的 CLI 使用 max(60, 840−已耗时) 秒剩余预算，Beam task 仍为 900 s；原 1740 s 串行预算已替换；仍有 P2 预算边界：45 s 文件可见性等待发生在 started 计时前，CLI 后的预览/复制也无硬时限，故不保证端到端小于 900 s，未实测 GPU 冷启动。
- T2 范围：请求全部 mock，RUHUA_STATE_MAP 置空，Map 异常另用 FakeMap；0 次真实 GPU 推理、0 次真实 Beam Map/gRPC 集成验证；[已无预期失败](../artifacts/perf/gpu-queue-expected-failures.txt)；离线通过不等同于跨容器共享卷/Map/锁的生产集成已验收。
- T1 实现：新增 .github/workflows/ios-sim.yml、scripts/perf/ios-sim.mjs、scripts/perf/ios/world-test.html 共 3 个文件；workflow_dispatch 支持空 URL 本地静态导出或自定义 URL，Beam API 为可配置输入，push ci/ios-sim 触发 macos-15/Node 22；selenium 仅 workflow 无保存安装，world-engine 仅安装类型检查依赖、不重建引擎。
- T1 本机逻辑：npx playwright install webkit 后以同一 .mjs 的 --driver webkit 完成 7/7 场景，顶层错误 0、场景 error/rejection 0；[本机最终 JSON](../artifacts/perf/ios-webkit-verified/ios-sim-results.json)；本机测试复用既有 out/，未重建 Claude 正在修改的前端，不作为其优化验收。
- T1 本机显示边界：Windows WebKit DPR=3 的 100k/500k 截图上半部各 1506762 像素均为背景色；100k 对照 DPR=1 不注入/注入分别 14664/14664 种颜色，DPR=3 不注入仅 1 种颜色；[对照统计](../artifacts/perf/webkit-ab-visual-check.json)；真实 iOS 原生截图能显示两档世界，故不把此现象外推为 iOS 黑屏。
- T1 测试服务：视频首段 bytes=0-1 和尾段 bytes=-2 均实测 206、video/mp4、2 字节，engine.js 实测 200、text/javascript；[响应记录](../artifacts/perf/static-server-check.json)；修复前[第二次运行](https://github.com/shihshdh/pixel-reconstruction/actions/runs/39930583659)虽完成 7 段，但因同一 demo-orbit.mp4 资源错误累计出现在 4 段而标红。
- T1 稳定性：逐场景及清理前保存 JSON，原生截图单次上限 120 s、最多 2 次，清理等待 15 s、场景步骤上限 15 min；[第三次运行](https://github.com/shihshdh/pixel-reconstruction/actions/runs/39932300443)因 1 次 SessionNotCreatedError 在导航前退出，已据此加入预启动 Mobile Safari 和最多 3 次仅针对该错误的会话恢复。
- T1 测量边界：每段静置目标 8 s，采用页面实际测量秒数；rAF 采样循环不计入应用 rAF，像素/秒为画布面积×绘制帧的估算而非真实 GPU fragment 数；Safari 不支持 longtask 时记 null，不编造主线程忙碌率；模拟器帧率不代表真机，100k→500k 顺序会共享缓存，不能称为两次独立冷启动。

- T1 截图恢复：[第四次运行](https://github.com/shihshdh/pixel-reconstruction/actions/runs/39933216423)第 1 次即建立 Safari 会话，landing 已完成测量且 error/rejection=0，但 simctl 30 s 超时导致站点余下 4 段跳过；两个世界仍成功，已据此延长截图等待并使截图失败不再跳过后续页面，失败仍保留为 CI 错误。

- T2 集成边界核查：Beam 官方明确跨容器卷的更改可能延迟可见，Map 最长 TTL 为 7 天（代码为 604800 s）；因此 45 s 文件等待和 Map 镜像仍需真实跨容器验证，不能从本机 100 项离线通过推断分布式锁已验收；[Volume 文档](https://docs.beam.cloud/v2/data/volume)、[Map 文档](https://docs.beam.cloud/v2/function/maps)。
- T1 启动恢复：[第五次运行](https://github.com/shihshdh/pixel-reconstruction/actions/runs/39935273751)在启动阶段停留超过 8 min 后取消；已改为优先选择现有 iPhone SE，bootstatus 上限 300 s、Safari 预启动上限 60 s、准备步骤上限 8 min；没有降低任何场景或错误判定。
