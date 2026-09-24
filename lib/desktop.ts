// Windows 客户端（desktop/）里的本地作品文件夹。网页版里这些函数什么都不做。
// 客户端只向站点开放两个命令：往“作品”文件夹写文件、打开这个文件夹（见 desktop/src-tauri/src/main.rs）。

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
