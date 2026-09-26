"use client";

import GlassTitle from "@/components/GlassTitle";
import { DESKTOP_DOWNLOAD, isDesktopApp, titleBarMouseDown } from "@/lib/desktop";
import WindowControls from "@/components/WindowControls";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { LandingLoadProgress, LandingSceneStatus } from "./LandingSplat";
import BrandMark from "./BrandMark";
import { LANDING_SCENES, SCENE_DWELL_MS } from "@/lib/landing-scenes";
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
  const showScene = useCallback((index: number) => {
    setSceneIndex(index);
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
  const exploreScene = useCallback(() => {
    if (!exploringRef.current) { exploringRef.current = true; setExploring(true); }
    if (quietTimer.current) clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(restoreCopy, 1000);
  }, [restoreCopy]);
  const reveal = Math.max(0, Math.min(1, (depth - 0.25) / 0.6));
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
    style={{ "--depth": depth, "--reveal": reveal } as CSSProperties}>
    <div className={styles.journey}>
      <div className={styles.viewport}>
        <div className={styles.scene}>
          {/* 每个场景一张原图：切换时先淡入下一张原图，3D 场景载入完成后再淡出，全程不黑屏 */}
          {LANDING_SCENES.map((item, index) => <img key={item.id}
            className={`${styles.poster} ${index !== sceneIndex || status === "ready" ? styles.posterHidden : ""}`}
            src={`/scene/${item.id}.jpg`} alt={index === sceneIndex ? item.alt : ""} aria-hidden={index !== sceneIndex} fetchPriority={index === 0 ? "high" : "low"} />)}
          <div className={`${styles.splats} ${status === "ready" ? styles.splatsReady : ""}`}><LandingSplat key={`${scene.id}-${sceneAttempt}`} scene={scene} depth={depth} reducedMotion={reduced} onStatus={sceneStatus} onInteraction={exploreScene} onProgress={sceneProgress} /></div>
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
          <GlassTitle lines={["一张照片，", "一整个世界。"]} />
          <p>拍下的那一刻，从此可以走进去。</p>
          </div>
        </div>

        <div className={styles.invitation} aria-hidden={reveal < .5}>
          <p className={`${styles.invitationNote} ${styles.sceneCopy}`} data-scene-copy="invitation">{scene.caption}</p>
          <button className={styles.build} onClick={enter} onPointerEnter={restoreCopy} onFocus={restoreCopy} disabled={reveal < .5} tabIndex={reveal < .5 ? -1 : 0} aria-label="开始创作，进入 Pixel Reconstruction 工作室">
            <span className={styles.letters} aria-hidden="true">{"开始创作".split("").map((character, index) => <span key={character} style={{ "--letter": index } as CSSProperties}>{character}</span>)}</span>
            <span className={styles.buildArrow} aria-hidden="true">↗</span>
          </button>
          <p className={`${styles.invitationSub} ${styles.sceneCopy}`} data-scene-copy="invitation">你的下一张照片，同样可以。</p>
        </div>

        <footer className={styles.footer}>
          <div className={styles.sceneLabel}>
            {LANDING_SCENES.length > 1 && <div className={styles.scenes} role="tablist" aria-label="切换展示场景">
              {LANDING_SCENES.map((item, index) => <button key={item.id} role="tab" aria-selected={index === sceneIndex}
                className={styles.sceneTab} onClick={() => index !== sceneIndex && showScene(index)}>
                <b>{item.name}</b><small>{item.place}</small>
                {index === sceneIndex && status === "ready" && !reduced && <i key={`${item.id}-${sceneAttempt}`} className={exploring ? styles.dwellPaused : styles.dwell}
                  style={{ animationDuration: `${SCENE_DWELL_MS}ms` }} aria-hidden="true" />}
              </button>)}
            </div>}
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
