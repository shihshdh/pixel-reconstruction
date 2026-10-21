# 漫游引擎（world-engine）

「走进世界」的三维漫游：three 0.180 + [Spark](https://sparkjs.dev) 2.4（World Labs 的高斯点渲染器）+ three-mesh-bvh。
单独打包成 `public/world/engine.js`，第一次走进世界时才下载；与站点里的 three 0.168 互不影响。

```bash
cd world-engine
npm install
npm run build        # → ../public/world/engine.js（约 3.2MB，Spark 的 wasm 与 worker 已内联）
```

- 接口约定：`lib/world-engine-types.ts`；页面侧：`components/WorldWalk.tsx`。
- 坐标：高斯点按 World Labs 文档换算（scale = metric_scale_factor、绕 X 转 180°、position.y = ground_plane_offset）。
  碰撞网格按数据对齐：16 种候选摆法里挑高斯点中心离网格表面中位距离最小的一种（实际导出的 .glb 轴向未必与 .spz 一致）。
- 行走：浮起的胶囊（半径 0.38，离地 0.35）负责水平碰撞；脚下射线负责重力、贴地、上台阶；
  比 53° 更陡的面不能走上去（粗碰撞网格里柜台边缘常是斜面）。没有碰撞网格时在出生点周围的圆里活动。
- 站点 CSP 没有 `unsafe-eval`：Spark 用 blob: worker 和内联 wasm，`worker-src blob:` 与 `wasm-unsafe-eval` 已足够。

## 测试

`test/index.html?spz=<url>&glb=<url>&mode=walk|fly` 是独立测试页（`window.__engine.__debug()` 返回位置、是否贴地、是否有碰撞）。
2026-10-21 用 World Labs 的厨房示例世界（500k spz + 碰撞网格）在 RTX 5070 Ti 上验收：载入 0.5s（本地），
300fps（vsync 上限），碰撞网格自动对齐，前进贴地、在柜台前停下、转身看到世界模型补出的另一半房间。
