// 按硬件分档，决定实时预览的渲染分辨率和导出视频的分辨率。
// 只影响“怎么画”，不影响场景数据：场景始终是全量点数。

import { isDesktopApp } from "./desktop";

// ultra（极致）：独立显卡专属，更高超采样、2560 宽导出，并开启界面的光线追踪背景。
export type PerfTier = "ultra" | "high" | "mid" | "low";
export type PerfChoice = "auto" | PerfTier;

export type PerfProfile = {
  tier: PerfTier;
  gpu: string;
  /** 实时预览的像素比上限（>设备像素比即超采样） */
  maxPixelRatio: number;
  /** 帧率不够时最低可降到的像素比 */
  minPixelRatio: number;
  /** 导出视频的宽度 */
  exportWidth: number;
  exportBitrate: number;
  /** 导出帧率：极致档 60fps，其余 30fps */
  exportFps: number;
  /** 导出预计超过这个秒数时，自动降到 fallbackExportWidth，保证导出不会等太久 */
  exportBudgetSeconds: number;
  fallbackExportWidth: number;
  /** 界面是否使用光线追踪背景 */
  rayTracedUi: boolean;
};

export const PERF_LABELS: Record<PerfTier, string> = { ultra: "极致", high: "高", mid: "均衡", low: "流畅" };
export const PERF_EVENT = "ruhua-perf-change";

const KEY = "ruhua-perf-choice";

export function readPerfChoice(): PerfChoice {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "ultra" || value === "high" || value === "mid" || value === "low") return value;
  } catch {}
  return "auto";
}
export function savePerfChoice(choice: PerfChoice) {
  try { if (choice === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch {}
  // 工作室和界面背景都跟着画质走：通知已经打开的组件
  try { window.dispatchEvent(new CustomEvent(PERF_EVENT, { detail: choice })); } catch {}
}

/** 独立显卡（NVIDIA、AMD RX、Intel Arc 独显）。核显、软件渲染返回 false。 */
export function hasDiscreteGpu(): boolean {
  const gpu = gpuName().toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(gpu)) return false;
  return /nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|radeon\(tm\) rx|arc\(tm\) a\d|intel.*arc a\d/.test(gpu);
}

let cachedGpu: string | undefined;
/** 显卡型号（WebGL 报告的渲染器名）。拿不到时返回空串。 */
export function gpuName(): string {
  if (cachedGpu !== undefined) return cachedGpu;
  cachedGpu = "";
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      cachedGpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {}
  return cachedGpu;
}

export function detectTier(): PerfTier {
  const gpu = gpuName().toLowerCase();
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8;
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(gpu)) return "low";
  // 独显：客户端里默认拉到极致（网页版保持“高”，极致可手动选）；CPU 或内存偏弱的机器退一档
  if (hasDiscreteGpu()) return cores >= 6 && memory >= 8 ? (isDesktopApp() ? "ultra" : "high") : "mid";
  if (/iris xe|radeon\(tm\) graphics|radeon graphics|780m|760m|680m|apple m\d/.test(gpu)) return cores >= 8 ? "mid" : "low";
  if (/intel/.test(gpu)) return "low"; // 较老的 Intel 核显
  return cores >= 8 && memory >= 8 ? "mid" : "low";
}

export function perfProfile(choice: PerfChoice = readPerfChoice()): PerfProfile {
  const tier = choice === "auto" ? detectTier() : choice;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const gpu = gpuName();
  if (tier === "ultra") return { tier, gpu, maxPixelRatio: Math.min(2.5, Math.max(dpr * 1.5, 2)), minPixelRatio: 1.25, exportWidth: 2560, exportBitrate: 40_000_000, exportFps: 60, exportBudgetSeconds: 60, fallbackExportWidth: 1920, rayTracedUi: true };
  if (tier === "high") return { tier, gpu, maxPixelRatio: Math.min(2, Math.max(dpr, 1.5)), minPixelRatio: 1, exportWidth: 1920, exportBitrate: 16_000_000, exportFps: 30, exportBudgetSeconds: 60, fallbackExportWidth: 1280, rayTracedUi: false };
  if (tier === "mid") return { tier, gpu, maxPixelRatio: Math.min(dpr, 1.5), minPixelRatio: .85, exportWidth: 1920, exportBitrate: 16_000_000, exportFps: 30, exportBudgetSeconds: 75, fallbackExportWidth: 1280, rayTracedUi: false };
  return { tier, gpu, maxPixelRatio: 1, minPixelRatio: .75, exportWidth: 1280, exportBitrate: 12_000_000, exportFps: 30, exportBudgetSeconds: 90, fallbackExportWidth: 960, rayTracedUi: false };
}

/**
 * 根据实际帧间隔调节像素比：持续偏慢就降一档，持续充裕再升回去。
 * 返回新的像素比；不需要变化时返回 null。
 */
let refreshPromise: Promise<number> | undefined;
/** 屏幕刷新率（Hz）：取约 30 帧 requestAnimationFrame 间隔的中位数，结果缓存。 */
export function measureRefreshRate(): Promise<number> {
  refreshPromise ||= new Promise(resolve => {
    const stamps: number[] = [];
    const step = (now: number) => {
      stamps.push(now);
      if (stamps.length < 32) { requestAnimationFrame(step); return; }
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
      const hz = 1000 / gaps[gaps.length >> 1];
      resolve(Math.max(30, Math.min(500, Math.round(hz))));
    };
    requestAnimationFrame(step);
  });
  return refreshPromise;
}

/** 按屏幕刷新率定帧率目标：60Hz 屏保持 60fps 附近；高刷屏（如 300Hz）以 120fps 为目标，其余算力留给超采样。 */
export function frameTarget(hz: number) {
  const fps = hz >= 100 ? 120 : Math.min(hz, 60);
  const interval = 1000 / fps;
  return { fps, slowMs: Math.max(interval * 1.35, hz >= 100 ? 11 : 28), fastMs: hz >= 100 ? interval * .8 : 18.5 };
}

export function createFrameGovernor(profile: () => PerfProfile, initial: number) {
  let ratio = initial, slow = 0, fast = 0, last = 0;
  let slowMs = 28, fastMs = 18.5;
  void measureRefreshRate().then(hz => { ({ slowMs, fastMs } = frameTarget(hz)); });
  return {
    get ratio() { return ratio; },
    set(value: number) { ratio = value; slow = fast = 0; },
    /** 每帧调用一次；paused 时（录制、页面隐藏）只重置计时。 */
    tick(now: number, paused = false): number | null {
      const delta = last ? now - last : 16;
      last = now;
      if (paused || delta > 250) { slow = fast = 0; return null; } // 切走再回来的长间隔不算
      const { minPixelRatio, maxPixelRatio } = profile();
      if (delta > slowMs) { slow += delta; fast = 0; } else if (delta < fastMs) { fast += delta; slow = 0; } else { slow = fast = 0; }
      if (slow > 1500 && ratio > minPixelRatio + .01) {
        ratio = Math.max(minPixelRatio, +(ratio - .25).toFixed(2)); slow = 0; return ratio;
      }
      if (fast > 4000 && ratio < maxPixelRatio - .01) {
        ratio = Math.min(maxPixelRatio, +(ratio + .25).toFixed(2)); fast = 0; return ratio;
      }
      return null;
    },
  };
}
