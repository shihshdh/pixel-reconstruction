// 「走进世界」：把作品的原照片交给 World Labs 的世界模型（Marble），生成一个可以走进去、四处走动的三维世界。
//
// World API 的 key 只放在后端（Beam Secrets），前端只认我们自己网关的这几个接口（完整约定见 docs/world-api.md）：
//   GET  /healthz                     返回 world: true 表示已接入
//   POST /world/generate              { job_id, model, text_prompt?, image?, request_id } → { operation_id }
//   GET  /world/requests/{request_id} 提交中途断网或关页面时，凭提交编号找回 { operation_id }
//   GET  /world/operations/{id}       World API 的 operation 原样转发即可（done / metadata.progress / response / error）
//   GET  /world/worlds/{id}           World API 的 world 原样转发即可（资源地址过期时重新取）
// 没接入时是演示模式：流程、等待、界面完全一样（等待缩短到十几秒），最后走进的是这件作品自己的三维场景。
//
// 生成标准世界约 5 分钟（速写约半分钟），所以任务按作品记在 localStorage 里：离开工作室、刷新页面、重开客户端，回来都能接着等。
import { useSyncExternalStore } from "react";
import { apiRequest, getBase, jobAuthHeaders } from "./api";
import { perfProfile, progressiveUltra } from "./perf";
import type { WorldAssets, WorldEngineModule, WorldQuality } from "./world-engine-types";

export type WorldModel = "marble-1.0-draft" | "marble-1.1" | "marble-1.1-plus";

/** 三档模型；seconds 是界面上的预计用时（只用来估进度，真实完成以接口为准） */
export const WORLD_MODELS: { value: WorldModel; label: string; sub: string; seconds: number; title: string }[] = [
  { value: "marble-1.0-draft", label: "速写", sub: "约 1 分钟", seconds: 70, title: "Marble 1.0 Draft：最快，适合先看看效果" },
  { value: "marble-1.1", label: "标准", sub: "约 5 分钟", seconds: 300, title: "Marble 1.1：完整画质" },
  { value: "marble-1.1-plus", label: "广阔", sub: "约 7 分钟", seconds: 420, title: "Marble 1.1 Plus：更大的户外或室内空间，消耗更多额度" },
];
const DEMO_SECONDS = 16;

/** 生成过程的四个阶段（按预计进度推进；World API 只报“进行中 / 完成”） */
export const WORLD_STAGES = [
  { until: .12, label: "读懂这张照片", note: "世界模型先为画面写下描述" },
  { until: .4, label: "补全镜头外的四周", note: "把一张照片延展成 360° 全景" },
  { until: .8, label: "生长成三维世界", note: "全景被抬升为数百万个高斯点" },
  { until: 1, label: "铺好地面与墙", note: "计算碰撞网格，走路时不会穿墙" },
];

export type WorldRecord = {
  id: string;
  model: WorldModel;
  /** World Labs 为画面写的描述（英文） */
  caption?: string;
  thumbnail?: string;
  pano?: string;
  marbleUrl?: string;
  splats: Partial<Record<WorldQuality, string>>;
  collider?: string;
  metricScale?: number;
  groundOffset?: number;
  demo?: boolean;
};

export type WorldTask = {
  jobId: string;
  /** 发起时用的后端；轮询与刷新都回到它 */
  base: string;
  /** World Labs 的任务编号；提交还没确认时为空，轮询凭 requestId 向后端找回 */
  operationId: string;
  /** 本次提交的编号（前端生成）：提交要等二三十秒，页面中途关掉或断网时据此找回任务 */
  requestId?: string;
  model: WorldModel;
  prompt?: string;
  started: number;
  status: "pending" | "done" | "failed";
  world?: WorldRecord;
  error?: string;
  demo?: boolean;
  /** 最近一次确认 World Labs 仍在生成的时间（界面据此显示“刚刚确认仍在生成”，而不是一根不动的进度条） */
  checkedAt?: number;
  /** 从这时起一直问不到进度（断网、服务冷启动）；问到了就清掉 */
  unreachableSince?: number;
};

// ---------------- 任务记录 ----------------
const KEY = "ruhua-world-v1";
const MAX_TASKS = 40;
let tasks: Record<string, WorldTask> | null = null;
const listeners = new Set<() => void>();

function load(): Record<string, WorldTask> {
  if (tasks) return tasks;
  tasks = {};
  try { tasks = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch {}
  return tasks!;
}
function save() {
  const all = load();
  const kept = Object.values(all).sort((a, b) => b.started - a.started).slice(0, MAX_TASKS);
  tasks = Object.fromEntries(kept.map(task => [task.jobId, task]));
  try { localStorage.setItem(KEY, JSON.stringify(tasks)); } catch {}
  listeners.forEach(listener => listener());
}
function put(task: WorldTask) {
  load()[task.jobId] = task;
  save();
  if (task.status === "pending") ensurePolling();
}

export function getWorldTask(jobId?: string | null): WorldTask | null {
  if (!jobId || typeof window === "undefined") return null;
  return load()[jobId] || null;
}
export function forgetWorld(jobId: string) {
  delete load()[jobId];
  save();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  ensurePolling();
  return () => { listeners.delete(listener); };
}
/** 这件作品的世界任务；任务状态变化（轮询结果、其他页面发起）时自动刷新 */
export function useWorldTask(jobId?: string | null): WorldTask | null {
  return useSyncExternalStore(subscribe, () => getWorldTask(jobId), () => null);
}

// ---------------- 进度估计 ----------------
export function expectedSeconds(task: Pick<WorldTask, "model" | "demo">) {
  if (task.demo) return DEMO_SECONDS;
  return WORLD_MODELS.find(m => m.value === task.model)?.seconds || 300;
}
/** 0–1。预计时间内线性推进到约 0.9，超时后越来越慢地逼近 0.97，完成时才到 1 */
export function estimateProgress(task: WorldTask, now = Date.now()) {
  if (task.status === "done") return 1;
  const t = Math.max(0, (now - task.started) / 1000) / expectedSeconds(task);
  return t < 1 ? t * .9 : .9 + .07 * (1 - Math.exp(-(t - 1) * 1.6));
}
export function stageIndex(progress: number) {
  return Math.max(0, WORLD_STAGES.findIndex(stage => progress < stage.until));
}

// ---------------- 接口 ----------------
/** 后端返回的 world 既可以是我们整理过的格式，也可以是 World API 的原样 JSON */
function normalizeWorld(raw: any, model: WorldModel): WorldRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const assets = raw.assets || {};
  const semantics = assets.splats?.semantics_metadata || {};
  const splats: Partial<Record<WorldQuality, string>> = { ...(raw.splats || {}), ...(assets.splats?.spz_urls || {}) };
  const id = raw.id || raw.world_id;
  if (!id) return undefined;
  return {
    id, model: raw.model && WORLD_MODELS.some(m => m.value === raw.model) ? raw.model : model,
    caption: assets.caption ?? raw.caption ?? undefined,
    thumbnail: assets.thumbnail_url ?? raw.thumbnail ?? undefined,
    pano: assets.imagery?.pano_url ?? raw.pano ?? undefined,
    marbleUrl: raw.world_marble_url ?? raw.marble_url ?? undefined,
    splats,
    collider: assets.mesh?.collider_mesh_url ?? raw.collider ?? undefined,
    metricScale: semantics.metric_scale_factor ?? raw.metric_scale ?? undefined,
    groundOffset: semantics.ground_plane_offset ?? raw.ground_offset ?? undefined,
  };
}
const hasSplats = (world?: WorldRecord) => !!world && Object.values(world.splats).some(Boolean);

export async function createWorld(job: { job_id: string; backend_url?: string }, options: { model: WorldModel; prompt?: string; image?: string; demo?: boolean }): Promise<WorldTask> {
  const base = job.backend_url || getBase();
  const prompt = options.prompt?.trim() || undefined;
  if (options.demo) {
    const task: WorldTask = { jobId: job.job_id, base, operationId: `demo-${Date.now()}`, model: options.model, prompt, started: Date.now(), status: "pending", demo: true };
    put(task);
    return task;
  }
  // 先记成“生成中”：界面立刻进入等待，页面在提交途中关掉也不会丢（额度在服务端已经花了）
  const requestId = "req_" + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const task: WorldTask = { jobId: job.job_id, base, operationId: "", requestId, model: options.model, prompt, started: Date.now(), status: "pending" };
  put(task);
  submitting.add(requestId);
  try {
    const result = await apiRequest<{ operation_id?: string; id?: string }>("/world/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...jobAuthHeaders(job.job_id) },
      body: JSON.stringify({ job_id: job.job_id, model: options.model, text_prompt: prompt, image: options.image || "original.jpg", request_id: requestId }),
    }, base, 120000);
    const operationId = result.operation_id || result.id;
    if (!operationId) throw Object.assign(new Error("后端没有返回生成任务编号。"), { status: 502 });
    return confirm(job.job_id, requestId, operationId) || task;
  } catch (error) {
    // 断网或超时：结果未知，界面继续等，轮询凭 requestId 找回
    if (typeof (error as { status?: unknown })?.status !== "number") return getWorldTask(job.job_id) || task;
    // 服务明确拒绝（额度、校验、每日次数）：撤掉这条任务，回到发起前并显示原因
    if (getWorldTask(job.job_id)?.requestId === requestId) forgetWorld(job.job_id);
    throw error;
  } finally {
    submitting.delete(requestId);
  }
}

/** 提交得到确认：补上任务编号（期间任务若已被换掉就不动） */
function confirm(jobId: string, requestId: string, operationId: string) {
  const current = getWorldTask(jobId);
  if (current?.requestId !== requestId || current.operationId) return current;
  const next = { ...current, operationId };
  put(next);
  return next;
}

async function fetchWorld(task: WorldTask, worldId: string) {
  const raw = await apiRequest<any>("/world/worlds/" + encodeURIComponent(worldId) + "?job_id=" + encodeURIComponent(task.jobId), { headers: jobAuthHeaders(task.jobId) }, task.base, 30000);
  return normalizeWorld(raw?.world || raw, task.model);
}

async function check(task: WorldTask) {
  if (task.demo) {
    if (Date.now() - task.started < DEMO_SECONDS * 1000) return;
    put({ ...task, status: "done", world: { id: task.operationId, model: task.model, splats: {}, demo: true, caption: task.prompt } });
    return;
  }
  if (!task.operationId) {
    // 提交还没确认（页面中途关过，或断网）：凭提交编号向后端找回；本页还在提交时不打扰
    if (!task.requestId || submitting.has(task.requestId)) return;
    try {
      const found = await apiRequest<{ operation_id?: string }>("/world/requests/" + encodeURIComponent(task.requestId) + "?job_id=" + encodeURIComponent(task.jobId), { headers: jobAuthHeaders(task.jobId) }, task.base, 30000);
      if (found.operation_id) confirm(task.jobId, task.requestId, found.operation_id);
    } catch (error) {
      // 服务端一直没有这次提交（请求没送到）：五分钟后算失败，额度没有花
      if ((error as { status?: unknown })?.status === 404 && Date.now() - task.started > 5 * 60000) put({ ...task, status: "failed", error: "提交没有送达，请重新生成。" });
    }
    return;
  }
  let raw: any;
  try {
    raw = await apiRequest<any>("/world/operations/" + encodeURIComponent(task.operationId) + "?job_id=" + encodeURIComponent(task.jobId), { headers: jobAuthHeaders(task.jobId) }, task.base, 30000);
  } catch (error) {
    const code = (error as { status?: unknown })?.status;
    // 网关明确说没有这个任务（作品记录丢了）：连续几次都这样就结束，不再一直转
    if (code === 404 || code === 403) {
      const misses = (notFound.get(task.jobId) || 0) + 1;
      notFound.set(task.jobId, misses);
      if (misses >= 3) put({ ...task, status: "failed", error: code === 403 ? "这件作品的访问凭证已失效，无法继续查询。" : "服务里找不到这次生成，请重新生成。" });
    } else if (!task.unreachableSince) put({ ...task, unreachableSince: Date.now() });
    throw error;
  }
  notFound.delete(task.jobId);
  const status = String(raw?.status || raw?.metadata?.progress?.status || "").toUpperCase();
  const error = raw?.error ? (typeof raw.error === "string" ? raw.error : raw.error.message || "生成失败") : status === "FAILED" ? "生成失败" : "";
  if (error) { put({ ...task, status: "failed", error: String(error) }); return; }
  if (!raw?.done && status !== "SUCCEEDED") { put({ ...task, checkedAt: Date.now(), unreachableSince: undefined }); return; }
  // operation 里的 world 只是快照，字段可能是空的：缺资源时按 world_id 再取一次完整的
  let world = normalizeWorld(raw.world || raw.response, task.model);
  const worldId = world?.id || raw?.metadata?.world_id;
  if (!hasSplats(world) && worldId) world = await fetchWorld(task, worldId);
  if (!hasSplats(world)) { put({ ...task, status: "failed", error: "世界已生成，但没有拿到三维文件。" }); return; }
  put({ ...task, status: "done", world, checkedAt: Date.now(), unreachableSince: undefined });
  void prefetchWorld(world);
}
const notFound = new Map<string, number>();

/** 打开漫游前刷新资源地址（World Labs 的下载地址带签名，会过期）；失败时沿用缓存的 */
export async function refreshWorld(task: WorldTask): Promise<WorldTask> {
  if (task.demo || !task.world) return task;
  try {
    const world = await fetchWorld(task, task.world.id);
    if (!hasSplats(world)) return task;
    const next = { ...task, world };
    put(next);
    return next;
  } catch { return task; }
}

// ---------------- 轮询 ----------------
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const inFlight = new Set<string>();
/** 本页正在提交的 requestId（提交返回前轮询不去找回） */
const submitting = new Set<string>();
function ensurePolling() {
  if (pollTimer || typeof window === "undefined") return;
  const tick = async () => {
    pollTimer = null;
    const pending = Object.values(load()).filter(task => task.status === "pending");
    if (!pending.length) return;
    await Promise.all(pending.map(async task => {
      if (inFlight.has(task.jobId)) return;
      inFlight.add(task.jobId);
      // 网络抖动不算失败，下一轮再问；只有接口明确报错才记失败
      try { await check(task); } catch {} finally { inFlight.delete(task.jobId); }
    }));
    // 演示任务每秒看一次；真实任务 4 秒一次，页面在后台时 15 秒一次
    const demo = pending.some(task => task.demo);
    pollTimer = setTimeout(tick, demo ? 1000 : document.hidden ? 15000 : 4000);
  };
  pollTimer = setTimeout(tick, 600);
}

// ---------------- 漫游 ----------------
/** 世界 → 漫游引擎的输入。演示模式走进的是这件作品自己的场景（与首页场景同为 OpenCV 坐标） */
export function worldAssets(world: WorldRecord, scene?: { href: string; format: "ply" | "splat" }): WorldAssets | null {
  if (world.demo) {
    if (!scene?.href) return null;
    return { splats: { "500k": scene.href }, format: scene.format, coordinate: "opencv" };
  }
  const splats = Object.fromEntries(Object.entries(world.splats).map(([q, url]) => [q, url && routeWorldUrl(url)])) as WorldRecord["splats"];
  return { splats, format: "spz", collider: world.collider && routeWorldUrl(world.collider), metricScale: world.metricScale, groundOffset: world.groundOffset, coordinate: "opencv" };
}

const ENGINE_URL = "/world/engine.js?v=2";
let enginePromise: Promise<WorldEngineModule> | null = null;
/** 漫游引擎单独打包（world-engine/，自带 three 0.180 + Spark），第一次走进世界时才下载 */
export function loadWorldEngine(): Promise<WorldEngineModule> {
  if (enginePromise) return enginePromise;
  // 引擎自带的 three 是有意的第二份（版本不同、互不共享）；载入时先让开站点那份的登记，免得它报“重复引入”的警告
  const w = window as Window & { __THREE__?: string };
  const site = w.__THREE__;
  delete w.__THREE__;
  enginePromise = (import(/* webpackIgnore: true */ ENGINE_URL) as Promise<WorldEngineModule>).catch(error => {
    enginePromise = null;
    throw new Error("漫游引擎没能载入，请检查网络后重试。" + (error instanceof Error && error.message ? `（${error.message}）` : ""));
  }).finally(() => { if (site) w.__THREE__ = site; });
  return enginePromise;
}

/**
 * 世界生成好了就在后台把走进去要用的东西先取回来：漫游引擎、最小一档高斯点、碰撞网格（进 Cache Storage）。
 * 点「走进世界」时第一档直接从缓存读，一两秒就能进去；更高的档在漫游时后台换上。
 * 省流量时不预取。
 */
const prefetched = new Set<string>();
/** 走进世界时先载入的一档：手机、核显 100k（约 1MB，一两秒进去）；独显电脑 500k（约 6MB，一进去就是清楚的画面） */
export function worldStartQuality(): WorldQuality {
  try { const profile = perfProfile(); return progressiveUltra(profile) || profile.tier === "low" ? "100k" : "500k"; } catch { return "100k"; }
}
export async function prefetchWorld(world?: WorldRecord) {
  if (!world || world.demo || typeof window === "undefined" || prefetched.has(world.id)) return;
  try { if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return; } catch {}
  prefetched.add(world.id);
  await probeWorldRoute(world.thumbnail || world.splats["100k"]);
  const idle = () => new Promise<void>(resolve => ("requestIdleCallback" in window ? requestIdleCallback(() => resolve(), { timeout: 4000 }) : setTimeout(resolve, 1200)));
  try {
    await idle();
    const engine = await loadWorldEngine();
    const order: WorldQuality[] = worldStartQuality() === "500k" ? ["500k", "100k", "full_res"] : ["100k", "500k", "full_res"];
    const first = order.map(q => world.splats[q]).find(Boolean);
    await engine.prefetch?.([first, world.collider].filter((url): url is string => !!url).map(routeWorldUrl));
  } catch { prefetched.delete(world.id); }
}

// ---------------- 国内网络 ----------------
// World Labs 的文件放在 Google Cloud Storage（cdn.marble.worldlabs.ai），国内多数网络直连不通或很慢。
// 第一次用到时先试直连（2.5 秒内取到缩略图的头几个字节算通），不通就改走本站的中转（netlify/edge-functions/world-file.ts，
// 只放行这个 CDN 的路径，结果在 Netlify 边缘缓存），客户端里走网站的中转地址。结果在本次打开期间记住。
const WORLD_CDN = "https://cdn.marble.worldlabs.ai/";
const RELAY_SITE = "https://pixel-reconstruction.netlify.app";
let route: "direct" | "relay" | null = null;
let routeProbe: Promise<void> | null = null;
function relayOrigin() {
  if (typeof location !== "undefined" && /(^|\.)netlify\.app$/.test(location.hostname)) return location.origin;
  return RELAY_SITE;
}
/** 探测一次直连是否可用（结果记在本次会话里）；在走进世界、预取之前调用 */
export function probeWorldRoute(sample?: string): Promise<void> {
  if (route) return Promise.resolve();
  try { const saved = sessionStorage.getItem("ruhua-world-route"); if (saved === "direct" || saved === "relay") { route = saved; return Promise.resolve(); } } catch {}
  if (!sample?.startsWith(WORLD_CDN)) return Promise.resolve();
  routeProbe ||= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(sample, { headers: { Range: "bytes=0-1023" }, signal: controller.signal, cache: "no-store" });
      await response.arrayBuffer();
      route = response.ok ? "direct" : "relay";
    } catch { route = "relay"; }
    finally { clearTimeout(timer); }
    try { sessionStorage.setItem("ruhua-world-route", route!); } catch {}
  })();
  return routeProbe;
}
/** World Labs 的文件地址 → 实际下载用的地址（直连不通时走本站中转） */
export function routeWorldUrl(url: string): string {
  if (route !== "relay" || !url.startsWith(WORLD_CDN)) return url;
  return relayOrigin() + "/world-file/" + url.slice(WORLD_CDN.length);
}
