// 大肥鱼的修复动作与诊断快照。
// 修复动作是固定的白名单（网关 assist.py 的 repair_site 工具只能选这里的编号），在用户自己的浏览器里执行，
// 只影响这个浏览器里本站的状态；会删数据、改设置或刷新页面的先请用户确认。不执行模型给出的任何代码。
// 诊断快照随每条消息发给网关（让她看懂问题），也随工单提交；签名链接、凭证在网关端再脱敏一次。
import { PERF_LABELS, perfProfile, readPerfChoice, savePerfChoice, type PerfTier } from "@/lib/perf";
import { forceWorldRelay } from "@/lib/world";
import { isDesktopApp } from "@/lib/desktop";

export type RepairId = "refresh_scene" | "world_relay" | "clear_world_cache" | "quality_down" | "quality_auto" | "open_check" | "reload_page";

export const REPAIRS: Record<RepairId, { label: string; confirm: boolean }> = {
  refresh_scene: { label: "刷新作品链接并重新载入场景", confirm: false },
  world_relay: { label: "世界文件改走本站中转", confirm: false },
  clear_world_cache: { label: "清除已缓存的世界文件", confirm: true },
  quality_down: { label: "画质降一档", confirm: true },
  quality_auto: { label: "画质恢复自动", confirm: false },
  open_check: { label: "打开自检面板", confirm: false },
  reload_page: { label: "重新载入页面", confirm: true },
};

/** App 监听：重新取签名链接并重新载入当前作品（见 app/page.tsx） */
export const REPAIR_SCENE_EVENT = "ruhua-repair-scene";
/** App 监听：打开 ?check 自检面板 */
export const OPEN_CHECK_EVENT = "ruhua-open-check";

const STEP_DOWN: Record<PerfTier, PerfTier> = { ultra: "high", high: "mid", mid: "low", low: "low" };

/** 执行一项修复，返回写进聊天记录的一句结果 */
export async function runRepair(id: RepairId): Promise<string> {
  switch (id) {
    case "refresh_scene":
      window.dispatchEvent(new CustomEvent(REPAIR_SCENE_EVENT));
      return "已重新获取作品链接，场景正在重新载入";
    case "world_relay":
      forceWorldRelay();
      return "世界文件已改走本站中转，重新点「走进世界」即可";
    case "clear_world_cache":
      try { await caches.delete("pr-world-v1"); return "已清除缓存的世界文件，下次进入会重新下载"; }
      catch { return "这个浏览器不允许清理缓存，可以换个浏览器试试"; }
    case "quality_down": {
      const choice = readPerfChoice();
      const current: PerfTier = choice === "auto" ? perfProfile().tier : choice;
      const next = STEP_DOWN[current];
      if (next === current) return `画质已经是最低的「${PERF_LABELS[current]}」`;
      savePerfChoice(next);
      return `画质已从「${PERF_LABELS[current]}」降到「${PERF_LABELS[next]}」，随时可以在画质菜单改回`;
    }
    case "quality_auto":
      savePerfChoice("auto");
      return "画质已恢复自动";
    case "open_check":
      window.dispatchEvent(new CustomEvent(OPEN_CHECK_EVENT));
      return "已打开自检面板";
    case "reload_page":
      setTimeout(() => location.reload(), 300);
      return "正在重新载入页面";
  }
}

// ---- 诊断快照 ----
const failures: { at: number; text: string }[] = [];
let watching = false;
/** 记下本站请求失败（状态码 ≥ 400 或网络错误），只留地址的路径部分 */
export function watchFailures() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const original = window.fetch.bind(window);
  const remember = (input: RequestInfo | URL, what: string) => {
    let path = "";
    try { const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href); path = url.host.split(".")[0] + url.pathname; } catch { path = "未知地址"; }
    failures.push({ at: Date.now(), text: `${what} ${path.slice(0, 100)}` });
    if (failures.length > 12) failures.shift();
  };
  window.fetch = async (input, init) => {
    try {
      const response = await original(input, init);
      if (response.status >= 400) remember(input, String(response.status));
      return response;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) remember(input, "网络错误");
      throw error;
    }
  };
}

function webgl() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return "不支持 WebGL2";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return String(name).slice(0, 120);
  } catch { return "检测失败"; }
}

/** 当前环境的简短诊断（键值都是短文本） */
export function diagnostics(): Record<string, string> {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; saveData?: boolean }; deviceMemory?: number };
  const now = Date.now();
  let route = "";
  try { route = sessionStorage.getItem("ruhua-world-route") || "未探测"; } catch {}
  const choice = readPerfChoice();
  return {
    网络: navigator.onLine ? `在线${nav.connection?.effectiveType ? " · " + nav.connection.effectiveType : ""}${nav.connection?.downlink ? " · " + nav.connection.downlink + " Mbps" : ""}${nav.connection?.saveData ? " · 省流量" : ""}` : "离线",
    设备: `${isDesktopApp() ? "Windows 客户端" : "网页"} · ${innerWidth}×${innerHeight} · DPR ${devicePixelRatio}${nav.deviceMemory ? " · 内存 " + nav.deviceMemory + "GB" : ""}`,
    浏览器: navigator.userAgent.slice(0, 160),
    显卡: webgl(),
    画质: choice === "auto" ? `自动（${PERF_LABELS[perfProfile().tier]}）` : PERF_LABELS[choice],
    视频导出: typeof VideoEncoder === "undefined" ? "不支持 WebCodecs" : "支持 WebCodecs",
    世界线路: route,
    最近失败的请求: failures.filter(f => now - f.at < 10 * 60 * 1000).slice(-6).map(f => f.text).join("；") || "无",
  };
}
