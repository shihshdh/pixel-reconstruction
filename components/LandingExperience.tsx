"use client";

import { DESKTOP_DOWNLOAD, isDesktopApp } from "@/lib/desktop";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { LandingLoadProgress, LandingSceneStatus } from "./LandingSplat";
import BrandMark from "./BrandMark";
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
          <img className={`${styles.poster} ${status === "ready" ? styles.posterHidden : ""}`} src="/scene/landing.jpg" alt="夕阳照进临海的房间，墙上挂着画，窗外是停泊的船" fetchPriority="high" />
          <div className={`${styles.splats} ${status === "ready" ? styles.splatsReady : ""}`}><LandingSplat key={sceneAttempt} depth={depth} reducedMotion={reduced} onStatus={sceneStatus} onInteraction={exploreScene} onProgress={sceneProgress} /></div>
        </div>
        <div className={styles.shade} aria-hidden="true" />

        <header className={styles.header}>
          <div className={styles.brand} aria-label="Pixel Reconstruction" data-brand-target="">
            <BrandMark size={40} />
            <span>Pixel<br />Reconstruction<small>SINGLE-IMAGE 3D</small></span>
          </div>
          <div className={styles.headerActions}>
          {showDownload && <a className={`${styles.skip} ${styles.download}`} href={DESKTOP_DOWNLOAD} download>下载 Windows 客户端 <span aria-hidden="true">↓</span></a>}
          <button className={styles.skip} onClick={enter} onPointerEnter={restoreCopy} onFocus={restoreCopy}>直接进入 <span aria-hidden="true">↗</span></button>
          </div>
        </header>

        <div className={styles.intro} aria-hidden={reveal > .5}>
          <div className={styles.sceneCopy} data-scene-copy="intro">
          <span className={styles.eyebrow}><i /> A MOMENT, IN SPACE</span>
          <h1>让照片，<br /><em>多一个维度。</em></h1>
          <p>光落下的地方，也可以走进去。</p>
          </div>
        </div>

        <div className={styles.invitation} aria-hidden={reveal < .5}>
          <p className={`${styles.invitationNote} ${styles.sceneCopy}`} data-scene-copy="invitation">这也是一张照片长出来的。</p>
          <button className={styles.build} onClick={enter} onPointerEnter={restoreCopy} onFocus={restoreCopy} disabled={reveal < .5} tabIndex={reveal < .5 ? -1 : 0} aria-label="开始构建，进入 Pixel Reconstruction 工作室">
            <span className={styles.letters} aria-hidden="true">{"开始构建".split("").map((character, index) => <span key={character} style={{ "--letter": index } as CSSProperties}>{character}</span>)}</span>
            <span className={styles.buildArrow} aria-hidden="true">↗</span>
          </button>
          <p className={`${styles.invitationSub} ${styles.sceneCopy}`} data-scene-copy="invitation">把你的下一张照片，变成可以探索的空间。</p>
        </div>

        <footer className={styles.footer}>
          <div className={styles.sceneLabel}><span className={`${styles.statusDot} ${status === "ready" ? styles.readyDot : ""}`} />
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
          <button onClick={advance} className={styles.scrollHint} tabIndex={reveal > .7 ? -1 : 0} aria-label="向下探索，显示开始构建">
            <span>向下，走近一点</span><span className={styles.scrollLine} aria-hidden="true" />
          </button>
          <span className={styles.edition}>一张照片 / 无限想象</span>
        </footer>
        <div className={styles.progress} aria-hidden="true"><span /></div>
      </div>
    </div>
  </div>;
}
