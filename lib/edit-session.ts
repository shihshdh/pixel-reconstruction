// 修图对话：每件作品一份，存在 localStorage（只存文字与版本文件名，图片本身在云端作品目录里）。
// 请求也在这里跑，不跟着修图页的生命周期走：切到别的页面、再切回来，改图结果照样落进对话；
// 从作品库重新打开同一件作品，以前修过的每一版都还在。鲸鱼娘写的提示词也直接写进这里的草稿。
import { useSyncExternalStore } from "react";
import { checkStatus, downloadJobFile, editImage, getBase, refreshJobAccess, requestRerender, type EditResolution } from "./api";
import { isDesktopApp, saveWorkFile, workFolder } from "./desktop";

export type EditMessage = { id: string; role: "user" | "ai"; text?: string; img?: string; ref?: string; failed?: boolean; at: number };
export type EditStrength = "gentle" | "balanced";
export type EditSession = {
  chat: EditMessage[];
  history: string[];
  draft: string;
  pad: number;
  strength: EditStrength;
  /** 豆包输出分辨率：1K（默认）、2K，或放大到原图尺寸。 */
  resolution: EditResolution;
  base: string;
  editing: boolean;
  rerendering: boolean;
  /** 鲸鱼娘写入草稿的时刻；修图页据此把输入框滚到眼前并聚焦。 */
  delivered: number;
  deliveredTitle: string;
};
type Job = { job_id: string; backend_url?: string; job_token?: string };

const PREFIX = "ruhua-edit-chat-v1::";
const EMPTY: EditSession = { chat: [], history: [], draft: "", pad: 0, strength: "gentle", resolution: "1k", base: "", editing: false, rerendering: false, delivered: 0, deliveredTitle: "" };
const sessions = new Map<string, EditSession>();
const listeners = new Set<() => void>();
let active: { key: string; job: Job } | null = null;
let serial = 0;

export const editKey = (job: Job) => `${(job.backend_url || "").replace(/\/+$/, "")}::${job.job_id}`;
const newId = () => `${Date.now().toString(36)}-${(serial++).toString(36)}`;

function load(key: string): EditSession {
  const known = sessions.get(key);
  if (known) return known;
  let saved: Partial<EditSession> = {};
  try { saved = JSON.parse(localStorage.getItem(PREFIX + key) || "{}") || {}; } catch {}
  const session: EditSession = {
    ...EMPTY,
    chat: Array.isArray(saved.chat) ? saved.chat.filter(m => m && (m.role === "user" || m.role === "ai")) : [],
    history: Array.isArray(saved.history) ? saved.history.filter(h => typeof h === "string") : [],
    draft: typeof saved.draft === "string" ? saved.draft : "",
    pad: typeof saved.pad === "number" && saved.pad >= 0 && saved.pad <= .5 ? saved.pad : 0,
    strength: saved.strength === "balanced" ? "balanced" : "gentle",
    resolution: saved.resolution === "2k" || saved.resolution === "original" ? saved.resolution : "1k",
    base: typeof saved.base === "string" ? saved.base : "",
  };
  sessions.set(key, session);
  return session;
}

function update(key: string, change: (session: EditSession) => Partial<EditSession>) {
  const next = { ...load(key) };
  Object.assign(next, change(next));
  sessions.set(key, next);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({
      chat: next.chat.slice(-300), history: next.history.slice(-40),
      draft: next.draft.slice(0, 4000), pad: next.pad, strength: next.strength, resolution: next.resolution, base: next.base,
    }));
  } catch {}
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function useEditSession(key: string | null): EditSession {
  return useSyncExternalStore(subscribe, () => (key ? load(key) : EMPTY), () => EMPTY);
}

export function setEditDraft(key: string, change: Partial<Pick<EditSession, "draft" | "pad" | "strength" | "resolution" | "base" | "delivered">>) {
  update(key, () => change);
}

/** 当前打开的作品（由应用根组件设置），鲸鱼娘据此判断能不能写修图提示词。 */
export function setActiveEditJob(job: Job | null) {
  active = job?.job_id ? { key: editKey(job), job } : null;
}

/** 给鲸鱼娘的上下文：只含文字，不含图片或链接。 */
export function editContext() {
  if (!active) return { ready: false };
  const session = load(active.key);
  return { ready: true, draft: session.draft.slice(0, 1500) || undefined, history: session.history.slice(-6) };
}

/** 鲸鱼娘写好的提示词：写进当前作品的修图草稿。没有可修的作品时返回 false。 */
export function deliverEditPrompt(action: { prompt: string; pad?: number; strength?: EditStrength; note?: string }) {
  if (!active) return false;
  update(active.key, () => ({
    draft: action.prompt.slice(0, 4000),
    pad: Math.min(.5, Math.max(0, Number(action.pad) || 0)),
    strength: action.strength === "balanced" ? "balanced" : "gentle",
    delivered: Date.now(), deliveredTitle: (action.note || "").slice(0, 30),
  }));
  return true;
}

export function clearEditChat(key: string) {
  const session = load(key);
  if (session.editing || session.rerendering) return;
  update(key, () => ({ chat: [], history: [], base: "" }));
}

const push = (key: string, message: Omit<EditMessage, "id" | "at">) =>
  update(key, session => ({ chat: [...session.chat, { ...message, id: newId(), at: Date.now() }] }));

export async function runEdit(job: Job, request: { display: string; prompt: string; pad: number; strength: EditStrength; credentials?: { apiKey: string; model?: string } }) {
  const key = editKey(job);
  const session = load(key);
  if (session.editing || session.rerendering) return;
  const ref = session.base;
  update(key, s => ({
    editing: true, draft: "", pad: 0, delivered: 0,
    chat: [...s.chat, { id: newId(), at: Date.now(), role: "user", text: request.display, ref: ref || undefined }],
  }));
  try {
    const result = await editImage(job.job_id, request.prompt, request.pad, ref, session.history, job.backend_url, request.credentials, request.strength, session.resolution);
    update(key, s => ({
      editing: false, base: "", history: [...s.history, request.display.slice(0, 400)],
      chat: [...s.chat, { id: newId(), at: Date.now(), role: "ai", img: result.image }],
    }));
  } catch (error) {
    update(key, s => ({ editing: false, chat: [...s.chat, { id: newId(), at: Date.now(), role: "ai", failed: true, text: "修图失败：" + (error instanceof Error ? error.message : String(error)) }] }));
  }
}

/** 用某一版重新显影。轮询不依赖修图页是否还开着；完成后交给 onDone（应用根组件的保存与跳转）。 */
export async function runRerender(job: Job, image: string, onDone: (result: any) => void) {
  const key = editKey(job);
  const session = load(key);
  if (session.editing || session.rerendering) return;
  const apiBase = job.backend_url || getBase(), started = Date.now();
  update(key, () => ({ rerendering: true }));
  push(key, { role: "ai", text: "正在用这张图重新显影 3D 场景…" });
  const fail = (message: string) => { update(key, () => ({ rerendering: false })); push(key, { role: "ai", failed: true, text: "重新显影失败：" + message }); };
  try {
    const { call_id } = await requestRerender(job.job_id, image, apiBase);
    let failures = 0;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, failures || Date.now() - started > 4000 ? 3000 : 2000));
      if (Date.now() - started > 25 * 60 * 1000) { fail("等待超时，请稍后重试。"); return; }
      try {
        const status = await checkStatus(call_id, apiBase);
        failures = 0;
        if (status.status === "done") {
          update(key, () => ({ rerendering: false }));
          push(key, { role: "ai", text: "重新显影完成，已存进作品库。" });
          onDone({ ...status, job_token: status.job_token || job.job_token, backend_url: apiBase });
          return;
        }
        if (status.status === "error") { fail(status.message); return; }
      } catch {
        if (++failures >= 4) { fail("无法连接服务，请检查网络后重试。"); return; }
      }
    }
  } catch (error) { fail(error instanceof Error ? error.message : "请求失败"); }
}

/** 旧对话里的图片链接签名会过期：打开时刷新一次这件作品所有文件的签名。 */
const refreshed = new Set<string>();
export async function refreshEditLinks(job: Job) {
  const key = editKey(job);
  if (refreshed.has(key) || !load(key).chat.some(m => m.img)) return false;
  refreshed.add(key);
  try { await refreshJobAccess(job.job_id, job.backend_url || getBase()); return true; } catch { refreshed.delete(key); return false; }
}

/** 只导出这一版图片，按服务器上的原始像素原样保存（不重新压缩、不缩放）。 */
export async function exportEditImage(job: Job, image: string, size?: { width: number; height: number }) {
  const blob = await downloadJobFile(job.job_id, image, job.backend_url || getBase());
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const name = `像素重构_修图_${stamp}${size ? `_${size.width}x${size.height}` : ""}.jpg`;
  if (isDesktopApp()) {
    const folder = workFolder(job.job_id);
    if (await saveWorkFile(folder, name, blob)) return { name, folder };
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.style.display = "none";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { name };
}
