// Windows 客户端的本机显卡引擎（backend/local_engine/engine.py）：状态探测、自动重启、一键安装。
// 引擎的 HTTP 接口与 Beam 网关一致，生成、状态、下载、修图都直接用 lib/api.ts。
//
// 有 NVIDIA 显卡但还没装引擎时，客户端启动后自动在后台安装（国内镜像、断点续传，见 install-engine.ps1）；
// 用户可以暂停，暂停状态会记住，下次启动不再自动开始。中途关掉客户端，下次启动从断点继续。
import { engineInstall, isDesktopApp, startLocalEngine, type InstallProgress } from "./desktop";

export type EnginePhase = "off" | "starting" | "loading" | "ready" | "error" | "installing" | "install-paused" | "install-error";
export type EngineStatus = { phase: EnginePhase; url: string; device?: string; message?: string; install?: InstallProgress };
export type { InstallProgress };

const PAUSED_KEY = "ruhua-engine-install-paused";

/** 能接收任务的状态。模型还在载入时提交的照片会在引擎里排队，载入完成后立即处理。 */
export const engineAccepts = (status: EngineStatus) => status.phase === "loading" || status.phase === "ready";
export const engineInstalling = (status: EngineStatus) => status.phase === "installing" || status.phase === "install-paused" || status.phase === "install-error";

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

let control: { pause: () => void; resume: () => void } | null = null;
/** 暂停后台安装（已下载的部分保留，恢复时断点续传） */
export const pauseEngineInstall = () => control?.pause();
/** 开始或恢复安装 */
export const resumeEngineInstall = () => control?.resume();

/** 启动并持续关注引擎；需要时在后台安装。返回停止函数。 */
export function watchLocalEngine(onChange: (status: EngineStatus) => void): () => void {
  if (!isDesktopApp()) { onChange({ phase: "off", url: "" }); return () => {}; }
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let url = "", unreachableSince = 0, last = "", installing = false;
  const emit = (status: EngineStatus) => {
    const key = JSON.stringify(status);
    if (key !== last && !stopped) { last = key; onChange(status); }
  };
  const later = (ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, ms); };
  const paused = () => { try { return localStorage.getItem(PAUSED_KEY) === "1"; } catch { return false; } };

  // ---- 安装 ----
  async function pollInstall() {
    if (stopped) return;
    let result;
    try { result = await engineInstall("status"); } catch (error) { emit({ phase: "install-error", url: "", message: String(error) }); installing = false; return; }
    const progress = result.status;
    if (progress?.state === "done") { installing = false; url = ""; emit({ phase: "starting", url: "" }); later(300); return; }
    if (progress?.state === "error" || (!result.running && progress?.state === "running")) {
      installing = false;
      const message = progress?.error || "安装中断，请重试。";
      // 显存不足：这台电脑本来就该走云端，不再打扰
      emit(/显存/.test(message) ? { phase: "off", url: "" } : { phase: "install-error", url: "", message, install: progress || undefined });
      return;
    }
    emit({ phase: "installing", url: "", install: progress || undefined });
    timer = setTimeout(pollInstall, 1000);
  }
  async function beginInstall() {
    if (installing || stopped) return;
    installing = true;
    try { localStorage.removeItem(PAUSED_KEY); } catch {}
    try { await engineInstall("start"); }
    catch (error) { installing = false; emit({ phase: "install-error", url: "", message: String(error instanceof Error ? error.message : error) }); return; }
    emit({ phase: "installing", url: "" });
    void pollInstall();
  }
  control = {
    pause: () => {
      try { localStorage.setItem(PAUSED_KEY, "1"); } catch {}
      clearTimeout(timer); installing = false;
      void engineInstall("cancel").finally(async () => {
        const result = await engineInstall("status").catch(() => null);
        emit({ phase: "install-paused", url: "", install: result?.status || undefined });
      });
    },
    resume: () => { clearTimeout(timer); void beginInstall(); },
  };

  // ---- 引擎 ----
  const start = async () => {
    try { url = (await startLocalEngine()).url; return true; }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (/^NO_GPU/.test(message)) { emit({ phase: "off", url: "" }); return false; }
      if (/没有找到/.test(message)) {
        // 有 NVIDIA 显卡但没装引擎：接着上次的安装，或者自动在后台开始
        const result = await engineInstall("status").catch(() => null);
        if (result?.running) { installing = true; void pollInstall(); }
        else if (paused()) emit({ phase: "install-paused", url: "", install: result?.status || undefined });
        else void beginInstall();
        return false;
      }
      emit({ phase: "error", url: "", message });
      return false;
    }
  };
  async function tick() {
    if (stopped || installing) return;
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
  return () => { stopped = true; clearTimeout(timer); control = null; };
}
