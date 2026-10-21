// 「走进世界」漫游引擎的接口约定。
// 引擎单独打包成 public/world/engine.js（源码在 world-engine/，自带 three 0.180 + Spark），
// 页面用 import(/* webpackIgnore: true */ "/world/engine.js") 按需加载，与站点里的 three 0.168 互不影响。
// 界面（摇杆、底栏、提示）全部由页面用 React 画，引擎只管画面、输入和碰撞。

/** World Labs 输出的三档高斯点：10 万、50 万、全量（约 200 万） */
export type WorldQuality = "100k" | "500k" | "full_res";
/** walk：贴地行走、受碰撞网格阻挡；fly：自由飞行，仍不穿墙 */
export type WalkMode = "walk" | "fly";

export type WorldAssets = {
  /** 各档高斯点文件地址。演示模式里可以是 .ksplat */
  splats: Partial<Record<WorldQuality, string>>;
  /** 文件格式；不给时按扩展名判断 */
  format?: "spz" | "ksplat" | "ply" | "splat";
  /** 碰撞网格（.glb，约 10–20 万三角面）。没有时用 y=0 的地面 + bounds 限制活动范围 */
  collider?: string;
  /** World Labs 的 semantics_metadata：原始单位 → 米，以及把地面移到 y=0 的偏移 */
  metricScale?: number;
  groundOffset?: number;
  /** 文件里的坐标系。World Labs 生成的是 OpenCV 约定（y 向下、z 向前），需要绕 X 轴转 180°；
      本站 SHARP 重建的首页场景同样是 OpenCV 约定 */
  coordinate?: "opencv" | "opengl";
};

export type WorldSpawn = {
  /** 换算到米、绕 X 转过之后的世界坐标；不给时站在原点、朝 -Z 看 */
  position?: [number, number, number];
  /** 弧度；0 朝 -Z */
  yaw?: number;
  pitch?: number;
};

export type WorldStats = { fps: number; splats: number; pixelRatio: number };

export type WorldEngineOptions = {
  container: HTMLElement;
  assets: WorldAssets;
  quality: WorldQuality;
  /** 初始渲染像素比（来自 lib/perf.ts 的档位）；引擎在掉帧时可自行下调，不会超过它 */
  pixelRatio: number;
  /** 最低可降到的像素比 */
  minPixelRatio?: number;
  /** 眼睛离地高度（米），默认 1.6 */
  eyeHeight?: number;
  /** 没有碰撞网格时限制活动范围：以出生点为圆心的水平半径（米），默认 6 */
  bounds?: { radius: number };
  spawn?: WorldSpawn;
  mode?: WalkMode;
  reducedMotion?: boolean;
  /** 载入进度 0–1（下载 + 解析） */
  onProgress?: (progress: number) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  /** 大约每秒一次 */
  onStats?: (stats: WorldStats) => void;
  /** 用户第一次真正移动或转头时调用一次（页面据此收起操作提示） */
  onFirstMove?: () => void;
};

export interface WorldEngine {
  /** 换档：保持当前位置与朝向重新载入高斯点 */
  setQuality(quality: WorldQuality): Promise<void>;
  setMode(mode: WalkMode): void;
  setPixelRatio(ratio: number): void;
  /** 回到出生点 */
  resetView(): void;
  /** 暂停渲染循环（页面隐藏、打开设置面板时），恢复时继续 */
  setPaused(paused: boolean): void;
  /** 外部摇杆的移动输入：x 右、y 前，范围 -1..1；松手时传 0,0 */
  setMoveInput(x: number, y: number): void;
  /** 外部的转头输入（像素位移，与鼠标拖动同一灵敏度） */
  look(dx: number, dy: number): void;
  /** 当前画面截图（用作作品库缩略图） */
  capture(): Promise<Blob>;
  dispose(): void;
}

export type WorldEngineModule = {
  version: string;
  createWorldEngine(options: WorldEngineOptions): WorldEngine;
};
