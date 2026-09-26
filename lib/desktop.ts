// Windows 客户端（desktop/）里的本地作品文件夹。网页版里这些函数什么都不做。
// 客户端只向站点开放五个命令：往“作品”文件夹写文件、打开这个文件夹、启动与安装本机显卡引擎、切换全屏（见 desktop/src-tauri/src/main.rs），
// 外加无边框窗口的拖动、最小化、最大化和关闭（Tauri 自带的窗口权限）。

type Internals = { invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> };
type DesktopWindow = Window & { __PIXEL_DESKTOP__?: { version: string }; __TAURI_INTERNALS__?: Internals };

function api(): Internals | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as DesktopWindow;
  return w.__PIXEL_DESKTOP__ ? w.__TAURI_INTERNALS__ : undefined;
}

export const isDesktopApp = () => !!api();

/** Windows 客户端安装包：随站点一起发布（见 desktop/README.md）。 */
export const DESKTOP_DOWNLOAD = "/download/PixelReconstruction-Setup.exe";

/** 每件作品一个文件夹，名字只由任务 ID 决定，工作室导出的视频也能放回同一处。 */
export const workFolder = (jobId: string) => "scene_" + jobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

// 一次 IPC 请求太大时 WebView2 会重载页面（实测 40MB 触发），所以分块发送。
const CHUNK = 8 * 1024 * 1024;

/** 写一个文件到 作品/<folder>/<name>。失败只影响本地副本，作品库本身照常。 */
export async function saveWorkFile(folder: string, name: string, data: Blob | string): Promise<boolean> {
  const desktop = api();
  if (!desktop) return false;
  try {
    const blob = typeof data === "string" ? new Blob([data], { type: "application/json" }) : data;
    let offset = 0;
    do {
      const end = Math.min(blob.size, offset + CHUNK);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      await desktop.invoke("save_work_file", bytes, { headers: {
        "x-work-folder": folder, "x-file-name": name,
        "x-chunk-offset": String(offset), "x-chunk-final": end >= blob.size ? "1" : "0",
      } });
      offset = end;
    } while (offset < blob.size);
    return true;
  } catch (error) {
    console.warn("[客户端] 作品未能写入本地文件夹：", error);
    return false;
  }
}

/** 在资源管理器里打开作品文件夹；给出 folder 时直接打开那件作品。 */
export async function openWorksFolder(folder?: string): Promise<void> {
  await api()?.invoke("open_works_folder", { folder: folder ?? null });
}

/** 启动（或确认已在运行）本机显卡引擎，返回它的地址。找不到可用的 Python 环境时抛出原因。 */
export async function startLocalEngine(): Promise<{ url: string; python: string }> {
  const desktop = api();
  if (!desktop) throw new Error("只有 Windows 客户端可以使用本机显卡");
  return await desktop.invoke("local_engine_start") as { url: string; python: string };
}

/** 全屏无边框模式。不传参数时切换，返回切换后的状态；网页版返回 false。 */
export async function setFullscreen(on?: boolean): Promise<boolean> {
  const desktop = api();
  if (!desktop) return false;
  return await desktop.invoke("set_fullscreen", { on: on ?? null }) as boolean;
}

export type InstallProgress = {
  state: "running" | "done" | "error"; step: number; steps: number; label: string; detail: string;
  received: number; total: number; speed: number; root: string; flavor: string; error: string; updated?: number;
};
/** 本机引擎一键安装：start 在后台开始（已在进行时不重复），status 读进度，cancel 停止（已下载部分保留）。 */
export async function engineInstall(action: "start" | "status" | "cancel"): Promise<{ running: boolean; status: InstallProgress | null }> {
  const desktop = api();
  if (!desktop) throw new Error("只有 Windows 客户端可以安装本机引擎");
  const result = await desktop.invoke("local_engine_install", { action }) as { running: boolean; status: string | null };
  let status: InstallProgress | null = null;
  // 进度文件由 PowerShell 写入，可能带 BOM
  try { status = result.status ? JSON.parse(result.status.replace(/^﻿/, "")) : null; } catch {}
  return { running: result.running, status };
}

/** 无边框窗口的标题栏操作：拖动、最小化、最大化/还原、关闭。网页版里什么都不做。 */
export async function windowAction(action: "start_dragging" | "minimize" | "toggle_maximize" | "close" | "is_maximized"): Promise<unknown> {
  const desktop = api();
  if (!desktop) return undefined;
  return desktop.invoke(`plugin:window|${action}`, { label: "main" });
}

/** 按下的是标题栏的空白处（不是按钮、链接、输入框）时开始拖动窗口；双击最大化/还原。 */
export function titleBarMouseDown(event: { button: number; detail: number; target: EventTarget | null; preventDefault(): void }) {
  if (!api() || event.button !== 0) return;
  const target = event.target as Element | null;
  if (target?.closest('button, a, input, select, textarea, [role="button"], [role="radio"], [role="tab"], label')) return;
  event.preventDefault();
  void windowAction(event.detail === 2 ? "toggle_maximize" : "start_dragging");
}
