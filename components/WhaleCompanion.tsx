"use client";

// 鲸鱼娘：the site's companion. A Live2D figure in the corner that notices the
// errors the page already shows (role="alert"), offers to explain them, and
// chats through the Beam gateway (/assist → DeepSeek, key stays server-side).
//
// Model 《DeepSeek 鲸鱼娘》 by Bilibili @氵六青 · character by 上善无形 / ZipZipPipe ·
// CC BY-NC-SA 4.0 · a community fan character, not an official DeepSeek product.

import { useCallback, useEffect, useRef, useState, type ComponentType, type RefAttributes } from "react";
import { assistChat, type AssistMessage, type AssistMood, type AssistSource } from "@/lib/api";
import { PAGE_NAMES, SCROLL_WORDS, findRef, highlight, isDisabled, isRisky, labelOf, scrollPage, type PageAction } from "@/lib/companion-actions";
import type { WhaleStageHandle } from "./WhaleStage";
import PixelLoader from "./PixelLoader";
import CompanionVision from './CompanionVision';
import { collectCompanionPage } from '@/lib/companion-vision';
import { MOMENT_EVENT, captureScene, isDevelopablePhoto, photoForVision, requestUpload, type CompanionMoment } from "@/lib/companion-moments";
import { trapScroll } from "@/lib/scroll-trap";
import styles from "./WhaleCompanion.module.css";

type StageProps = { width: number; height: number; paused: boolean; reducedMotion: boolean; onReady?: () => void; onError?: (reason: string) => void };
type StageComponent = ComponentType<StageProps & RefAttributes<WhaleStageHandle>>;
type ChatItem = { id: number; role: "user" | "assistant"; content: string; local?: boolean; sources?: AssistSource[] };
/** A click she prepared that needs the user's yes (delete, upload, generate, download, leave the site). */
type Pending = { id: number; ref: string; label: string };
/** itemId: the chat reply this bubble shows, so it types out in step with the chat and her mouth. */
type Bubble = { text: string; mood?: AssistMood; actions?: { label: string; run: () => void }[]; itemId?: number } | null;

const PREF_KEY = "ruhua-companion-v1";
const CHAT_KEY = "ruhua-companion-chat-v1";
const SESSION_KEY = "ruhua-companion-session-v1";
const ERROR_MEMORY_MS = 15 * 60 * 1000;
/** Session-only yes to "look at my uploads and develop results without asking". */
const LOOK_KEY = "ruhua-companion-look-v1";
type Offer = { kind: "upload" | "developed"; text: string } | null;

function readJson<T>(storage: () => Storage, key: string, fallback: T): T {
  try { const raw = storage().getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback; } catch { return fallback; }
}
function writeJson(storage: () => Storage, key: string, value: unknown) {
  try { storage().setItem(key, JSON.stringify(value)); } catch {}
}
/** How long a reply stays in the bubble: long enough to read it all, typing included. */
const readTime = (text: string) => Math.min(90000, Math.max(9000, 5000 + text.length * 160));
/** Light client-side scrub; the gateway scrubs again before anything reaches DeepSeek. */
function scrub(text: string) {
  return text.replace(/(https?:\/\/[^\s?#]+)\?\S*/g, "$1").replace(/[A-Za-z0-9_-]{40,}/g, "…").slice(0, 300);
}
const short = (text: string, max = 28) => (text.length > max ? text.slice(0, max) + "…" : text);

export default function WhaleCompanion({ page, active, visionEnabled = false, onNavigate }: { page: string; active: boolean; visionEnabled?: boolean; onNavigate?: (page: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<WhaleStageHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const errorsRef = useRef<{ text: string; at: number }[]>([]);
  const stageTextRef = useRef("");
  const nextId = useRef(1);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProactive = useRef(0);

  const [compact, setCompact] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [prefs, setPrefs] = useState({ collapsed: false, right: 18, bottom: 16, known: false });
  const [idle, setIdle] = useState(false);
  const [Stage, setStage] = useState<StageComponent | null>(null);
  const [stageState, setStageState] = useState<"off" | "loading" | "ready" | "failed">("off");
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState<Bubble>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ id: number; count: number } | null>(null);
  const [unseenError, setUnseenError] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [pageImage, setPageImage] = useState<{ image: string; count: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [offer, setOffer] = useState<Offer>(null);
  const [autoLook, setAutoLook] = useState(false);
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const uploadRef = useRef<File | null>(null);
  const openRef = useRef(false);
  openRef.current = open;
  const sending = useRef(false);
  // The parent passes a fresh function every render; keep it in a ref so send() stays stable.
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  useEffect(() => { setScreen(null); setPageImage(null); }, [page, active]);
  useEffect(() => { if (!visionEnabled || !active) { setScreen(null); setPageImage(null); } }, [visionEnabled, active]);

  // ---- environment: size class, reduced motion, saved preferences, idle gate ----
  useEffect(() => {
    const narrow = matchMedia("(max-width: 767px)");
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { setCompact(narrow.matches); setReduced(motion.matches); };
    sync();
    narrow.addEventListener("change", sync); motion.addEventListener("change", sync);
    const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    // Phones and data-saver start collapsed: the 4 MB model loads only when asked for.
    setPrefs(readJson(() => localStorage, PREF_KEY, { collapsed: narrow.matches || saveData, right: 18, bottom: 16, known: false }));
    setItems(readJson(() => sessionStorage, CHAT_KEY, { items: [] as ChatItem[] }).items);
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      narrow.removeEventListener("change", sync); motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", visibility);
      abortRef.current?.abort();
    };
  }, []);
  useEffect(() => { if (prefs.known !== undefined) writeJson(() => localStorage, PREF_KEY, prefs); }, [prefs]);
  useEffect(() => { writeJson(() => sessionStorage, CHAT_KEY, { items: items.slice(-30) }); }, [items]);
  useEffect(() => {
    if (!active || idle) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const id = w.requestIdleCallback ? w.requestIdleCallback(() => setIdle(true), { timeout: 2500 }) : window.setTimeout(() => setIdle(true), 1200);
    return () => { if (w.cancelIdleCallback) w.cancelIdleCallback(id); else clearTimeout(id); };
  }, [active, idle]);
  useEffect(() => {
    if (!active || !idle || prefs.collapsed || Stage || stageState === "failed") return;
    setStageState("loading");
    import("./WhaleStage").then(mod => setStage(() => mod.default as StageComponent)).catch(() => setStageState("failed"));
  }, [active, idle, prefs.collapsed, Stage, stageState]);

  const say = useCallback((next: Bubble, ms = 9000) => {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    setBubble(next);
    if (next?.mood) stageRef.current?.setMood(next.mood);
    if (next) bubbleTimer.current = setTimeout(() => setBubble(null), ms);
  }, []);
  // While a finger or pointer is on the bubble (reading, scrolling), it doesn't go away.
  const holdBubble = () => { if (bubbleTimer.current) { clearTimeout(bubbleTimer.current); bubbleTimer.current = null; } };
  const releaseBubble = () => { holdBubble(); bubbleTimer.current = setTimeout(() => setBubble(null), 8000); };
  const trapRef = useCallback((el: HTMLElement | null) => (el ? trapScroll(el) : undefined), []);
  const bubbleTextRef = useRef<HTMLParagraphElement>(null);
  const bubbleFollow = useRef(true);
  useEffect(() => () => { if (bubbleTimer.current) clearTimeout(bubbleTimer.current); }, []);

  const openChat = useCallback((prefill?: string) => {
    setOpen(true); setBubble(null); setUnseenError(false);
    setPrefs(p => (p.collapsed ? { ...p, collapsed: false } : p));
    if (prefill !== undefined) setInput(prefill);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const closeChat = useCallback(() => { setOpen(false); setScreen(null); setPageImage(null); setPending(null); requestAnimationFrame(() => hitRef.current?.focus()); }, []);

  // ---- send ----
  const context = useCallback(() => {
    const now = Date.now();
    const errors = errorsRef.current.filter(e => now - e.at < ERROR_MEMORY_MS).slice(-5).map(e => e.text);
    return { page, stage: stageTextRef.current || undefined, errors, online: navigator.onLine };
  }, [page]);
  const note = useCallback((content: string) => {
    setItems(list => [...list, { id: nextId.current++, role: "assistant", content, local: true }]);
  }, []);
  // Carry out what she proposed, one step at a time, telling the user in the chat what happened.
  const runActions = useCallback(async (actions: PageAction[]) => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let touchedPage = false;
    for (const action of actions.slice(0, 4)) {
      if (action.type === "navigate") {
        if (!navigateRef.current || !PAGE_NAMES[action.page]) continue;
        navigateRef.current(action.page); note(`↪ 已切换到「${PAGE_NAMES[action.page]}」`);
        await wait(500); continue;
      }
      if (action.type === "scroll" && !action.ref) {
        if (action.direction) { scrollPage(action.direction, reduced); note(`↪ ${SCROLL_WORDS[action.direction]}`); touchedPage = true; }
        await wait(350); continue;
      }
      const el = action.ref ? findRef(action.ref) : null;
      if (!el) { note("↪ 没找到她说的那个位置，页面可能已经变了，可以再问她一次。"); continue; }
      const label = labelOf(el);
      touchedPage = true;
      if (action.type !== "click") { highlight(el, reduced); note(`↪ 已标出「${label}」`); await wait(350); continue; }
      if (isDisabled(el)) { highlight(el, reduced); note(`↪「${label}」现在不可用，已帮你标出来。`); continue; }
      if (isRisky(el)) {
        highlight(el, reduced);
        setPending({ id: nextId.current++, ref: action.ref!, label });
        return false; // Keep the panel open for the question; anything after it waits for the user.
      }
      highlight(el, reduced); await wait(reduced ? 80 : 420);
      if (!el.isConnected) { note("↪ 页面变化了，这一步没有执行。"); continue; }
      el.click(); note(`↪ 已点击「${label}」`);
      await wait(450);
    }
    return touchedPage;
  }, [note, reduced]);
  const confirmPending = (yes: boolean) => {
    const current = pending;
    setPending(null);
    if (!current) return;
    if (!yes) { note(`↪ 已取消「${current.label}」`); return; }
    const el = findRef(current.ref);
    if (!el || isDisabled(el)) { note(`↪「${current.label}」已经不在页面上或不可用了。`); return; }
    // Runs inside the user's own click, so a file picker opened by this button is allowed to open.
    el.click(); note(`↪ 已点击「${current.label}」`);
  };

  const send = useCallback(async (text: string, manual = false, look?: { screen?: string; page_image?: string }) => {
    const attachment = look ? look.screen || null : manual && visionEnabled ? screen : null;
    const pictures = look ? (look.page_image ? { image: look.page_image, count: 1 } : null) : manual && visionEnabled ? pageImage : null;
    const content = text.trim() || (attachment || pictures ? '请看看我附上的图片，帮我解释画面内容。' : '');
    if (!content || busy || sending.current) return;
    sending.current = true;
    const user: ChatItem = { id: nextId.current++, role: "user", content: content.slice(0, 1200) };
    const history = [...items, user];
    setItems(history); setInput(""); setBusy(true); setPending(null);
    stageRef.current?.setMood("think");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const messages: AssistMessage[] = history.filter(m => !m.local).slice(-12).map(({ role, content }) => ({ role, content }));
    try {
      // Page text and the control list go with every message (the panel says so); pictures only when attached.
      let pageText: string | undefined;
      try { pageText = collectCompanionPage({ images: false }).text || undefined; } catch {}
      const { reply, mood, actions, sources } = await assistChat(messages, { ...context(), page_text: pageText }, controller.signal, undefined,
        { screen: attachment || undefined, page_image: pictures?.image });
      if (controller.signal.aborted) return;
      if (!look && attachment) setScreen(null);
      if (!look && pictures) setPageImage(null);
      const answer: ChatItem = { id: nextId.current++, role: "assistant", content: reply,
        sources: Array.isArray(sources) ? sources.filter(s => /^https?:\/\//.test(s.url)).slice(0, 6) : undefined };
      setItems(list => [...list, answer]);
      setReveal(reduced ? null : { id: answer.id, count: 0 });
      stageRef.current?.setMood(mood);
      // A reaction to a photo can arrive while the panel is closed: say it in the bubble too.
      if (!openRef.current) say({ text: reply, itemId: answer.id, mood, actions: [{ label: "展开聊聊", run: () => openChat() }, { label: "好", run: () => setBubble(null) }] }, readTime(reply));
      if (Array.isArray(actions) && actions.length) {
        const touched = await runActions(actions);
        // On a phone the panel covers the page: step aside so the user sees what she did.
        if (touched && compact && !controller.signal.aborted) { setOpen(false); say({ text: reply, itemId: answer.id, mood, actions: [{ label: "展开聊聊", run: () => openChat() }] }, readTime(reply)); }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "鲸鱼娘暂时回不了话，请稍后再试。";
      setItems(list => [...list, { id: nextId.current++, role: "assistant", content: message, local: true }]);
      stageRef.current?.setMood("worry");
    } finally {
      sending.current = false;
      if (abortRef.current === controller) { abortRef.current = null; setBusy(false); }
    }
  }, [busy, items, context, reduced, screen, pageImage, visionEnabled, runActions, compact, say, openChat]);
  const sendRef = useRef(send);
  sendRef.current = send;

  // ---- photos and develop results: ask first, then look and react ----
  useEffect(() => { try { setAutoLook(sessionStorage.getItem(LOOK_KEY) === "1"); } catch {} }, []);
  const rememberLook = useCallback((value: boolean) => {
    setAutoLook(value);
    try { if (value) sessionStorage.setItem(LOOK_KEY, "1"); else sessionStorage.removeItem(LOOK_KEY); } catch {}
  }, []);
  const look = useCallback(async (kind: "upload" | "developed") => {
    setOffer(null); setBubble(null);
    stageRef.current?.setMood("think");
    try {
      if (kind === "upload") {
        const file = uploadRef.current;
        if (!file) return;
        let photo: string;
        try { photo = await photoForVision(file); }
        catch { say({ text: "这张照片的格式我暂时看不了（比如 HEIC），等显影好了我再看效果～", mood: "sad" }); return; }
        if (!openRef.current) say({ text: "我看看哦…", mood: "think" }, 40000);
        await sendRef.current("给你看看我刚上传的照片～你觉得怎么样？适合做成 3D 吗？", false, { page_image: photo });
      } else {
        say({ text: "等 3D 画面出来，我就看～", mood: "excited" }, 45000);
        const still = await captureScene();
        if (!still) { say({ text: "3D 画面还没加载出来，等它出来了再叫我看吧～", mood: "worry" }); return; }
        let original: string | undefined;
        try { original = collectCompanionPage({ images: true }).image; } catch {}
        await sendRef.current(original
          ? "显影好啦，给你看看效果～（一张是现在的 3D 画面，另一张是原图）你觉得怎么样？"
          : "显影好啦，给你看看现在的 3D 画面～你觉得效果怎么样？", false, { screen: still, page_image: original });
      }
    } catch {}
  }, [say]);
  useEffect(() => {
    if (!active || !visionEnabled) return;
    const onMoment = (event: Event) => {
      const moment = (event as CustomEvent<CompanionMoment>).detail;
      if (!moment) return;
      if (moment.kind === "upload") uploadRef.current = moment.file;
      if (autoLook) { void look(moment.kind); return; }
      const text = moment.kind === "upload" ? "开始显影啦，第一次唤醒 GPU 可能要几分钟～等的时候，可以给我看看这张照片吗？" : "显影好啦！要让我看看 3D 效果吗？";
      setOffer({ kind: moment.kind, text });
      stageRef.current?.setMood(moment.kind === "upload" ? "happy" : "excited");
      say({ text, mood: moment.kind === "upload" ? "happy" : "excited", actions: [
        { label: "给你看", run: () => void look(moment.kind) },
        { label: "以后直接看", run: () => { rememberLook(true); void look(moment.kind); } },
        { label: "不用啦", run: () => { setOffer(null); setBubble(null); } },
      ] }, 25000);
    };
    window.addEventListener(MOMENT_EVENT, onMoment);
    return () => window.removeEventListener(MOMENT_EVENT, onMoment);
  }, [active, visionEnabled, autoLook, look, say, rememberLook]);

  // Reveal the newest reply a few characters at a time; the mouth moves meanwhile.
  useEffect(() => {
    if (!reveal) { stageRef.current?.speak(false); return; }
    const target = items.find(m => m.id === reveal.id);
    if (!target || reveal.count >= target.content.length) { stageRef.current?.speak(false); setReveal(null); return; }
    stageRef.current?.speak(true);
    const timer = setTimeout(() => setReveal(r => (r ? { ...r, count: r.count + 2 } : r)), 45);
    return () => clearTimeout(timer);
  }, [reveal, items]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [items, busy, reveal?.count, open, pending]);

  // The bubble scrolls along as her reply types out, unless the user has scrolled back to reread.
  useEffect(() => { bubbleFollow.current = true; bubbleTextRef.current?.scrollTo({ top: 0 }); }, [bubble]);
  useEffect(() => {
    const el = bubbleTextRef.current;
    if (el && bubbleFollow.current && bubble?.itemId !== undefined && reveal?.id === bubble.itemId) el.scrollTop = el.scrollHeight;
  }, [reveal?.count, reveal?.id, bubble]);

  // ---- watch what the page already tells the user ----
  useEffect(() => {
    if (!active) return;
    const seen = new Set<string>();
    const session = readJson(() => sessionStorage, SESSION_KEY, { working: false });
    let wasWorking = false, doneShown = false, timer = 0;
    const scan = () => {
      timer = 0;
      const root = rootRef.current;
      const alerts = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], .field-error'))
        .filter(el => !root?.contains(el) && el.getClientRects().length > 0)
        .map(el => scrub((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()))
        .filter(text => text.length >= 4);
      for (const text of alerts) {
        if (seen.has(text)) continue;
        seen.add(text);
        errorsRef.current = [...errorsRef.current.filter(e => e.text !== text), { text, at: Date.now() }].slice(-8);
        setUnseenError(true);
        stageRef.current?.setMood("worry");
        if (Date.now() - lastProactive.current > 20000) {
          lastProactive.current = Date.now();
          say({ text: `呜…页面说「${short(text)}」。要我帮你看看吗？`, mood: "worry", actions: [
            { label: "帮我看看", run: () => { openChat(); void sendRef.current(`页面提示：「${text}」。这是怎么回事？我该怎么办？`); } },
            { label: "没事", run: () => setBubble(null) },
          ] }, 14000);
        }
      }
      const caption = document.querySelector(".develop-caption");
      stageTextRef.current = caption ? (caption.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
      if (caption && !wasWorking) {
        wasWorking = true; doneShown = false;
        if (!session.working) {
          session.working = true; writeJson(() => sessionStorage, SESSION_KEY, session);
          // With vision on, the upload offer says this instead (see the moment handler).
          if (!visionEnabled) say({ text: "开始显影啦！第一次唤醒 GPU 可能要几分钟，我陪你等～", mood: "excited" });
        }
      }
      if (!caption && wasWorking && document.querySelector(".ok-check") && !doneShown) {
        wasWorking = false; doneShown = true;
        if (!visionEnabled) say({ text: "显影好啦！去工作室转一转吧～", mood: "excited" });
      }
    };
    const observer = new MutationObserver(() => { if (!timer) timer = window.setTimeout(scan, 350); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [active, say, openChat, visionEnabled]);

  // Greet once per session when she first appears.
  useEffect(() => {
    if (stageState !== "ready") return;
    const session = readJson(() => sessionStorage, SESSION_KEY, { greeted: false });
    if (session.greeted) return;
    writeJson(() => sessionStorage, SESSION_KEY, { ...session, greeted: true });
    stageRef.current?.greet();
    say({ text: "你好呀，我是鲸鱼娘～遇到报错或者想聊天，都可以点我。", mood: "happy" });
  }, [stageState, say]);

  // ---- dragging (the whole figure), tap to open ----
  const drag = useRef<{ id: number; x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const stageSize = compact ? { width: 132, height: 176 } : { width: 190, height: 254 };
  // The panel sits above the figure (or chip). Keep its header on screen: cap its height to the space
  // left between the top of the viewport and the figure, following the visual viewport (phone keyboard).
  const [viewHeight, setViewHeight] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const sync = () => setViewHeight(Math.round(vv?.height || window.innerHeight));
    sync();
    vv?.addEventListener("resize", sync); window.addEventListener("resize", sync);
    return () => { vv?.removeEventListener("resize", sync); window.removeEventListener("resize", sync); };
  }, []);
  const belowPanel = (prefs.collapsed || stageState === "failed" ? 38 : stageSize.height) + 10 + prefs.bottom;
  const panelMax = viewHeight ? Math.max(220, viewHeight - belowPanel - 12) : undefined;
  const clampPos = useCallback((right: number, bottom: number) => {
    const box = rootRef.current?.querySelector<HTMLElement>("[data-figure]")?.getBoundingClientRect();
    const w = box?.width || stageSize.width, h = box?.height || stageSize.height;
    return { right: Math.max(8, Math.min(window.innerWidth - w - 8, right)), bottom: Math.max(8, Math.min(window.innerHeight - h - 8, bottom)) };
  }, [stageSize.width, stageSize.height]);
  useEffect(() => {
    const fit = () => setPrefs(p => ({ ...p, ...clampPos(p.right, p.bottom) }));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [clampPos]);
  // ---- wandering: while nobody is talking to her, she strolls along the bottom of the screen ----
  const [walking, setWalking] = useState<{ ms: number } | null>(null);
  const walkingRef = useRef(walking);
  walkingRef.current = walking;
  const walkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stops where she is right now (mid-transition) and returns that position. */
  const stopWalk = useCallback(() => {
    if (walkTimer.current) { clearTimeout(walkTimer.current); walkTimer.current = null; }
    stageRef.current?.walk(0);
    const root = rootRef.current;
    if (!walkingRef.current || !root) return null;
    const here = { right: Math.round(parseFloat(getComputedStyle(root).right) || 0), bottom: Math.round(parseFloat(getComputedStyle(root).bottom) || 0) };
    walkingRef.current = null;
    setWalking(null);
    setPrefs(p => ({ ...p, ...here }));
    return here;
  }, []);
  const canWander = stageState === "ready" && !prefs.collapsed && !open && !busy && !pending && !dropping && !hidden && !reduced;
  // A saved spot can be off screen when the window is now narrower than when she walked there.
  useEffect(() => {
    if (stageState === "ready" || stageState === "failed") setPrefs(p => { const fit = clampPos(p.right, p.bottom); return fit.right === p.right && fit.bottom === p.bottom ? p : { ...p, ...fit }; });
  }, [stageState, prefs.collapsed, clampPos]);
  const [walkRound, setWalkRound] = useState(0);
  useEffect(() => {
    if (!canWander) { stopWalk(); return; }
    if (walking) return;
    const timer = setTimeout(() => {
      const figure = rootRef.current?.querySelector<HTMLElement>("[data-figure]")?.getBoundingClientRect();
      const width = figure?.width || stageSize.width, room = window.innerWidth - width - 16;
      // Not now (being dragged, or no room): try again next round instead of never walking again.
      if (drag.current || room < 80) { setWalkRound(n => n + 1); return; }
      const from = prefs.right;
      // 走 120–420px；靠边时掉头
      let to = from + (Math.random() < .5 ? -1 : 1) * (120 + Math.random() * 300);
      if (to < 8 || to > 8 + room) to = from - (to - from);
      to = Math.max(8, Math.min(8 + room, to));
      const ms = Math.round(Math.abs(to - from) / 75 * 1000); // 约 75px/s
      if (ms < 800) { setWalkRound(n => n + 1); return; }
      stageRef.current?.walk(to < from ? 1 : -1); // right 变小 = 往屏幕右边走
      setWalking({ ms });
      setPrefs(p => ({ ...p, right: Math.round(to) }));
      walkTimer.current = setTimeout(() => { walkTimer.current = null; stageRef.current?.walk(0); setWalking(null); }, ms);
    }, 7000 + Math.random() * 9000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWander, walking, walkRound]);
  useEffect(() => () => { if (walkTimer.current) clearTimeout(walkTimer.current); }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const here = stopWalk();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, right: here?.right ?? prefs.right, bottom: here?.bottom ?? prefs.bottom, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    if (!d.moved) { d.moved = true; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
    setPrefs(p => ({ ...p, ...clampPos(d.right - dx, d.bottom - dy) }));
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    suppressClick.current = d.moved;
    drag.current = null;
  };
  const onFigureClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    stageRef.current?.touch();
    if (open) closeChat(); else openChat();
  };

  // ---- a photo dropped on her: she hands it to the create page, which uploads and develops it ----
  const carriesFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const onDragEnter = (event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dropDepth.current += 1;
    if (!dropping) { setDropping(true); stageRef.current?.setMood("excited"); }
  };
  const onDragOver = (event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (!dropDepth.current) setDropping(false);
  };
  const onDrop = (event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dropDepth.current = 0; setDropping(false);
    const files = Array.from(event.dataTransfer.files || []);
    const file = files.find(isDevelopablePhoto);
    if (!file) {
      say({ text: files.length ? "这个我传不了哦：请给我 20MB 以内的 jpg、png、webp 或 heic 照片～" : "没接住…再拖一次试试？", mood: "worry" });
      return;
    }
    const answer = requestUpload(file);
    if (answer === "busy") { say({ text: "上一张还在显影中，等它好了再给我下一张吧～", mood: "worry" }); return; }
    if (answer !== "started") { say({ text: "现在没法上传，稍后再试一次吧～", mood: "sad" }); return; }
    if (compact) setOpen(false);
    say({ text: files.length > 1 ? "收到！我先把第一张传到云端显影，其他的等它好了再给我～" : "收到！我这就把照片传到云端显影～", mood: "excited" }, 6000);
  };

  if (!active) return null;

  const errorsNow = errorsRef.current.filter(e => Date.now() - e.at < ERROR_MEMORY_MS);
  const suggestions = [
    ...(errorsNow.length ? ["刚才的报错是什么意思？"] : []),
    "带我去作品库看看", "什么样的照片效果最好？", "为什么转太大角度会穿帮？",
  ].slice(0, 3);

  return <div ref={rootRef} className={styles.root} data-assist-private data-compact={compact || undefined} data-reduced={reduced || undefined}
    data-dropping={dropping || undefined} style={{ right: prefs.right, bottom: prefs.bottom, transition: walking ? `right ${walking.ms}ms cubic-bezier(.45,.05,.55,.95)` : undefined }}
    onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); closeChat(); } }}>

    {open && <section ref={trapRef} className={styles.panel} style={{ maxHeight: panelMax }} role="dialog" aria-modal="false" aria-labelledby="whale-title">
      <header className={styles.panelHead}>
        <div><strong id="whale-title">鲸鱼娘</strong><span>DeepSeek 驱动 · 社区二创角色</span></div>
        <div className={styles.headActions}>
          <button type="button" onClick={() => { abortRef.current?.abort(); setItems([]); setBusy(false); setReveal(null); setScreen(null); setPageImage(null); setPending(null); }} disabled={!items.length && !busy && !screen && !pageImage}>清空</button>
          <button type="button" onClick={closeChat} aria-label="关闭对话"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg></button>
        </div>
      </header>
      <div ref={logRef} className={styles.log} aria-live="polite">
        {items.length === 0 && <p className={styles.empty}>可以问我报错是什么意思、网站怎么用，让我帮你找按钮、翻页，也可以随便聊聊。想做 3D，直接把照片拖给我就行。</p>}
        {items.map(m => {
          const revealing = reveal?.id === m.id;
          const text = revealing ? m.content.slice(0, reveal.count) : m.content;
          return <p key={m.id} className={m.role === "user" ? styles.me : m.local ? styles.system : styles.her}>{text}
            {!revealing && m.sources?.length ? <span className={styles.sources}>{m.sources.map((s, i) =>
              <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title}>{i + 1}. {short(s.site || s.title, 16)}</a>)}</span> : null}
          </p>;
        })}
        {offer && !busy && <div className={styles.confirm} data-tone="look" role="group" aria-label="看看你的照片">
          <span>{offer.text}</span>
          <div><button type="button" onClick={() => void look(offer.kind)}>给你看</button><button type="button" onClick={() => { rememberLook(true); void look(offer.kind); }}>以后直接看</button><button type="button" onClick={() => setOffer(null)}>不用啦</button></div>
        </div>}
        {pending && <div className={styles.confirm} role="group" aria-label="确认操作">
          <span>要我点击「{short(pending.label, 18)}」吗？这一步可能会上传、生成、删除或离开本页。</span>
          <div><button type="button" onClick={() => confirmPending(true)}>确认点击</button><button type="button" onClick={() => confirmPending(false)}>取消</button></div>
        </div>}
        {busy && <p className={styles.typing} role="status" aria-label="鲸鱼娘正在输入"><PixelLoader size={12} /></p>}
      </div>
      {items.length === 0 && <div className={styles.suggest}>{suggestions.map(s => <button key={s} type="button" onClick={() => void send(s, true)}>{s}</button>)}</div>}
      <CompanionVision enabled={visionEnabled} busy={busy} screen={screen} onScreen={setScreen} pageImage={pageImage} onPageImage={setPageImage} autoLook={autoLook} onAutoLook={rememberLook} />
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void send(input, true); }}>
        <textarea ref={inputRef} rows={1} value={input} maxLength={1200} placeholder="和鲸鱼娘说点什么…" aria-label="给鲸鱼娘的消息"
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            // Chinese IME: Enter confirms a candidate while composing; never send then.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input, true); }
          }} />
        <button type="submit" disabled={busy || (!input.trim() && !screen && !pageImage)}>发送</button>
      </form>
      <footer className={styles.credit}>
        模型 <a href="https://space.bilibili.com/11272072" target="_blank" rel="noopener noreferrer">B站 @氵六青</a> · 形象 上善无形 / ZipZipPipe ·{" "}
        <a href="/companion/whale/LICENSE-Live2D.txt" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> · 非 DeepSeek 官方 · Live2D Cubism ·
        回答由 AI 生成，仅供参考，请勿发送密码或密钥
      </footer>
    </section>}

    {dropping && <div className={styles.bubble} data-drop role="status"><p>松手，我帮你把照片传到云端显影～</p></div>}
    {bubble && !open && !dropping && <div ref={trapRef} className={styles.bubble} role="status"
      onPointerEnter={holdBubble} onPointerDown={holdBubble} onPointerLeave={releaseBubble} onTouchEnd={releaseBubble}>
      <p ref={bubbleTextRef} className={styles.bubbleText}
        onScroll={event => { const el = event.currentTarget; bubbleFollow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24; }}>
        {bubble.itemId !== undefined && reveal?.id === bubble.itemId ? bubble.text.slice(0, reveal.count) : bubble.text}</p>
      {bubble.actions && <div>{bubble.actions.map(a => <button key={a.label} type="button" onClick={() => { a.run(); }}>{a.label}</button>)}</div>}
    </div>}

    {prefs.collapsed || stageState === "failed"
      ? <button type="button" className={styles.chip} onClick={() => { setPrefs(p => ({ ...p, collapsed: false })); openChat(); }} aria-label="展开鲸鱼娘并聊天">
          <span className={styles.chipDot} data-alert={unseenError || undefined} />鲸鱼娘
        </button>
      : <div className={styles.figure} data-figure data-no-press data-walking={walking ? "" : undefined} style={{ width: stageSize.width, height: stageSize.height }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {Stage && <Stage key={compact ? "c" : "w"} ref={stageRef} width={stageSize.width} height={stageSize.height}
            paused={hidden || !!prefs.collapsed} reducedMotion={reduced}
            onReady={() => setStageState("ready")} onError={reason => { console.warn("[鲸鱼娘] Live2D 形象未能加载，改用小按钮：", reason); setStageState("failed"); }} />}
          {stageState !== "ready" && <span className={styles.placeholder} data-state={stageState}><PixelLoader size={12} /></span>}
          <button ref={hitRef} type="button" className={styles.hit} onClick={onFigureClick} aria-expanded={open}
            aria-label={open ? "收起和鲸鱼娘的对话" : "和鲸鱼娘聊天"} />
          <button type="button" className={styles.collapse} onClick={() => { setOpen(false); setBubble(null); setPrefs(p => ({ ...p, collapsed: true })); }} aria-label="收起鲸鱼娘"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" /></svg></button>
          {unseenError && !open && <span className={styles.alertDot} aria-hidden="true" />}
        </div>}
  </div>;
}
