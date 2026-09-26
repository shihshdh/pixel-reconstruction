// Windows 客户端的本机显卡引擎（backend/local_engine/engine.py）：状态探测与自动重启。
// 引擎的 HTTP 接口与 Beam 网关一致，生成、状态、下载、修图都直接用 lib/api.ts。
import { isDesktopApp, startLocalEngine } from "./desktop";

export type EnginePhase = "off" | "starting" | "loading" | "ready" | "error" | "missing";
export type EngineStatus = { phase: EnginePhase; url: string; device?: string; message?: string };

/** 能接收任务的状态。模型还在载入时提交的照片会在引擎里排队，载入完成后立即处理。 */
export const engineAccepts = (status: EngineStatus) => status.phase === "loading" || status.phase === "ready";

async function health(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url + "/healthz", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.engine === "pixel-reconstruction-local-engine" ? data as { phase: string; device?: string; message?: string } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 启动并持续关注引擎。返回停止函数。 */
export function watchLocalEngine(onChange: (status: EngineStatus) => void): () => void {
  if (!isDesktopApp()) { onChange({ phase: "off", url: "" }); return () => {}; }
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let url = "", unreachableSince = 0, last = "";
  const emit = (status: EngineStatus) => {
    const key = JSON.stringify(status);
    if (key !== last && !stopped) { last = key; onChange(status); }
  };
  const later = (ms: number) => { if (!stopped) timer = setTimeout(tick, ms); };
  const start = async () => {
    try { url = (await startLocalEngine()).url; return true; }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      // 没有 NVIDIA 显卡：当作没有本机算力，页面不显示本机选项，直接用云端
      emit(/^NO_GPU/.test(message) ? { phase: "off", url: "" } : { phase: /没有找到/.test(message) ? "missing" : "error", url: "", message });
      return false;
    }
  };
  async function tick() {
    if (stopped) return;
    if (!url && !await start()) return;
    const data = await health(url);
    if (stopped) return;
    if (!data) {
      unreachableSince ||= Date.now();
      // 刚启动时 Python 导入要几秒；长时间连不上再问客户端进程是否已经退出（退出会带回原因）
      if (Date.now() - unreachableSince > 45000) { unreachableSince = 0; url = ""; if (!await start()) return; }
      emit({ phase: "starting", url });
      later(1500); return;
    }
    unreachableSince = 0;
    if (data.phase === "error") { emit(/^NO_GPU/.test(data.message || "") ? { phase: "off", url: "" } : { phase: "error", url, device: data.device, message: data.message }); return; }
    emit({ phase: data.phase === "ready" ? "ready" : "loading", url, device: data.device, message: data.message });
    later(data.phase === "ready" ? 15000 : 1500);
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
