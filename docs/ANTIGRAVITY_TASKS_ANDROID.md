# Antigravity 任务书 · 安卓模拟器实测（2026-10-23）

背景：用户反馈网站在手机上卡顿、发热严重，「走进世界」要等很久。Claude 已改好前端的性能调度（`lib/perf.ts` 末尾的“性能调度”一节，
以及 `components/RayTracedBackdrop.tsx`、`WhaleStage.tsx`、`DiscShelf.tsx`、`SplatViewer.tsx`、`LandingSplat.tsx`、`world-engine/src/engine.ts`）。
Codex（ASTRA）在做 iOS 模拟器测试（`docs/ASTRA_TASKS_PERF.md`）。你负责**安卓**：用本机的安卓模拟器跑真 Chrome，量“改前 / 改后”的工作量与流畅度。

**不要修改** `components/`、`lib/`、`app/`、`world-engine/`、`backend/` 下的任何文件（发现问题写进报告）。只新增 `scripts/perf/android-*.cjs` 与报告。
不要 commit、不要 push、不要部署。不要花 World Labs 额度（不要点「创建场景」）。

## 环境
- Android SDK：`%LOCALAPPDATA%\Android\Sdk`（emulator、platform-tools 都在），已有 AVD `EBOOK_API34`（`~/.android/avd`）。
  启动：`emulator -avd EBOOK_API34 -gpu host -no-snapshot-save`。先确认镜像里有 Chrome（`adb shell pm list packages | findstr chrome`）；
  没有的话用系统 WebView 外壳也行，但要在报告里写明用的是什么浏览器。
- 连接：`adb forward tcp:9222 localabstract:chrome_devtools_remote`，然后 Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')`
  （仓库已装 playwright）。模拟器里访问本机用 `10.0.2.2`。
- 改前：`C:\Users\ys221\Desktop\sharp-web-baseline\out`（HEAD 的正式构建，已建好）。用静态服务器挂在 0.0.0.0:3101（注意 `.js` 的 MIME 要对）。
- 改后：Claude 的开发服务器 `http://10.0.2.2:3000`（next dev，开发模式主线程更重，只比较 GPU 与帧数，不比较主线程百分比）；
  Claude 之后会给一份正式构建，届时同样挂到 3102 再测一遍。

## 要做的
1. `scripts/perf/android-load.cjs`：复用 `scripts/perf/phone-load.cjs` 的计数注入（INSTRUMENT 里**去掉**伪装 GPU/核数那几行——安卓上用真实值），
   场景同它：展示页静置、点「直接进入」、概览静置、滚动、作品库、工作室静置 / 拖动、走进世界（测试作品与世界在 `artifacts/secure-job.json`、
   `artifacts/world-live-task.json`，复用即可，不花额度）。另外每个场景用一个 rAF 采样记录帧间隔 p50/p95/最大值，以及卡顿帧（>50ms）个数。
   截图存 `artifacts/perf/android-*.png`。
2. 跑三遍：baseline（3101）、当前开发版（3000），两份结果写 `artifacts/perf/android-baseline.json`、`artifacts/perf/android-current.json`。
3. 报告 `docs/ANTIGRAVITY_REPORT_ANDROID.md`：一行一个可验证结论，对比两版每个场景的：各画布 fps 与 Mpx/s、rAF/s、无限 CSS 动画数、帧间隔 p95、卡顿帧数，
   以及「走进世界」从点击到可走动的秒数。看到任何报错、黑屏、画面异常（截图）都写进去。模拟器的 GPU 不代表真机，结论以“工作量”与“有没有在空闲时一直画”为主。
4. 用完关掉模拟器、静态服务器和浏览器进程（用户的机器容易发热）。
