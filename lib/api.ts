// Public API addresses only. Beam account credentials belong on the server.
import type { PageAction } from "./companion-actions";
import { abortReason, createAbortSignal } from './abort';
import { routeAssetUrl } from './asset-route';
const KEY = "ruhua-backend-v3";
const DEFAULT_BASE = (process.env.NEXT_PUBLIC_BEAM_API || process.env.NEXT_PUBLIC_API_URL || "").trim();
export function getDefaultBase() { return DEFAULT_BASE.replace(/\/+$/, ''); }
export function isLocalDevelopment() { return typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); }

export type JobResult = {
  job_id: string;
  ply_file: string;
  viewer_file?: string;
  mobile_viewer_file?: string;
  mp4_file: string | null;
  backend_url?: string;
  job_token?: string;
  file_urls?: Record<string, string>;
  enhanced?: boolean;
  predict_seconds?: number;
  total_seconds?: number;
};
const jobAccess = new Map<string, { token: string; files: Record<string, string> }>();
const taskJobs = new Map<string, string>();
/** Only per-work access grants are retained; never a Beam/Doubao account key. */
export function registerJobAccess(jobId: string, token?: string, files?: Record<string, string>) {
  const previous = jobAccess.get(jobId);
  jobAccess.set(jobId, { token: token || previous?.token || '', files: { ...previous?.files, ...files } });
}
function jobHeaders(jobId: string): Record<string, string> {
  const token = jobAccess.get(jobId)?.token;
  return token ? { 'X-Ruhua-Token': token } : {};
}
export async function refreshJobAccess(jobId: string, base = getBase()) {
  if (!jobAccess.get(jobId)?.token) return;
  const response = await request<{ file_urls: Record<string, string> }>('/files/' + encodeURIComponent(jobId), { headers: jobHeaders(jobId) }, base);
  registerJobAccess(jobId, undefined, response.file_urls);
  return response.file_urls;
}
/** Select once per opened work; resizing a window must not start another download. */
export function prefersMobilePreview() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches)
    || !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}
const mobilePreviews = new Map<string, Promise<Pick<JobResult, 'viewer_file' | 'mobile_viewer_file' | 'file_urls'>>>();
export async function prepareMobilePreview<T extends JobResult>(job: T): Promise<T> {
  registerJobAccess(job.job_id, job.job_token, job.file_urls);
  const source = /^scene_[a-f0-9]{32}\.splat$/.test(job.viewer_file || '') ? job.viewer_file
    : /^scene_[a-f0-9]{32}\.ply$/.test(job.ply_file) ? job.ply_file.replace(/\.ply$/, '.splat') : undefined;
  const expectedMobile = source?.replace(/\.splat$/, '_mobile.splat');
  if (job.mobile_viewer_file && (!expectedMobile || job.mobile_viewer_file === expectedMobile)) return job;
  const key = normalizeBase(job.backend_url || getBase()) + '::' + job.job_id + '::' + (source || job.viewer_file || job.ply_file);
  let pending = mobilePreviews.get(key);
  if (!pending) {
    pending = request<{ mobile_viewer_file?: string; mobile_preview?: { source_file?: string }; file_urls: Record<string, string> }>(
      '/files/' + encodeURIComponent(job.job_id) + '?preview=mobile' + (source ? '&source=' + encodeURIComponent(source) : ''), { headers: jobHeaders(job.job_id) }, job.backend_url || getBase(), 90000,
    ).then(response => {
      registerJobAccess(job.job_id, undefined, response.file_urls);
      if (!response.mobile_viewer_file) throw new Error('轻量预览暂未准备好，请重试；高清版本仍保留。');
      if (expectedMobile && (response.mobile_viewer_file !== expectedMobile || response.mobile_preview?.source_file !== source)) throw new Error('服务返回的预览与所选场景版本不一致，请稍后重试。');
      const fullCandidate = job.ply_file.replace(/\.ply$/i, '.splat');
      return { viewer_file: job.viewer_file || (response.file_urls[fullCandidate] ? fullCandidate : undefined), mobile_viewer_file: response.mobile_viewer_file, file_urls: { ...job.file_urls, ...response.file_urls } };
    }).finally(() => mobilePreviews.delete(key));
    mobilePreviews.set(key, pending);
  }
  return { ...job, ...await pending } as T;
}
export type StatusResp =
  | ({ status: "done" } & JobResult)
  | { status: "running" | "queued"; stage?: string }
  | { status: "error"; message: string };

export function normalizeBase(value: string): string {
  let raw = value.trim().replace(/\/+$/, "");
  // Keep old work IDs/cache keys intact while routing this app's older gateways
  // to the current deployment. Custom/local developer services are untouched.
  const ownedGateway = /^https:\/\/ruhua-api-aa5d4d3-v\d+\.app\.beam\.cloud$/;
  if (ownedGateway.test(raw) && ownedGateway.test(getDefaultBase())) raw = getDefaultBase();
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("请输入完整的后端地址，例如 https://…beam.cloud。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("后端地址只支持 HTTP / HTTPS，不能包含密钥、查询参数或片段。");
  }
  if (typeof location !== "undefined" && location.protocol === "https:" && url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("线上页面需要 HTTPS 后端地址。");
  }
  return raw;
}

export function getBase(): string {
  if (isLocalDevelopment()) {
    try { const saved = window.localStorage.getItem(KEY); if (saved !== null) return saved; } catch {}
  }
  return getDefaultBase();
}
export function saveBase(url: string) {
  const value = normalizeBase(url);
  try { window.localStorage.setItem(KEY, value); } catch {}
  return value;
}

function endpoint(path: string, base = getBase()) {
  const normalized = normalizeBase(base);
  if (!normalized) throw new Error("请先配置 Beam 后端地址，或选择已启动的本地算力。");
  return normalized + path;
}
async function apiError(res: Response) {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      detail = typeof parsed.detail === "string" ? parsed.detail : typeof parsed.message === "string" ? parsed.message : "";
    } catch { if (!/<[a-z][\s\S]*>/i.test(body)) detail = body.slice(0, 240); }
  } catch {}
  return new Error(detail || (res.status === 401 || res.status === 403 ? "后端拒绝访问，请检查服务端的访问设置。" : res.status === 413 ? "图片太大，请选择 20MB 以内的照片。" : res.status === 429 ? "当前任务较多，请稍后重试。" : "服务请求失败（" + res.status + "），请稍后重试。"));
}
async function request<T>(path: string, init: RequestInit = {}, base = getBase(), timeout = 30000): Promise<T> {
  const url = endpoint(path, base);
  let res: Response;
  let requestSignal: ReturnType<typeof createAbortSignal> | undefined;
  try {
    try {
      // Retry only reads. Replaying generation/edit POSTs could create duplicate paid work.
      const attempts = !init.method || init.method === 'GET' ? 3 : 1;
      for (let attempt = 0; ; attempt++) {
        requestSignal?.dispose();
        requestSignal = createAbortSignal([init.signal], timeout);
        res = await fetch(url, { ...init, signal: requestSignal.signal });
        if (attempt + 1 >= attempts || ![502, 503, 504].includes(res.status)) break;
        await res.body?.cancel();
        requestSignal.dispose();
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      }
    } catch (error) {
      if (init.signal?.aborted) throw abortReason(init.signal);
      if (requestSignal?.timedOut || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("等待服务响应超时。首次启动可能较慢，请稍后重试。");
      throw new Error("无法连接后端，请检查地址、网络和服务是否已部署。");
    }
    if (!res.ok) {
      const error = await apiError(res);
      if (init.signal?.aborted) throw abortReason(init.signal);
      if (requestSignal?.timedOut) throw new Error("等待服务响应超时。首次启动可能较慢，请稍后重试。");
      throw error;
    }
    try { return await res.json(); } catch {
      if (init.signal?.aborted) throw abortReason(init.signal);
      if (requestSignal?.timedOut) throw new Error("等待服务响应超时。首次启动可能较慢，请稍后重试。");
      throw new Error("后端返回了无效响应，请确认填写的是 API 网关地址。");
    }
  } finally { requestSignal?.dispose(); }
}

/** CPU gateway only: this probe must never allocate a GPU. */
export async function ping(base = getBase()): Promise<{ ok: boolean; device?: string; enhance?: boolean; serverless?: boolean; assist?: boolean; assist_vision?: boolean; assist_search?: boolean }> {
  if (!base) return { ok: false };
  try {
    const data = await request<{ ok?: boolean; device?: string; enhance?: boolean; serverless?: boolean; assist?: boolean; assist_vision?: boolean; assist_search?: boolean }>("/healthz", {}, base, 20000);
    // assist: the gateway has a DeepSeek key configured, so the companion can chat.
    return { ok: data.ok === true, device: data.device, enhance: !!data.enhance, serverless: !!data.serverless, assist: data.assist === true, assist_vision: data.assist_vision === true, assist_search: data.assist_search === true };
  } catch { return { ok: false }; }
}
export type UploadProgress = { sent: number; total: number; bytesPerSecond: number };

/** multipart 上传，汇报进度。慢网络下不按总时长判超时：连续 60 秒没有进展才放弃。 */
function uploadWithProgress<T>(path: string, body: FormData, base: string, onProgress: (p: UploadProgress) => void): Promise<T> {
  const url = endpoint(path, base);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, message: string) => { clearTimeout(idle); idle = setTimeout(() => { xhr.abort(); reject(new Error(message)); }, ms); };
    arm(60000, "上传长时间没有进展，请检查网络后重试。");
    xhr.upload.onprogress = event => {
      arm(60000, "上传长时间没有进展，请检查网络后重试。");
      const seconds = Math.max(.001, (performance.now() - started) / 1000);
      onProgress({ sent: event.loaded, total: event.lengthComputable ? event.total : body.get("image") instanceof File ? (body.get("image") as File).size : 0, bytesPerSecond: event.loaded / seconds });
    };
    // 照片传完后，服务端还要存档并排队，留足时间
    xhr.upload.onload = () => arm(120000, "等待服务响应超时。首次启动可能较慢，请稍后重试。");
    xhr.onerror = () => { clearTimeout(idle); reject(new Error("无法连接后端，请检查地址、网络和服务是否已部署。")); };
    xhr.onload = () => {
      clearTimeout(idle);
      const response = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status < 200 || xhr.status >= 300) { void apiError(response).then(reject); return; }
      try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("后端返回了无效响应，请确认填写的是 API 网关地址。")); }
    };
    xhr.open("POST", url);
    xhr.send(body);
  });
}

export async function submitPhoto(file: File, renderVideo: boolean, enhance: boolean, base = getBase(), onProgress?: (p: UploadProgress) => void) {
  if (file.size > 20 * 1024 * 1024) throw new Error("请选择 20MB 以内的照片。");
  const fd = new FormData();
  fd.append("image", file);
  fd.append("render_video", String(renderVideo));
  fd.append("enhance", String(enhance));
  type Accepted = { call_id: string; job_id: string; job_token?: string; file_urls?: Record<string, string> };
  const result = onProgress
    ? await uploadWithProgress<Accepted>("/generate", fd, base, onProgress)
    : await request<Accepted>("/generate", { method: "POST", body: fd }, base, 120000);
  registerJobAccess(result.job_id, result.job_token, result.file_urls);
  taskJobs.set(result.call_id, result.job_id);
  return result;
}
export async function checkStatus(callId: string, base = getBase()): Promise<StatusResp> {
  const jobId = taskJobs.get(callId) || callId;
  const result = await request<StatusResp>("/status/" + encodeURIComponent(callId), { headers: jobHeaders(jobId) }, base);
  if (result.status === 'done') {
    registerJobAccess(result.job_id, undefined, result.file_urls);
    return { ...result, job_token: jobAccess.get(result.job_id)?.token };
  }
  return result;
}
export async function editImage(jobId: string, prompt: string, padRatio = 0, base = "", history: string[] = [], apiBase = getBase(), doubao?: { apiKey: string; model?: string }, strength: 'gentle' | 'balanced' = 'gentle') {
  const result = await request<{ image: string; file_url?: string; subject_preserved?: boolean }>("/edit", { method: "POST", headers: { "Content-Type": "application/json", ...jobHeaders(jobId) }, body: JSON.stringify({ job_id: jobId, prompt, pad_ratio: padRatio, base, history, edit_strength: strength, ...(doubao?.apiKey.trim() ? { ark_api_key: doubao.apiKey.trim(), ark_model: doubao.model?.trim() || undefined } : {}) }) }, apiBase, 240000);
  if (result.file_url) registerJobAccess(jobId, undefined, { [result.image]: result.file_url });
  return result;
}
export async function requestRerender(jobId: string, source: string, base = getBase()) {
  const result = await request<{ call_id: string }>("/rerender", { method: "POST", headers: { "Content-Type": "application/json", ...jobHeaders(jobId) }, body: JSON.stringify({ job_id: jobId, source }) }, base, 120000);
  taskJobs.set(result.call_id, jobId);
  return result;
}
export type AssistMood = 'happy' | 'excited' | 'think' | 'worry' | 'sad' | 'surprise' | 'shy' | 'angry' | 'neutral';
export type AssistMessage = { role: 'user' | 'assistant'; content: string };
export type AssistSource = { title: string; url: string; site?: string };
/** Whale companion chat. The DeepSeek key stays in Beam Secrets; one attempt, never retried. */
export function assistChat(messages: AssistMessage[], context: { page: string; stage?: string; errors?: string[]; online?: boolean; page_text?: string }, signal?: AbortSignal, base = getBase(), vision?: { screen?: string; page_image?: string }) {
  return request<{ reply: string; mood: AssistMood; actions?: PageAction[]; sources?: AssistSource[] }>("/assist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages, context, ...vision }), signal }, base, 90000);
}
export function fileUrl(jobId: string, name: string, base = getBase()) {
  if (!base) return "";
  const signed = jobAccess.get(jobId)?.files[name];
  if (signed) {
    const url = new URL(signed, normalizeBase(base) + '/');
    const origin = normalizeBase(url.origin);
    return routeAssetUrl(origin + url.pathname + url.search);
  }
  return routeAssetUrl(endpoint("/file/" + encodeURIComponent(jobId) + "/" + encodeURIComponent(name), base));
}

import { downloadAsset, type DownloadProgress } from './asset-download';
export function downloadJobFile(jobId: string, name: string, base = getBase(), options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void; restart?: boolean } = {}) {
  return downloadAsset(fileUrl(jobId, name, base), {
    ...options,
    key: `${normalizeBase(base)}::${jobId}::${name}`,
    refreshUrl: async () => { await refreshJobAccess(jobId, base); return fileUrl(jobId, name, base); },
  });
}

