"use client";

import GlassTitle from "@/components/GlassTitle";
import LiquidSegmented from "@/components/LiquidSegmented";
import HandwrittenTagline, { type Handwriting } from "@/components/HandwrittenTagline";
import HANDWRITING from "@/lib/handwriting.generated.json";
import { DESKTOP_DOWNLOAD, isDesktopApp, titleBarMouseDown } from "@/lib/desktop";
import WindowControls from "@/components/WindowControls";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { LandingLoadProgress, LandingSceneStatus } from "./LandingSplat";
import BrandMark from "./BrandMark";
import { LANDING_SCENES, SCENE_DWELL_MS } from "@/lib/landing-scenes";
import { preloadScene } from "@/lib/landing-preload";
import styles from "./LandingExperience.module.css";

const LandingSplat = dynamic(() => import("./LandingSplat"), { ssr: false });

export default function LandingExperience({ onEnter, onExitStart, exitDuration = 540 }: { onEnter: () => void; onExitStart?: () => void; exitDuration?: number }) {
  // 客户端里和手机上不显示下载入口
  const [showDownload, setShowDownload] = useState(false);
  useEffect(() => { setShowDownload(!isDesktopApp() && !matchMedia("(max-width: 767px)").matches); }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exploringRef = useRef(false);
  const [exploring, setExploring] = useState(false);
  const [depth, setDepth] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [status, setStatus] = useState<LandingSceneStatus>("loading");
  const [load, setLoad] = useState<LandingLoadProgress>({ phase: "download", percent: null });
  const [sceneAttempt, setSceneAttempt] = useState(0);
  // 轮流播放的场景：每个停留 SCENE_DWELL_MS；正在拖动探索、减少动态效果时不自动换
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = LANDING_SCENES[sceneIndex];
  // 第一次之后的场景切换：新场景晚一点开始载入，先让标题换语言的动画流畅跑完
  const switched = useRef(false);
  // 核显极致档：镜头移动期间标题玻璃省掉色散（见 GlassTitle 的 lite），停下后恢复
  const [sceneMoving, setSceneMoving] = useState(false);
  const sceneMotion = useCallback((moving: boolean) => setSceneMoving(moving), []);
  const showScene = useCallback((index: number) => {
    switched.current = true;
    markCopyBusy();
    setSceneIndex(index);
    setSceneMoving(false);
    setLoad({ phase: "download", percent: null });
    setStatus("loading");
  }, []);
  const sceneStatus = useCallback((next: LandingSceneStatus) => setStatus(next), []);
  const sceneProgress = useCallback((next: LandingLoadProgress) => setLoad(next), []);
  const retryScene = () => {
    setLoad({ phase: "download", percent: null });
    setStatus("loading");
    // Remount to cancel the old download and release its WebGL context before retrying.
    setSceneAttempt(attempt => attempt + 1);
  };
  const restoreCopy = useCallback(() => {
    if (quietTimer.current) clearTimeout(quietTimer.current);
    quietTimer.current = null;
    exploringRef.current = false;
    setExploring(false);
  }, []);
  // 标题换语言、诗句一笔一划写完之前，拖动场景不让文字隐去（镜头照常跟着拖动）；写完之后拖动才隐去。
  // 万一诗句没有报告写完，换场 9 秒后也放开。
  const copyBusyRef = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markCopyBusy = useCallback(() => {
    copyBusyRef.current = true;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => { copyBusyRef.current = false; }, 9000);
  }, []);
  const taglineWritten = useCallback((written: boolean) => {
    if (written) { copyBusyRef.current = false; if (copyTimer.current) clearTimeout(copyTimer.current); }
  }, []);
  const exploreScene = useCallback(() => {
    if (copyBusyRef.current) return;
    if (!exploringRef.current) { exploringRef.current = true; setExploring(true); }
    if (quietTimer.current) clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(restoreCopy, 1000);
  }, [restoreCopy]);
  const reveal = Math.max(0, Math.min(1, (depth - 0.25) / 0.6));
  // 标题区域的原图越亮，标题下方压得越暗（不去加重玻璃的色调）
  const dim = Math.max(0, Math.min(1, (scene.luma - .12) / .3));
  const count = LANDING_SCENES.length;
  // 当前场景就绪、诗句写完后，把下一个场景读进内存，切过去时不用再下载
  useEffect(() => {
    if (status !== "ready" || LANDING_SCENES.length < 2) return;
    const timer = setTimeout(() => preloadScene(LANDING_SCENES[(sceneIndex + 1) % LANDING_SCENES.length]), 4000);
    return () => clearTimeout(timer);
  }, [status, sceneIndex]);
  useEffect(() => {
    if (reduced || exploring || status !== "ready" || LANDING_SCENES.length < 2) return;
    const timer = setTimeout(() => showScene((sceneIndex + 1) % LANDING_SCENES.length), SCENE_DWELL_MS);
    return () => clearTimeout(timer);
  }, [reduced, exploring, status, sceneIndex, showScene]);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener("change", change);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // PageUp/PageDown/Space remain native, accessible scrolling interactions.
    scrollRef.current?.focus({ preventScroll: true });
    return () => {
      media.removeEventListener("change", change);
      document.body.style.overflow = previous;
      if (exitRef.current) clearTimeout(exitRef.current);
      if (quietTimer.current) clearTimeout(quietTimer.current);
    };
  }, []);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    onExitStart?.();
    exitRef.current = setTimeout(onEnter, reduced ? 100 : exitDuration);
  };
  const advance = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reduced ? "instant" : "smooth" });
  const progress = (event: React.UIEvent<HTMLDivElement>) => {
    restoreCopy();
    const el = event.currentTarget;
    setDepth(Math.max(0, Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight))));
  };

  return <div ref={scrollRef} className={`${styles.experience} ${leaving ? styles.leaving : ""}`} onScroll={progress} data-exploring={exploring ? "true" : "false"} data-external-transition={onExitStart ? "true" : undefined}
    tabIndex={0} role="dialog" aria-modal="true" aria-label="Pixel Reconstruction，三维场景体验"
    onKeyDown={(event) => {
      if (event.key === "Escape") enter();
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === scrollRef.current)) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    style={{ "--depth": depth, "--reveal": reveal, "--dim": dim, "--scene-tint": scene.tint } as CSSProperties}>
    <div className={styles.journey}>
      <div className={styles.viewport}>
        <div className={styles.scene}>
          {/* 每个场景一张原图：切换时先淡入下一张原图，3D 场景载入后叠在它上面（原图不撤走，
              场景里稀疏的地方透出的就是原图），全程不黑屏 */}
          {/* 只挂载上一个（淡出用）、当前和下一个（预载）场景的原图，首屏不必一次下载全部 */}
          {LANDING_SCENES.map((item, index) => {
            const offset = (index - sceneIndex + count) % count;
            if (offset > 1 && offset < count - 1) return null;
            return <img key={item.id}
              className={`${styles.poster} ${index !== sceneIndex ? styles.posterHidden : ""}`}
              src={`/scene/${item.id}.jpg`} alt={index === sceneIndex ? item.alt : ""} aria-hidden={index !== sceneIndex} fetchPriority={index === sceneIndex ? "high" : "low"} />;
          })}
          <div className={`${styles.splats} ${status === "ready" ? styles.splatsReady : ""}`}><LandingSplat key={`${scene.id}-${sceneAttempt}`} startDelay={switched.current ? 480 : 0} scene={scene} depth={depth} reducedMotion={reduced} onStatus={sceneStatus} onInteraction={exploreScene} onProgress={sceneProgress} onMotion={sceneMotion} /></div>
        </div>
        <div className={styles.shade} aria-hidden="true" />

        <header className={styles.header} onMouseDown={titleBarMouseDown}>
          <div className={styles.brand} aria-label="Pixel Reconstruction" data-brand-target="">
            <BrandMark size={40} />
            <span>Pixel<br />Reconstruction<small>SINGLE-IMAGE 3D</small></span>
          </div>
          <div className={styles.headerActions}>
          {showDownload && <a className={`${styles.skip} ${styles.download}`} href={DESKTOP_DOWNLOAD} download>下载 Windows 客户端 <span aria-hidden="true">↓</span></a>}
          <button className={styles.skip} onClick={enter} onPointerEnter={restoreCopy} onFocus={restoreCopy}>直接进入 <span aria-hidden="true">↗</span></button>
          <WindowControls className="on-scene" />
          </div>
        </header>

        <div className={styles.intro} aria-hidden={reveal > .5}>
          <div className={styles.sceneCopy} data-scene-copy="intro">
          <span className={styles.eyebrow}><i /> 单张照片 · 三维重建</span>
          {/* 标题用场景所在地的语言，玻璃的色调取自场景的主光 */}
          <GlassTitle lines={scene.title.lines} lang={scene.title.lang} tint={scene.tint} luma={scene.luma} lite={leaving || sceneMoving} />
          {/* 一句写这个地方的诗，用当地语言，一笔一划手写出来；墨色按背景深浅换 */}
          <HandwrittenTagline className={styles.tagline} data={(HANDWRITING as Record<string, Handwriting>)[scene.id]} ink={scene.ink} halo={scene.halo} delay={420}
            hold={status === "loading"} onWritten={taglineWritten} />
          </div>
        </div>

        <div className={styles.invitation} aria-hidden={reveal < .5}>
          <button className={styles.build} onClick={enter} onPointerEnter={restoreCopy} onFocus={restoreCopy} disabled={reveal < .5} tabIndex={reveal < .5 ? -1 : 0} aria-label="开始创作，进入 Pixel Reconstruction 工作室">
            <span className={styles.letters} aria-hidden="true">{"开始创作".split("").map((character, index) => <span key={character} style={{ "--letter": index } as CSSProperties}>{character}</span>)}</span>
            <span className={styles.buildArrow} aria-hidden="true">↗</span>
          </button>
        </div>

        <footer className={styles.footer}>
          <div className={styles.sceneLabel}>
            {/* 场景切换：一条玻璃轨道，选中项是一滴会流动的玻璃（可点、可拖、方向键）；
                选中项底部的细线走完停留时间。窄屏只显示圆点。 */}
            {count > 1 && <LiquidSegmented className={styles.scenes} ariaLabel="切换展示场景" value={scene.id}
              onChange={id => showScene(LANDING_SCENES.findIndex(item => item.id === id))}
              options={LANDING_SCENES.map((item, index) => ({
                value: item.id, title: `${item.name} · ${item.place}`,
                label: <>
                  <span className={styles.sceneName}>{item.name}</span><span className={styles.sceneDot} aria-hidden="true" />
                  {index === sceneIndex && status === "ready" && !reduced && <i key={`${item.id}-${sceneAttempt}`} className={exploring ? styles.dwellPaused : styles.dwell}
                    style={{ animationDuration: `${SCENE_DWELL_MS}ms` }} aria-hidden="true" />}
                </>,
              }))} />}
            <div className={styles.sceneStatus}>
            <span className={`${styles.statusDot} ${status === "ready" ? styles.readyDot : ""}`} />
            <span>{status === "ready" ? "实时 3D · 拖动探索" : status === "loading" ? (load.phase === "process" ? "正在整理空间" : "正在唤醒空间") : "原图预览"}</span>
            {status === "fallback" && <button className={styles.retryScene} onClick={retryScene}>重新载入 3D</button>}
            {status === "loading" && <span className={styles.loadMeter}>
              {/* Determinate while bytes arrive; sweeps when the size is unknown; breathes while parsing. */}
              <span className={styles.loadTrack} role="progressbar" aria-label="三维场景载入进度" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={load.phase === "download" && load.percent !== null ? Math.floor(load.percent) : undefined}
                aria-valuetext={load.phase === "process" ? "下载完成，正在整理空间" : load.percent === null ? "正在下载" : undefined}
                data-state={load.phase === "process" ? "process" : load.percent === null ? "unknown" : "download"}>
                <span style={load.phase === "download" && load.percent !== null ? { transform: `scaleX(${load.percent / 100})` } : undefined} />
              </span>
              {load.phase === "download" && load.percent !== null && <span className={styles.loadPercent} aria-hidden="true">{Math.floor(load.percent)}%</span>}
            </span>}
            </div>
          </div>
          <button onClick={advance} className={styles.scrollHint} tabIndex={reveal > .7 ? -1 : 0} aria-label="向下滚动，显示开始创作">
            <span>向下滚动</span><span className={styles.scrollLine} aria-hidden="true" />
          </button>
          <span className={styles.edition}>{scene.place} · 由一张照片重建</span>
        </footer>
        <div className={styles.progress} aria-hidden="true"><span /></div>
      </div>
    </div>
  </div>;
}
