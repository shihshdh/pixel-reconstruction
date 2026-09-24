"use client";

// Live2D renderer for the whale companion. Client-only, loaded after idle.
// Model: 《DeepSeek 鲸鱼娘》 by Bilibili @氵六青, CC BY-NC-SA 4.0, used unmodified.
// Cubism Core is Live2D proprietary software, self-hosted under its redistribution terms.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { AssistMood } from "@/lib/api";
import { detectTier } from "@/lib/perf";

export type WhaleStageHandle = {
  setMood: (mood: AssistMood) => void;
  touch: () => void;
  speak: (speaking: boolean) => void;
  greet: () => void;
  /** -1 往左走，1 往右走，0 停下：头和身子转向前进方向 */
  walk: (direction: -1 | 0 | 1) => void;
};

const MODEL_URL = "/companion/whale/c_0120.model3.json";
// Versioned so an earlier 404 (before the file was added) is never served from cache.
const CORE_URL = "/companion/live2dcubismcore.min.js?v=1";

// Emotion → the model's own expression files (see c_0120.model3.json).
const EXPRESSION: Record<AssistMood, string | null> = {
  happy: "playful", excited: "star_eyes", think: "question", worry: "sweat",
  sad: "sad", surprise: "exclaim", shy: "blush", angry: "angry", neutral: null,
};

// ---- 场景：模型自带的道具/饰品开关（参数来自 expressions/*.exp3.json），直接叠在动作之上 ----
type SceneProps = Record<string, number>;
// 手上的东西：每个场景挑一件
const HELD: SceneProps[] = [
  { point: 1 },                        // 举牌
  { point: -1, danbaofan: 1 },         // 蛋包饭
  { baleite: 1 },                      // 芭菲
  { fangzhuoshang: 1 },                // 桌上的小鲸鱼
  { jingyu: 1 },                       // 抱着小鲸鱼
  { bi: 1 },                           // 画笔
  { pi: 1 },                           // 橡皮
  { phone7: 1 },                       // 双手比耶
  { maoshou: 1 },                      // 猫爪手
  { mozhua: 1 },                       // 魔爪
  { pointZ: 1 },                       // 按键
  { ji: 1 },                           // 挤压
  { love: 1 },                         // 比心
  {},                                  // 空手
];
// 饰品：有时加一件，有时不加
const WORN: SceneProps[] = [
  { ParamCheek70: 1 }, { ParamCheek72: 1 }, { ParamCheek10: 1 }, { ParamCheek71: 1 }, // 圆/方/椭圆眼镜、墨镜
  { ParamCheek38: 3 }, { fx1: 1 }, { cc2: 1 }, { ParamCheek26: 360 },                 // 发带、侧马尾、深色衣服、花
  { ParamCheek83: 1 }, { ParamCheek82: 1 }, { ParamCheek81: 1 },                      // 猫猫/兔兔/蝴蝶结贴纸
];
// 空闲时一闪而过的小表情
const QUIRKS = ["playful", "star_eyes", "blush", "question", "tongue", "heartbeat", "love_eyes", "exclaim", "drool", "dizzy", "excited"];
// 这两段动作自己会动 point / danbaofan / ji：播放期间场景层让开这些参数
const MOTION_PARAMS: Record<string, string[]> = { "Action:0": ["point", "danbaofan", "ji"], "Touch:1": ["point", "danbaofan", "ji"] };
const MOTION_SECONDS: Record<string, number> = { "Action:0": 5, "Action:1": 5, "Action:2": .5, "Action:3": 1, "Action:4": 3.3, "Action:5": 1.3, "Touch:0": 3.3, "Touch:1": 5, "Touch:2": 4.8, "FirstImpression:0": 4.8 };
const GROUP_SIZE: Record<string, number> = { Action: 6, Touch: 3, FirstImpression: 1 };
const SCENE_FADE = 0.45; // 秒
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const between = (min: number, max: number) => min + Math.random() * (max - min);

let coreLoading: Promise<void> | null = null;
function loadCore(): Promise<void> {
  const w = window as unknown as { Live2DCubismCore?: unknown };
  if (w.Live2DCubismCore) return Promise.resolve();
  if (!coreLoading) {
    coreLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = CORE_URL;
      script.async = true;
      script.onload = () => (w.Live2DCubismCore ? resolve() : reject(new Error("Cubism Core did not initialise")));
      script.onerror = () => reject(new Error("Cubism Core is missing"));
      document.head.appendChild(script);
    }).catch(error => { coreLoading = null; throw error; });
  }
  return coreLoading;
}

type Props = {
  width: number;
  height: number;
  paused: boolean;
  reducedMotion: boolean;
  onReady?: () => void;
  onError?: (reason: string) => void;
};

const WhaleStage = forwardRef<WhaleStageHandle, Props>(function WhaleStage({ width, height, paused, reducedMotion, onReady, onError }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const speakingRef = useRef(false);
  const moodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const moodActive = useRef(false);
  const walkDir = useRef(0);
  const playRef = useRef<(group: string, index: number | undefined, priority: number) => void>(() => {});
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  useImperativeHandle(ref, () => ({
    setMood(mood) {
      const model = modelRef.current;
      if (!model) return;
      if (moodTimer.current) clearTimeout(moodTimer.current);
      const name = EXPRESSION[mood] ?? null;
      const manager = model.internalModel?.motionManager?.expressionManager;
      try {
        if (name) model.expression(name);
        else manager?.resetExpression?.();
      } catch {}
      if (!reducedRef.current && (mood === "excited" || mood === "happy")) {
        playRef.current("Action", undefined, 2);
      }
      // Emotions fade back to the resting face instead of sticking.
      moodActive.current = !!name;
      if (name) moodTimer.current = setTimeout(() => { moodActive.current = false; try { manager?.resetExpression?.(); } catch {} }, 7000);
    },
    touch() {
      if (reducedRef.current) return;
      playRef.current("Touch", undefined, 3);
    },
    speak(speaking) { speakingRef.current = speaking; },
    walk(direction) { walkDir.current = reducedRef.current ? 0 : direction; },
    greet() {
      if (reducedRef.current) return;
      playRef.current("FirstImpression", 0, 3);
    },
  }), []);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let follow: ((event: PointerEvent) => void) | null = null;
    let stopBehaviour = () => {};
    (async () => {
      try {
        await loadCore();
        const PIXI: any = await import("pixi.js");
        const { install } = await import("@pixi/unsafe-eval");
        // The site's CSP has no 'unsafe-eval'; this swaps Pixi's generated shader code for static functions.
        install({ ShaderSystem: PIXI.ShaderSystem });
        const { Live2DModel } = await import("pixi-live2d-display/cubism4");
        if (disposed || !canvasRef.current) return;
        Live2DModel.registerTicker(PIXI.Ticker);

        const app = new PIXI.Application({
          view: canvasRef.current, width, height, backgroundAlpha: 0, antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true,
          powerPreference: "low-power",
        });
        appRef.current = app;
        // 低档硬件上助手动画限 30 帧，把性能留给 3D 场景
        if (detectTier() === "low") app.ticker.maxFPS = 30;
        const model = await Live2DModel.from(MODEL_URL, { autoInteract: false });
        if (disposed) { model.destroy(); return; }
        modelRef.current = model;

        const motions = model.internalModel?.motionManager;
        if (motions?.groups) motions.groups.idle = "Idling"; // this model names its idle group "Idling"
        // Fit the full figure to the stage, feet on the bottom edge.
        const scale = Math.min(width / model.width, height / model.height);
        model.scale.set(scale);
        model.anchor.set(0.5, 1);
        model.position.set(width / 2, height);
        app.stage.addChild(model);

        // Mouth flaps while a reply is being revealed. Applied after motions so they don't overwrite it.
        let phase = 0;
        model.internalModel.on("beforeModelUpdate", () => {
          const core = model.internalModel.coreModel as { setParameterValueById: (id: string, value: number) => void };
          if (speakingRef.current) {
            phase += 0.35;
            core.setParameterValueById("ParamMouthOpenY", 0.25 + Math.abs(Math.sin(phase)) * 0.65);
          }
        });

        // ---- 场景层：道具参数按权重淡入淡出，叠在动作结果上。换场景时旧道具淡出、新道具淡入 ----
        const layer: { id: string; value: number; weight: number; on: boolean }[] = [];
        const yielded = new Set<string>();
        let yieldTimer: ReturnType<typeof setTimeout> | undefined;
        let lastUpdate = performance.now(), turn = 0;
        const setScene = (props: SceneProps) => {
          const keep = new Set<(typeof layer)[number]>();
          for (const [id, value] of Object.entries(props)) {
            const same = layer.find(entry => entry.id === id && entry.value === value);
            if (same) keep.add(same);
            else { const entry = { id, value, weight: 0, on: true }; layer.push(entry); keep.add(entry); }
          }
          for (const entry of layer) entry.on = keep.has(entry);
        };
        const play = (group: string, index: number | undefined, priority: number) => {
          const chosen = index ?? Math.floor(Math.random() * (GROUP_SIZE[group] || 1));
          let started: unknown = false;
          try { started = model.motion(group, chosen, priority); } catch {}
          const key = group + ":" + chosen, params = MOTION_PARAMS[key];
          if (!params || started === false) return;
          yielded.clear(); params.forEach(id => yielded.add(id));
          clearTimeout(yieldTimer);
          yieldTimer = setTimeout(() => yielded.clear(), (MOTION_SECONDS[key] ?? 5) * 1000 + 300);
        };
        playRef.current = play;
        model.internalModel.on("beforeModelUpdate", () => {
          const now = performance.now(), step = Math.min(.1, (now - lastUpdate) / 1000) / SCENE_FADE;
          lastUpdate = now;
          const core = model.internalModel.coreModel as { getParameterValueById: (id: string) => number; setParameterValueById: (id: string, value: number) => void };
          for (let i = layer.length - 1; i >= 0; i--) {
            const entry = layer[i];
            entry.weight = Math.max(0, Math.min(1, entry.weight + (entry.on ? step : -step)));
            if (!entry.on && entry.weight === 0) layer.splice(i, 1);
          }
          // 走路时朝前进方向侧身（从模型视角看，屏幕右边是 +X）
          turn += (walkDir.current - turn) * Math.min(1, step * SCENE_FADE * 5);
          if (Math.abs(turn) > .005) {
            for (const [id, amount] of [["ParamAngleX", 22], ["ParamBodyAngleX", 9], ["ParamEyeBallX", .7]] as const)
              core.setParameterValueById(id, core.getParameterValueById(id) + turn * amount);
          }
          for (const entry of layer) {
            if (yielded.has(entry.id) || entry.weight === 0) continue;
            const base = core.getParameterValueById(entry.id);
            core.setParameterValueById(entry.id, base + (entry.value - base) * entry.weight);
          }
        });

        // ---- 自主行为：换场景、做动作、闪个小表情。收起/隐藏/减少动态效果时都不动 ----
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const later = (ms: number, run: () => void) => {
          const timer = setTimeout(() => { timers.delete(timer); if (!disposed) run(); }, ms);
          timers.add(timer);
        };
        const every = (min: number, max: number, run: () => void) => {
          const loop = () => later(between(min, max) * 1000, () => { if (!pausedRef.current && !reducedRef.current) run(); loop(); });
          loop();
        };
        const newScene = () => setScene({ ...pick(HELD), ...(Math.random() < .6 ? pick(WORN) : {}) });
        every(9, 16, newScene);
        every(4, 8, () => play(Math.random() < .75 ? "Action" : "Touch", undefined, 2));
        every(6, 12, () => {
          const manager = model.internalModel?.motionManager?.expressionManager;
          if (moodActive.current || speakingRef.current || !manager) return;
          try { model.expression(pick(QUIRKS)); } catch {}
          later(between(1800, 3200), () => { if (!moodActive.current) try { manager.resetExpression?.(); } catch {} });
        });
        later(2500, () => { if (!reducedRef.current) newScene(); });
        stopBehaviour = () => { timers.forEach(clearTimeout); timers.clear(); clearTimeout(yieldTimer); };

        // Eyes and head follow the pointer anywhere on the page, not only over the canvas.
        let pending: PointerEvent | null = null;
        follow = (event: PointerEvent) => {
          if (reducedRef.current) return;
          pending = event;
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            const canvas = canvasRef.current;
            if (!pending || !canvas || !modelRef.current) return;
            const rect = canvas.getBoundingClientRect();
            modelRef.current.focus(pending.clientX - rect.left, pending.clientY - rect.top);
          });
        };
        window.addEventListener("pointermove", follow, { passive: true });
        if (pausedRef.current) app.ticker.stop();
        callbacks.current.onReady?.();
      } catch (error) {
        if (!disposed) callbacks.current.onError?.(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      disposed = true;
      stopBehaviour();
      if (frame) cancelAnimationFrame(frame);
      if (follow) window.removeEventListener("pointermove", follow);
      if (moodTimer.current) clearTimeout(moodTimer.current);
      try { modelRef.current?.destroy(); } catch {}
      try { appRef.current?.destroy(false, { children: true }); } catch {}
      modelRef.current = null;
      appRef.current = null;
    };
    // The stage is sized once per mount; the companion remounts it when the layout size class changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop rendering while hidden or collapsed.
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (paused) app.ticker?.stop(); else app.ticker?.start();
  }, [paused]);

  return <canvas ref={canvasRef} width={width} height={height} aria-hidden="true" style={{ width, height, display: "block" }} />;
});

export default WhaleStage;
