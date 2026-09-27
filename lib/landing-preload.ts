// 展示页预载：当前场景播放期间，把下一个场景的 .ksplat 读进内存、把它的原图预先解码。
// 切换时 LandingSplat 直接用内存里的数据（blob: 地址），省掉可用性探测与下载，只剩解析和上传显卡。
// 只留一个预载的场景（约 20MB）；省流量模式下不预载。
import { isDesktopApp } from "@/lib/desktop";
import { perfProfile } from "@/lib/perf";
import type { LandingScene } from "@/lib/landing-scenes";

type Nav = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

/** 这台设备该用的场景文件（与 LandingSplat 的选择一致：低档硬件与手机用轻量版） */
export function scenePath(scene: LandingScene) {
  const nav = navigator as Nav;
  // 客户端里文件在本地，不必为流量省；只有低档硬件才用轻量版首页场景
  const profile = isDesktopApp() ? perfProfile() : null;
  const low = profile ? profile.tier === "low" : window.innerWidth < 768 || (nav.deviceMemory || 8) <= 4 || !!nav.connection?.saveData;
  // .ksplat 以一年的不可变缓存下发（netlify.toml）；换文件时改 version，否则回访用户会一直用旧场景
  return { path: `/scene/${scene.id}${low ? "-lo" : ""}.ksplat?v=${scene.version}`, low };
}

let slot: { path: string; blob: Promise<Blob | null>; controller: AbortController } | null = null;

export function preloadScene(scene: LandingScene) {
  if ((navigator as Nav).connection?.saveData) return;
  const { path } = scenePath(scene);
  if (slot?.path === path) return;
  slot?.controller.abort();
  const controller = new AbortController();
  const blob = fetch(path, { signal: controller.signal })
    .then(response => response.ok ? response.blob() : null)
    .catch(() => null);
  slot = { path, blob, controller };
  // 原图也先解码，切换时淡入不卡
  const img = new Image();
  img.src = `/scene/${scene.id}.jpg`;
  void img.decode?.().catch(() => {});
}

/** 取走预载好的数据（没有或还没下完时返回 null，由调用方正常下载） */
export async function takePreloaded(path: string): Promise<Blob | null> {
  if (!slot || slot.path !== path) return null;
  const current = slot;
  slot = null;
  // 下载进行中就等它完成（仍比重新开始快）
  return await current.blob;
}
