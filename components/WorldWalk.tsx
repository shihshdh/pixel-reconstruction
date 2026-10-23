'use client';

// 全屏漫游：走进 World Labs 生成的世界（演示模式下是这件作品自己的场景）。
// 画面由漫游引擎负责（public/world/engine.js，接口见 lib/world-engine-types.ts）；
// 界面全部在这里画，用和导航同一套液态玻璃：底部一枚标签栏切换行走 / 飞行，旁边是画质与操作；
// 手机上左下角是玻璃摇杆。操作提示在第一次走动后收起。Esc 离开。
import { useCallback, useEffect, useRef, useState } from "react";
import LiquidTabBar, { GlassSurface } from "@/components/LiquidTabBar";
import { isDesktopApp, saveWorkFile, workFolder } from "@/lib/desktop";
import { motionPixelRatio, perfProfile, progressiveUltra, setImmersive } from "@/lib/perf";
import { loadWorldEngine, probeWorldRoute, refreshWorld, routeWorldUrl, worldAssets, type WorldTask } from "@/lib/world";
import type { WalkMode, WorldEngine, WorldQuality, WorldQualityState } from "@/lib/world-engine-types";
import styles from "./WorldWalk.module.css";

const QUALITY: { value: WorldQuality; label: string; title: string }[] = [
  { value: "100k", label: "流畅", title: "10 万个高斯点：手机与核显" },
  { value: "500k", label: "标准", title: "50 万个高斯点" },
  { value: "full_res", label: "精细", title: "全部高斯点（约 200 万）：独立显卡" },
];
const ICON = {
  walk: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 4.6a1.6 1.6 0 1 1 0 .01Z M10.4 20.4l2-5.2 2.6 2.4v2.8 M8.2 11.2l2.6-3.1 3.2.6 2 3 2.4.6 M12.6 15.2l-.9-5.4 M10.8 8.1 9 13.4" /></svg>,
  fly: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 13.2 20.5 6l-5.6 13.6-3.2-5.3Z M11.7 14.3 20.5 6" /></svg>,
  home: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.2 M4.6 4.6v3.6h3.6 M12 8.6V12l2.4 1.6" /></svg>,
  shot: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.4 6.4 9.6 4.6h4.8l1.2 1.8h2.8a1.6 1.6 0 0 1 1.6 1.6v9.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.4V8a1.6 1.6 0 0 1 1.6-1.6Z M12 9.4a3.4 3.4 0 1 1 0 6.8a3.4 3.4 0 1 1 0-6.8Z" /></svg>,
};

/**
 * 目标画质。引擎总是先用最小一档（约 1MB）一两秒内进去，再在后台逐档换到目标档；自动画质下移动时帧率有余量
 * 还会继续升到精细，持续掉帧退一档。所以这里只定“先换到哪一档”：独显直接以精细为目标；手机、核显以标准为目标，
 * 跑得动就自己升上去（静止画面另外按满档超采样补画，画质不降）。底栏点选后停在所选的档。
 */
function defaultQuality(): WorldQuality {
  try {
    const profile = perfProfile();
    if (profile.tier === "low") return "100k";
    return profile.tier === "ultra" && !progressiveUltra(profile) ? "full_res" : "500k";
  } catch { return "500k"; }
}

type Phase = { kind: "loading"; progress: number } | { kind: "ready" } | { kind: "error"; message: string };

export default function WorldWalk({ task, scene, poster, title, onClose }: {
  task: WorldTask; scene?: { href: string; format: "ply" | "splat" }; poster?: string; title?: string; onClose: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading", progress: 0 });
  const [attempt, setAttempt] = useState(0);
  const demo = !!task.world?.demo;
  const [mode, setMode] = useState<WalkMode>(demo ? "fly" : "walk");
  const [quality, setQuality] = useState<WorldQuality>("500k");
  // 引擎报上来的画质：正在显示哪一档、后台在换哪一档、进度
  const [qualityState, setQualityState] = useState<WorldQualityState | null>(null);
  const [hint, setHint] = useState(true);
  const [touch, setTouch] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [shot, setShot] = useState("");
  const qualityRef = useRef(quality);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const q = defaultQuality();
    qualityRef.current = q;
    setQuality(q);
    setTouch(matchMedia("(pointer: coarse)").matches);
  }, []);

  // 打开期间页面不滚动；页面上被盖住的画面（工作室场景、背景、助手）全部暂停（lib/perf.ts setImmersive）
  useEffect(() => {
    const html = document.documentElement, previous = html.style.overflow;
    html.style.overflow = "hidden";
    setImmersive(true);
    return () => { html.style.overflow = previous; setImmersive(false); };
  }, []);

  const close = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    engineRef.current?.setPaused(true);
    setTimeout(onClose, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420);
  }, [leaving, onClose]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) close(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [close]);

  // 载入引擎与世界。不先等网关刷新资源地址（World Labs 的地址实测不带签名）：直接用记下的地址，
  // 下载真的失败了才向网关重新取一次地址再试（见 onError）。
  const refreshed = useRef(false);
  useEffect(() => {
    let disposed = false;
    setPhase({ kind: "loading", progress: 0 });
    setQualityState(null);
    (async () => {
      try {
        const world = task.world!;
        // 国内网络：先确认 World Labs 的 CDN 能不能直连，不通就走本站中转（预取时多半已经测过，这里立即返回）
        if (!world.demo) await probeWorldRoute(world.thumbnail || world.splats["100k"]);
        const assets = worldAssets(world, scene);
        if (!assets) throw new Error("这件作品的三维场景还没有载入，回到工作室等场景出现后再试。");
        const module = await loadWorldEngine();
        if (disposed || !mountRef.current) return;
        const profile = perfProfile();
        const dpr = window.devicePixelRatio || 1;
        const progressive = progressiveUltra(profile);
        engineRef.current = module.createWorldEngine({
          container: mountRef.current,
          assets,
          quality: qualityRef.current,
          autoQuality: !manualRef.current,
          // 移动时：渐进式设备（手机、核显）按 motionPixelRatio、限 60fps；独显按档位起步、掉帧时引擎自己往下降。
          // 停下来补画一帧满档超采样（stillPixelRatio），静止画面就是极致画质
          pixelRatio: progressive ? motionPixelRatio(profile) : Math.min(profile.maxPixelRatio, dpr * (profile.tier === "ultra" ? 1.25 : 1)),
          stillPixelRatio: profile.maxPixelRatio,
          minPixelRatio: profile.minPixelRatio,
          maxFps: progressive ? 60 : undefined,
          eyeHeight: 1.6,
          bounds: demo ? { radius: 1.2 } : undefined,
          mode: modeRef.current,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          onProgress: progress => { if (!disposed) setPhase(p => p.kind === "loading" ? { kind: "loading", progress } : p); },
          onReady: () => { if (!disposed) setPhase({ kind: "ready" }); },
          onQuality: state => { if (!disposed) { setQualityState(state); if (!state.loading) setQuality(state.shown); } },
          onError: error => {
            if (disposed) return;
            // 资源地址可能变了（以后改成带签名的）：向网关重新取一次地址，再从头载入
            if (!refreshed.current && !demo && /下载世界文件失败|Failed to fetch|NetworkError|Load failed/i.test(error.message || "")) {
              refreshed.current = true;
              void refreshWorld(task).finally(() => { if (!disposed) setAttempt(n => n + 1); });
              return;
            }
            setPhase({ kind: "error", message: error.message || "世界没能载入。" });
          },
          onFirstMove: () => { if (!disposed) setHint(false); },
        });
      } catch (error) {
        if (!disposed) setPhase({ kind: "error", message: error instanceof Error ? error.message : "世界没能载入。" });
      }
    })();
    return () => { disposed = true; engineRef.current?.dispose(); engineRef.current = null; };
    // 画质与模式变化走 setQuality / setMode，不重新创建引擎
  }, [task.jobId, task.world?.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // 提示 9 秒后自己收起
  useEffect(() => {
    if (phase.kind !== "ready" || !hint) return;
    const timer = setTimeout(() => setHint(false), 9000);
    return () => clearTimeout(timer);
  }, [phase.kind, hint]);

  const chooseMode = (next: WalkMode) => { setMode(next); engineRef.current?.setMode(next); };
  // 手动选档：边走边换（不再盖上载入层），换好之前继续显示当前这一档；之后停在所选的档
  const manualRef = useRef(false);
  const chooseQuality = (next: WorldQuality) => {
    setQuality(next); qualityRef.current = next; manualRef.current = true;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setQuality(next).catch(() => { setShot("切换画质失败，仍是原来的画质"); setTimeout(() => setShot(""), 2400); });
  };
  const capture = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const blob = await engine.capture();
      const name = `world_${Date.now()}.png`;
      if (isDesktopApp() && await saveWorkFile(workFolder(task.jobId), name, blob)) { setShot("已存到这件作品的文件夹"); }
      else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `Pixel Reconstruction_世界_${Date.now()}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        setShot("截图已下载");
      }
    } catch { setShot("截图失败"); }
    setTimeout(() => setShot(""), 2400);
  };

  // ---- 玻璃摇杆（触屏）----
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const stick = useRef<{ id: number; cx: number; cy: number; r: number } | null>(null);
  const moveStick = (event: React.PointerEvent) => {
    const s = stick.current;
    if (!s || s.id !== event.pointerId) return;
    let dx = event.clientX - s.cx, dy = event.clientY - s.cy;
    const d = Math.hypot(dx, dy);
    if (d > s.r) { dx *= s.r / d; dy *= s.r / d; }
    if (knobRef.current) knobRef.current.style.transform = `translate3d(${dx}px,${dy}px,0)`;
    engineRef.current?.setMoveInput(dx / s.r, -dy / s.r);
    if (d > 6) setHint(false);
  };
  const endStick = (event: React.PointerEvent) => {
    if (!stick.current || stick.current.id !== event.pointerId) return;
    stick.current = null;
    if (knobRef.current) knobRef.current.style.transform = "";
    engineRef.current?.setMoveInput(0, 0);
  };

  const caption = task.world?.caption;
  const loading = phase.kind === "loading";
  return <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="走进世界" data-leaving={leaving || undefined} data-ready={phase.kind === "ready" || undefined}>
    <div ref={mountRef} className={styles.mount} />

    {/* 载入：原照片 / 全景模糊垫底，进度在中间 */}
    <div className={styles.veil} data-hidden={phase.kind === "ready" || undefined} aria-hidden={phase.kind === "ready"}>
      {(task.world?.pano || task.world?.thumbnail || poster) && <img className={styles.veilImage} src={task.world?.thumbnail ? routeWorldUrl(task.world.thumbnail) : poster} alt="" />}
      <div className={styles.veilBody} role="status">
        {phase.kind === "error" ? <>
          <strong>世界没能打开</strong>
          <p>{phase.message}</p>
          <div className={styles.veilActions}>
            <button className={styles.pill} onClick={() => setAttempt(n => n + 1)}>重试</button>
            <button className={styles.pill} data-ghost="" onClick={close}>返回工作室</button>
          </div>
        </> : <>
          <strong>{loading && phase.progress > .98 ? "正在铺开世界" : "正在走进世界"}</strong>
          <div className={styles.ring} style={{ ["--p" as string]: loading ? phase.progress : 1 }} aria-hidden="true"><i /></div>
          <p>{loading ? `${Math.round(phase.progress * 100)}%` : ""}{demo ? " · 演示：这件作品自己的场景" : ""}</p>
        </>}
      </div>
    </div>

    <GlassSurface tone="dark" className={styles.titleCard}>
      <span className={styles.eyebrow}>{demo ? "演示 · 你的场景" : "World Labs Marble"}</span>
      <strong>{title || "走进世界"}</strong>
      {caption && !demo && <span className={styles.caption}>{caption}</span>}
    </GlassSurface>
    <GlassSurface tone="dark" className={styles.close}>
      <button onClick={close} aria-label="离开世界（Esc）" title="离开世界（Esc）" data-own-motion=""><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11 M17.5 6.5l-11 11" /></svg></button>
    </GlassSurface>

    {phase.kind === "ready" && hint && <div className={styles.hint} aria-live="polite">
      {touch ? <>左下角摇杆走动 · 在画面上拖动转头</> : <><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走动 · 按住拖动转头 · <kbd>Shift</kbd> 奔跑{mode === "fly" && <> · <kbd>空格</kbd>/<kbd>C</kbd> 升降</>} · <kbd>Esc</kbd> 离开</>}
    </div>}
    {shot && <div className={styles.toast} role="status">{shot}</div>}

    <div className={styles.dock}>
      <LiquidTabBar<WalkMode> tone="dark" variant="dock" ariaLabel="移动方式" value={mode} onChange={chooseMode}
        items={[{ value: "walk", label: "行走", icon: ICON.walk, title: "贴地行走，会被墙挡住" }, { value: "fly", label: "飞行", icon: ICON.fly, title: "自由飞行，仍不会穿墙" }]} />
      {!demo && <LiquidTabBar<WorldQuality> tone="dark" className={styles.quality} ariaLabel="画质" value={quality} onChange={chooseQuality}
        items={QUALITY.map(q => ({ value: q.value, title: q.title, disabled: !task.world?.splats[q.value],
          // 后台正在换上的那一档显示进度
          label: qualityState?.loading === q.value ? `${q.label} ${Math.round(qualityState.progress * 100)}%` : q.label }))} />}
      <GlassSurface tone="dark" className={styles.actions}>
        <button onClick={() => engineRef.current?.resetView()} title="回到起点" aria-label="回到起点" data-own-motion="">{ICON.home}<span>起点</span></button>
        <button onClick={() => void capture()} title="截图" aria-label="截图" data-own-motion="" disabled={phase.kind !== "ready"}>{ICON.shot}<span>截图</span></button>
      </GlassSurface>
    </div>

    {touch && phase.kind === "ready" && <div ref={stickRef} className={styles.stick}
      onPointerDown={event => {
        const box = stickRef.current!.getBoundingClientRect();
        stick.current = { id: event.pointerId, cx: box.left + box.width / 2, cy: box.top + box.height / 2, r: box.width * .34 };
        stickRef.current!.setPointerCapture(event.pointerId);
        moveStick(event);
      }}
      onPointerMove={moveStick} onPointerUp={endStick} onPointerCancel={endStick}>
      <GlassSurface tone="dark" className={styles.stickBase}><span ref={knobRef} className={styles.knob} /></GlassSurface>
    </div>}
  </div>;
}
