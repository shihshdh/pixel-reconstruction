import { assistChat, getBase, ping, warmGpu } from './api';
import { isDesktopApp } from './desktop';
import { cacheGalleryItem, getGalleryScene, listGallery, type GalleryItem } from './gallery-storage';
import { LANDING_SCENES } from './landing-scenes';
import { scenePath } from './landing-preload';
import { perfProfile, PERF_LABELS } from './perf';
import { prefetchWorld, probeWorldRoute, worldAssets, worldStartQuality, type WorldTask } from './world';

export type CheckResult = { state: 'ok' | 'warn' | 'fail' | 'idle' | 'running'; text: string; ms?: number };
export type Progress = (result: CheckResult) => void;
export const failure = (error: unknown): CheckResult => ({ state: 'fail', text: error instanceof Error ? error.message : '检查失败' });
export async function checkGateway(): Promise<CheckResult> {
  const start = performance.now(), health = await ping(), ms = Math.round(performance.now() - start);
  return { state: !health.ok ? 'fail' : health.world && health.assist ? 'ok' : 'warn', ms,
    text: `${ms} ms · ${health.ok ? '已连接' : '未连接'} · 走进世界${health.world ? '可用' : '不可用'} · 鲸鱼娘${health.assist ? '可用' : '不可用'} · ${health.serverless ? '云端 GPU 按需启动' : '固定 GPU 服务'}` };
}
export async function checkLocalEngine(): Promise<CheckResult> {
  if (!isDesktopApp()) return { state: 'ok', text: '网页版不使用本机引擎' };
  // watchLocalEngine starts Python and may install dependencies. It is not a read-only observer.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('http://127.0.0.1:47821/healthz', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('本机引擎未响应');
    const data = await response.json();
    if (data.engine !== 'pixel-reconstruction-local-engine') throw new Error('本机端口未返回引擎状态');
    return { state: data.phase === 'ready' ? 'ok' : 'warn', text: `${data.phase === 'ready' ? '已就绪' : '尚未就绪'} · ${data.device || '显卡未知'}` };
  } catch { return { state: 'warn', text: '本机引擎未响应 · 可进入主界面启动后重新检查' }; }
  finally { clearTimeout(timer); }
}
export async function checkRenderer(): Promise<CheckResult> {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return { state: 'fail', text: 'WebGL2 不可用' };
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return { state: 'ok', text: `WebGL2 · ${gpu || '显卡未知'} · ${PERF_LABELS[perfProfile().tier]}档` };
  } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
export async function checkVideo(): Promise<CheckResult> {
  if (typeof VideoEncoder === 'undefined') return { state: 'warn', text: 'VideoEncoder 不可用' };
  const results = await Promise.all([[1920, 1080, 'avc1.420028'], [2560, 1440, 'avc1.420034']].map(async ([width, height, codec]) => {
    try { return !!(await VideoEncoder.isConfigSupported({ width: Number(width), height: Number(height), codec: String(codec), framerate: 60, bitrate: 40_000_000 })).supported; }
    catch { return false; }
  }));
  return { state: results.every(Boolean) ? 'ok' : 'warn', text: `H.264 · 1080p60 ${results[0] ? '支持' : '不支持'} · 1440p60 ${results[1] ? '支持' : '不支持'}` };
}
export function completedWorlds(): WorldTask[] {
  const raw: unknown = JSON.parse(localStorage.getItem('ruhua-world-v1') || '{}');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('世界记录格式无效');
  return Object.values(raw).filter((task): task is WorldTask => !!task && task.status === 'done' && !!task.world?.splats && typeof task.started === 'number').sort((a, b) => b.started - a.started);
}
export async function checkRoute(): Promise<CheckResult> {
  const world = completedWorlds()[0]?.world;
  await probeWorldRoute(world?.thumbnail || world?.splats['100k'] || Object.values(world?.splats || {})[0]);
  const route = sessionStorage.getItem('ruhua-world-route');
  return { state: route === 'direct' || route === 'relay' ? 'ok' : 'warn', text: route === 'direct' ? '直连' : route === 'relay' ? '中转' : '尚无可探测的世界文件' };
}
async function hasScene(item: GalleryItem) {
  const scene = await getGalleryScene(item, false);
  return !!(scene.viewer || scene.ply || scene.mobile);
}
export async function checkGallery(): Promise<CheckResult> {
  const items = await listGallery(), saved = (await Promise.all(items.map(hasScene))).filter(Boolean).length;
  return { state: items.length && saved === items.length ? 'ok' : 'warn', text: `${items.length} 件作品 · ${saved} 件已离线保存场景` };
}
export async function checkWorlds(): Promise<CheckResult> {
  const tasks = completedWorlds(), world = tasks[0]?.world;
  if (!world) return { state: 'warn', text: '0 个已完成世界' };
  if (world.demo) return { state: 'warn', text: `${tasks.length} 个已完成世界 · 最近为演示场景` };
  const assets = worldAssets(world)!;
  const order = worldStartQuality() === '500k' ? ['500k', '100k', 'full_res'] as const : ['100k', '500k', 'full_res'] as const;
  const first = order.map(q => assets.splats[q]).find(Boolean);
  const urls = [...new Set([...Object.values(assets.splats), assets.collider].filter((url): url is string => !!url))];
  if (!first || !urls.length) return { state: 'warn', text: `${tasks.length} 个已完成世界 · 最近世界缺少场景文件` };
  if (!('caches' in window)) return { state: 'warn', text: `${tasks.length} 个已完成世界 · Cache Storage 不可用` };
  const cache = (await caches.has('pr-world-v1')) ? await caches.open('pr-world-v1') : undefined;
  const hits = await Promise.all(urls.map(async url => { const u = new URL(url, location.href); return !!await cache?.match(u.origin + u.pathname); }));
  const initialReady = [first, assets.collider].filter(Boolean).every(url => hits[urls.indexOf(url!)]);
  return { state: initialReady ? 'ok' : 'warn', text: `${tasks.length} 个已完成世界 · 最近文件 ${hits.filter(Boolean).length} / ${urls.length} 已缓存 · 首次进入${initialReady ? '已就绪' : '未就绪'}` };
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function wakeGpu(update: Progress, signal: AbortSignal): Promise<CheckResult> {
  const base = getBase();
  if (!base || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) return { state: 'warn', text: '当前地址不支持云端唤醒' };
  warmGpu();
  // ping strips GPU readiness fields; never mistake gateway ok/device for GPU readiness.
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    update({ state: 'running', text: `已发送唤醒请求 · 约 1 分钟 · 剩余 ${Math.ceil((end - Date.now()) / 1000)} 秒（接口不确认结果）` });
    await wait(1000, signal);
  }
  return { state: 'warn', text: '预计等待已结束 · 接口未提供 GPU 就绪状态，需实际确认' };
}
export async function cacheLanding(update: Progress, signal: AbortSignal): Promise<CheckResult> {
  let bytes = 0, done = 0;
  const text = () => `${done} / ${LANDING_SCENES.length} · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  for (const scene of LANDING_SCENES) {
    signal.throwIfAborted();
    update({ state: 'running', text: text() });
    const response = await fetch(scenePath(scene).path, { signal });
    if (!response.ok) throw new Error(`${scene.name} · HTTP ${response.status} · ${text()}`);
    const reader = response.body?.getReader();
    if (reader) { try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; update({ state: 'running', text: text() }); } } finally { reader.releaseLock(); } }
    else bytes += (await response.arrayBuffer()).byteLength;
    done++; update({ state: 'running', text: text() });
  }
  return { state: 'ok', text: `${text()} · 下载完成` };
}
export async function cacheRecentWorld(): Promise<CheckResult> {
  const world = completedWorlds()[0]?.world;
  if (!world) return { state: 'warn', text: '没有已完成的世界' };
  await prefetchWorld(world);
  return checkWorlds();
}
export async function saveGallery(update: Progress, signal: AbortSignal): Promise<CheckResult> {
  const items = await listGallery(); let done = 0, failed = 0;
  const pending: GalleryItem[] = [];
  for (const item of items) if (!await hasScene(item)) pending.push(item);
  for (const item of pending) {
    signal.throwIfAborted(); update({ state: 'running', text: `${done} / ${pending.length} · 正在保存` });
    const saved = await cacheGalleryItem(item, { quality: 'full' });
    if (!await hasScene(saved) || saved.cacheState !== 'local') failed++;
    done++;
  }
  return { state: failed ? 'warn' : 'ok', text: `${done} / ${pending.length} · ${failed ? `${failed} 件未完整保存` : '离线保存完成'}` };
}
export async function testAssist(signal: AbortSignal): Promise<CheckResult> {
  const start = performance.now();
  const response = await assistChat([{ role: 'user', content: '你好' }], { page: '演示自检' }, signal);
  const ms = Math.round(performance.now() - start);
  return { state: response.reply?.trim() ? 'ok' : 'warn', ms, text: `${ms} ms · ${response.reply?.trim() || '未返回回复'}` };
}
