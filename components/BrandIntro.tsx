"use client";

// Opening title. Four pixels gather out of a drifting pixel field, the volume draws
// itself, the name arrives beside it, and the lockup flies into the landing header
// while the field rushes past like parallax layers and the scene opens underneath.
//
// Everything that moves is an HTML transform/opacity animation, so it keeps running
// on the compositor while the landing scene downloads and parses on the main thread.
// The timeline is plain CSS and starts at first paint (the markup is prerendered and
// a boot script in <head> arms it); script only adds skip, pointer parallax and the
// measured landing flight. It plays on every full page load; in-site navigation never replays it.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import BrandMark from "./BrandMark";
import { INTRO_TEMPO, INTRO_TIME } from "@/lib/intro";
import landing from "./LandingExperience.module.css";
import s from "./BrandIntro.module.css";

const EASE = "cubic-bezier(.16,1,.3,1)";
const EASE_SOFT = "cubic-bezier(.4,0,.2,1)";
/** Long travel starts from rest: gentle lift-off, long settle (same family as the showcase shutters). */
const EASE_TRAVEL = "cubic-bezier(.65,0,.2,1)";

// ---------- mark geometry (the BrandMark 64-unit grid) ----------
const pct = (v: number) => `${+(v / 64 * 100).toFixed(4)}%`;

/** The logo's four pixels, each arriving from a different corner of the field. */
const PIXELS = [
  { x: 4, y: 12, o: .36, d: 500, from: "translate(-170px,-96px) rotate(-120deg) scale(1.9)" },
  { x: 17, y: 5, o: .64, d: 680, from: "translate(64px,-150px) rotate(96deg) scale(1.6)" },
  { x: 4, y: 27, o: .64, d: 860, from: "translate(-232px,22px) rotate(-72deg) scale(2.1)" },
  { x: 4, y: 42, o: 1, d: 1040, from: "translate(-92px,142px) rotate(140deg) scale(1.7)" },
];

type Point = [number, number];
const TOP: Point = [37, 12], BOTTOM: Point = [37, 59], CENTER: Point = [37, 36];
/** Outline drawn from the top vertex down both sides at once; they meet at the bottom. */
const SIDES: Point[][] = [
  [TOP, [58, 24], [58, 47], BOTTOM],
  [TOP, [17, 24], [17, 47], BOTTOM],
];
/** Inner edges grow from the centre out to three vertices. */
const SPOKES: Point[] = [[17, 24], [58, 24], BOTTOM];

const STROKE = 2.5;
function bar([ax, ay]: Point, [bx, by]: Point): CSSProperties {
  const length = Math.hypot(bx - ax, by - ay);
  const angle = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
  const cap = STROKE / 2;
  return {
    left: pct(ax - cap), top: pct(ay - cap), width: pct(length + STROKE), height: pct(STROKE),
    transformOrigin: `${+(cap / (length + STROKE) * 100).toFixed(4)}% 50%`,
    transform: `rotate(${+angle.toFixed(3)}deg)`,
  };
}

/** cubic-bezier(x1,y1,x2,y2) as a function of time, solved by bisection. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, u: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  return (t: number) => {
    let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 24; i++) { u = (lo + hi) / 2; if (at(x1, x2, u) < t) lo = u; else hi = u; }
    return at(y1, y2, u);
  };
}

// One eased progress drives the whole outline, so the stroke never changes speed at a
// corner: each edge's keyframes are that global curve, sliced to its share of the length.
// Base timings (ms) at tempo 1; the generated keyframes are scaled by INTRO_TEMPO like the CSS ones.
const T = (ms: number) => Math.round(ms * INTRO_TEMPO);
const DRAW = { delay: T(2150), duration: T(1100), ease: bezier(.45, 0, .2, 1) };
const SPOKE = { delay: T(3050), duration: T(760), stagger: T(90) };
const SAMPLES = 28;

function sliceKeyframes(name: string, from: number, to: number) {
  const frames: [number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    frames.push([t, Math.max(0, Math.min(1, (DRAW.ease(t) - from) / (to - from)))]);
  }
  // Drop samples inside flat runs (before the edge starts, after it ends).
  const kept = frames.filter(([, p], i) => i === 0 || i === frames.length - 1 || !(p === frames[i - 1][1] && p === frames[i + 1][1]));
  // Parked slightly past -100% so no antialiased sliver shows through the clip before the stroke starts.
  const offset = (p: number) => p <= 0 ? -102 : +((p - 1) * 100).toFixed(3);
  return `@keyframes ${name}{${kept.map(([t, p]) => `${+(t * 100).toFixed(3)}%{transform:translateX(${offset(p)}%)}`).join("")}}`;
}

type Edge = { key: string; style: CSSProperties; animation: string };
const EDGES: Edge[] = [];
let DRAW_CSS = "";
SIDES.forEach((side, sideIndex) => {
  const lengths = side.slice(1).map((p, i) => Math.hypot(p[0] - side[i][0], p[1] - side[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let run = 0;
  lengths.forEach((length, i) => {
    const name = `pr-intro-draw-${sideIndex}${i}`;
    DRAW_CSS += sliceKeyframes(name, run / total, (run + length) / total);
    run += length;
    EDGES.push({ key: name, style: bar(side[i], side[i + 1]), animation: `${name} ${DRAW.duration}ms linear ${DRAW.delay}ms both` });
  });
});
SPOKES.forEach((end, i) => EDGES.push({
  key: `spoke-${i}`, style: bar(CENTER, end),
  animation: `pr-intro-spoke ${SPOKE.duration}ms cubic-bezier(.33,1,.68,1) ${SPOKE.delay + i * SPOKE.stagger}ms both`,
}));
DRAW_CSS += "@keyframes pr-intro-spoke{from{transform:translateX(-102%)}to{transform:none}}";
// Each logo pixel flies in along its own literal keyframes (no CSS variables in animations).
PIXELS.forEach((pixel, i) => { DRAW_CSS += `@keyframes pr-intro-px${i}{from{transform:${pixel.from}}to{transform:none}}`; });
DRAW_CSS += "@keyframes pr-intro-fade{from{opacity:0}}";
const pixelAnimation = (i: number) =>
  `pr-intro-px${i} ${T(1500)}ms cubic-bezier(.22,1,.36,1) ${T(PIXELS[i].d)}ms both, pr-intro-fade ${T(700)}ms linear ${T(PIXELS[i].d)}ms both`;

// ---------- pixel field: three depths, deterministic so server and client agree ----------
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DEPTHS = [
  { name: "far", count: 30, size: [3, 5], alpha: [.12, .28], seed: 11 },
  { name: "mid", count: 16, size: [6, 9], alpha: [.1, .22], seed: 29 },
  { name: "near", count: 8, size: [13, 19], alpha: [.05, .11], seed: 47 },
] as const;
const FIELD = DEPTHS.map(depth => {
  const next = random(depth.seed);
  const squares: { style: CSSProperties; accent: boolean }[] = [];
  while (squares.length < depth.count) {
    const x = 3 + next() * 94, y = 4 + next() * 92;
    // Keep the centre clear for the lockup.
    if (((x - 50) / 36) ** 2 + ((y - 50) / 21) ** 2 < 1 || Math.abs(y - 50) < 8) continue;
    const size = Math.round(depth.size[0] + next() * (depth.size[1] - depth.size[0]));
    const alpha = depth.alpha[0] + next() * (depth.alpha[1] - depth.alpha[0]);
    // Outer pixels surface first, as if the field were gathering inward.
    const reach = Math.min(1, Math.hypot((x - 50) / 50, (y - 50) / 50));
    const delay = Math.round(80 + (1 - reach) * 620 + next() * 260);
    squares.push({
      accent: next() < .24,
      style: { left: `${+x.toFixed(2)}%`, top: `${+y.toFixed(2)}%`, width: size, height: size, opacity: +alpha.toFixed(3), animationDelay: `${T(delay)}ms` },
    });
  }
  return { name: depth.name, squares };
});
/** How far each depth rushes past the camera when the title opens into the scene. */
const RUSH = [1.14, 1.42, 2.1];

const letters = (text: string, offset: number) => text.split("").map((character, index) =>
  <span key={index} className={s.letter} style={{ animationDelay: `${T(4800 + (offset + index) * 48)}ms` }}>{character}</span>);

export default function BrandIntro() {
  const [live, setLive] = useState(true);
  const [running, setRunning] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<HTMLDivElement>(null);
  const lockupRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLSpanElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const skipRequest = useRef<(reason: string) => void>(() => {});
  // ?introdebug shows a small status line, so the title can be diagnosed from a phone screenshot.
  const [debug, setDebug] = useState("");

  useEffect(() => {
    const html = document.documentElement;
    const root = rootRef.current;
    if (html.getAttribute("data-intro") !== "play" || !root) { setLive(false); return; }
    // The boot script holds the timeline until a frame is on a visible screen; start the script
    // side with it, or the hand-over would be timed against a clock that has not started.
    if (html.hasAttribute("data-intro-hold")) {
      let stop: (() => void) | undefined;
      const watcher = new MutationObserver(() => { if (!html.hasAttribute("data-intro-hold")) { watcher.disconnect(); stop = play(html, root); } });
      watcher.observe(html, { attributes: true, attributeFilter: ["data-intro-hold"] });
      return () => { watcher.disconnect(); stop?.(); };
    }
    return play(html, root);
  }, []);

  function play(html: HTMLElement, root: HTMLDivElement): (() => void) | undefined {
    // Align with the CSS timeline, which has been running since the hold was released.
    const clock = root.getAnimations().find(animation => String((animation as CSSAnimation).animationName || "").includes("introSafety"));
    const startedAt = performance.now() - (typeof clock?.currentTime === "number" ? clock.currentTime : 0);
    const elapsed = () => performance.now() - startedAt;
    if (elapsed() > INTRO_TIME.safety) { html.removeAttribute("data-intro"); setLive(false); return; }
    setRunning(true);

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const layers = layerRefs.current.filter(Boolean) as HTMLDivElement[];
    let phase: "play" | "leaving" | "done" = "play";
    let frame = 0;
    let timer = 0;
    let skippedBy = "";
    const debugTimer = /[?&]introdebug\b/.test(location.search) ? window.setInterval(() => setDebug(
      `开屏调试 · 减少动态效果:${reduced ? "开" : "关"} · 阶段:${phase} · ${Math.round(elapsed())}ms${skippedBy ? " · 跳过:" + skippedBy : ""} · ${window.innerWidth}×${window.innerHeight}`), 200) : 0;
    const settle = (duration: number, easing = EASE): KeyframeAnimationOptions => ({ duration, easing, fill: "forwards" });
    const close = () => { phase = "done"; setLive(false); };

    // Cross-fade out (reduced motion, or skipped before the lockup has formed).
    const dissolve = () => {
      phase = "leaving";
      html.removeAttribute("data-intro");
      root.style.pointerEvents = "none";
      if (!reduced) layers.forEach((layer, i) => layer.animate({ transform: `scale(${RUSH[i]})`, opacity: 0 }, settle(640 + i * 60)));
      root.animate({ opacity: 0 }, settle(reduced ? 420 : 520, EASE_SOFT)).finished.then(close, close);
    };

    // The lockup flies into the landing header while the field rushes past and the scene opens.
    const land = () => {
      const lockup = lockupRef.current, target = targetRef.current, flight = flightRef.current;
      if (!lockup || !target || !flight) return dissolve();
      const from = lockup.getBoundingClientRect(), to = target.getBoundingClientRect();
      if (!from.width || !to.width) return dissolve();
      phase = "leaving";
      html.setAttribute("data-intro", "land");
      root.style.pointerEvents = "none";
      const k = to.width / from.width;
      const flying = flight.animate({ transform: `translate(${to.left - k * from.left}px,${to.top - k * from.top}px) scale(${k})` }, settle(INTRO_TIME.flight, EASE_TRAVEL));
      backdropRef.current?.animate({ opacity: 0 }, { ...settle(1600, EASE_SOFT), delay: 160 });
      glowRef.current?.animate({ opacity: 0 }, settle(800, EASE_SOFT));
      skipRef.current?.animate({ opacity: 0 }, settle(500, EASE_SOFT));
      // Nearer layers rush past faster: the parallax that carries the eye into the scene.
      layers.forEach((layer, i) => layer.animate({ transform: `scale(${RUSH[i]})`, opacity: 0 }, settle(1800 + i * 100, EASE_TRAVEL)));
      flying.finished.then(() => {
        // The real header mark appears underneath, exactly where the lockup landed; fade the copy off it.
        html.removeAttribute("data-intro");
        root.animate({ opacity: 0 }, settle(180, "linear")).finished.then(close, close);
      }, close);
    };

    const skip = (reason: string) => {
      if (phase !== "play") return;
      skippedBy = reason;
      window.clearTimeout(timer);
      if (!reduced && elapsed() >= INTRO_TIME.ready) land(); else dissolve();
    };
    skipRequest.current = skip;
    // Never hand over before the lockup has fully formed: if a slow device has let any of its
    // animations fall behind the clock, wait for them to finish and hold the finished lockup again.
    const handOver = () => {
      if (phase !== "play") return;
      if (reduced) return dissolve();
      const pending = lockupRef.current?.getAnimations({ subtree: true }).filter(animation => animation.playState !== "finished") ?? [];
      if (!pending.length) return land();
      const after = () => { timer = window.setTimeout(() => { if (phase === "play") land(); }, INTRO_TIME.hold); };
      Promise.all(pending.map(animation => animation.finished)).then(after, after);
    };
    timer = window.setTimeout(handOver, Math.max(0, (reduced ? INTRO_TIME.reducedLand : INTRO_TIME.land) - elapsed()));

    // Any key skips; nothing reaches the landing underneath until the title has handed over.
    const key = (event: KeyboardEvent) => {
      if (phase === "done" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      skip("按键");
    };
    // Pointer parallax: nearer layers drift further against the cursor.
    const point = { x: 0, y: 0 };
    const move = (event: PointerEvent) => {
      if (reduced || phase !== "play" || event.pointerType !== "mouse") return;
      point.x = event.clientX / window.innerWidth * 2 - 1;
      point.y = event.clientY / window.innerHeight * 2 - 1;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root.style.setProperty("--px", point.x.toFixed(3));
        root.style.setProperty("--py", point.y.toFixed(3));
      });
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(debugTimer);
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointermove", move);
      skipRequest.current = () => {};
    };
  }

  if (!live) return null;
  // Skip on a deliberate tap or click, a real scroll, or any key: not on the touch that starts a
  // scroll gesture, which on phones used to dismiss the title before it could be seen.
  return <div ref={rootRef} className={s.root} aria-hidden="true" data-running={running ? "" : undefined}
    onClick={() => skipRequest.current("点击")} onWheel={event => { if (Math.abs(event.deltaY) + Math.abs(event.deltaX) > 24) skipRequest.current("滚轮"); }}>
    <style dangerouslySetInnerHTML={{ __html: DRAW_CSS }} />
    <div ref={backdropRef} className={s.backdrop} />
    <div className={s.field}>
      {FIELD.map((layer, index) => <div key={layer.name} ref={el => { layerRefs.current[index] = el; }} className={`${s.layer} ${s[layer.name]}`}>
        {layer.squares.map((square, i) => <i key={i} className={square.accent ? s.accent : undefined} style={square.style} />)}
      </div>)}
    </div>
    <div ref={glowRef} className={s.glow} />

    <div ref={flightRef} className={s.flight}>
      <div className={s.stage}>
        <div className={s.zoom}>
        <div className={s.slide}>
          {/* Same class as the landing header lockup, so the flight ends on an exact copy. */}
          <div ref={lockupRef} className={`${landing.brand} ${s.lockup}`}>
            <span className={s.markBox}>
              <BrandMark size={40} className={s.real} />
              <span className={s.parts}>
                {PIXELS.map((pixel, i) => <i key={i} className={s.px} style={{ left: pct(pixel.x), top: pct(pixel.y), opacity: pixel.o, animation: pixelAnimation(i) }} />)}
                {EDGES.map(edge => <span key={edge.key} className={s.edge} style={edge.style}><i style={{ animation: edge.animation }} /></span>)}
                <svg className={s.faceShell} viewBox="0 0 64 64" fill="none" aria-hidden="true">
                  <path d="M37 12 58 24V47L37 59 17 47V24L37 12Z" fill="currentColor" fillOpacity=".08" />
                  <path d="m37 12 21 12-21 12-20-12 20-12Z" fill="currentColor" fillOpacity=".18" />
                </svg>
                <svg className={s.faceSide} viewBox="0 0 64 64" fill="none" aria-hidden="true">
                  <path d="M17 32v15l12 7V40L17 32Z" fill="currentColor" fillOpacity=".48" />
                </svg>
              </span>
            </span>
            <span>{letters("Pixel", 0)}<br />{letters("Reconstruction", 5)}<small><span className={s.slit}><span>SINGLE-IMAGE 3D</span></span></small></span>
          </div>
        </div>
        </div>
      </div>
    </div>

    {debug && <p className={s.debug}>{debug}</p>}
    {/* A hidden copy of the landing header: the flight's destination and the skip pill's place. */}
    <div className={`${landing.header} ${s.chrome}`}>
      <div ref={targetRef} className={landing.brand} style={{ visibility: "hidden" }}><BrandMark size={40} /><span>Pixel<br />Reconstruction<small>SINGLE-IMAGE 3D</small></span></div>
      <span ref={skipRef} className={`${landing.skip} ${s.skip}`}>跳过<span aria-hidden="true">↗</span></span>
    </div>
  </div>;
}
