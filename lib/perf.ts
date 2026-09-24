// 按硬件分档，决定实时预览的渲染分辨率和导出视频的分辨率。
// 只影响“怎么画”，不影响场景数据：场景始终是全量点数。

export type PerfTier = "high" | "mid" | "low";
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
};

const KEY = "ruhua-perf-choice";

export function readPerfChoice(): PerfChoice {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "high" || value === "mid" || value === "low") return value;
  } catch {}
  return "auto";
}
export function savePerfChoice(choice: PerfChoice) {
  try { if (choice === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch {}
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
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|radeon\(tm\) rx|arc\(tm\) a|intel.*arc a/.test(gpu)) return cores >= 6 && memory >= 8 ? "high" : "mid";
  if (/iris xe|radeon\(tm\) graphics|radeon graphics|780m|760m|680m|apple m\d/.test(gpu)) return cores >= 8 ? "mid" : "low";
  if (/intel/.test(gpu)) return "low"; // 较老的 Intel 核显
  return cores >= 8 && memory >= 8 ? "mid" : "low";
}

export function perfProfile(choice: PerfChoice = readPerfChoice()): PerfProfile {
  const tier = choice === "auto" ? detectTier() : choice;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  if (tier === "high") return { tier, gpu: gpuName(), maxPixelRatio: Math.min(2, Math.max(dpr, 1.5)), minPixelRatio: 1, exportWidth: 1920, exportBitrate: 16_000_000 };
  if (tier === "mid") return { tier, gpu: gpuName(), maxPixelRatio: Math.min(dpr, 1.5), minPixelRatio: .85, exportWidth: 1920, exportBitrate: 16_000_000 };
  return { tier, gpu: gpuName(), maxPixelRatio: 1, minPixelRatio: .75, exportWidth: 1280, exportBitrate: 12_000_000 };
}

/**
 * 根据实际帧间隔调节像素比：持续偏慢就降一档，持续充裕再升回去。
 * 返回新的像素比；不需要变化时返回 null。
 */
export function createFrameGovernor(profile: () => PerfProfile, initial: number) {
  let ratio = initial, slow = 0, fast = 0, last = 0;
  return {
    get ratio() { return ratio; },
    set(value: number) { ratio = value; slow = fast = 0; },
    /** 每帧调用一次；paused 时（录制、页面隐藏）只重置计时。 */
    tick(now: number, paused = false): number | null {
      const delta = last ? now - last : 16;
      last = now;
      if (paused || delta > 250) { slow = fast = 0; return null; } // 切走再回来的长间隔不算
      const { minPixelRatio, maxPixelRatio } = profile();
      if (delta > 28) { slow += delta; fast = 0; } else if (delta < 18.5) { fast += delta; slow = 0; } else { slow = fast = 0; }
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
