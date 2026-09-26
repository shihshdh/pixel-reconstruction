"use client";
// 液态玻璃分段滑块：点选、拖动、键盘都可以。滑块是一块会流动的玻璃——
// 移动时前沿先走、后沿跟上被拉长变薄，到位回弹；按住时轻微鼓起，拖动时跟手，松手吸附到最近的选项。
// 物理见 lib/liquid.ts。减少动态效果时直接跳到目标。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LiquidSpring } from "@/lib/liquid";

export type LiquidOption<T extends string> = { value: T; label: ReactNode; sub?: ReactNode; disabled?: boolean; title?: string };

const CSS = `
.lq{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:4px;border-radius:999px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--track) 70%,transparent),color-mix(in srgb,var(--track) 40%,transparent));
  border:1px solid var(--line);box-shadow:inset 0 1px 2px rgba(20,50,90,.08);touch-action:pan-y;user-select:none;-webkit-user-select:none;isolation:isolate;cursor:grab;}
.lq[data-dragging]{cursor:grabbing;}
.lq-thumb{position:absolute;top:4px;bottom:4px;left:0;width:0;border-radius:999px;z-index:-1;pointer-events:none;will-change:transform,width;
  background:linear-gradient(165deg,rgba(255,255,255,.98),rgba(255,255,255,.62) 46%,rgba(206,228,255,.58));
  box-shadow:inset 0 1px 1px #fff,inset 0 -1px 2px rgba(0,90,200,.14),0 5px 16px rgba(0,70,160,.16),0 1px 3px rgba(0,40,110,.12);
  backdrop-filter:blur(6px) saturate(190%);-webkit-backdrop-filter:blur(6px) saturate(190%);transform-origin:center;}
.lq-thumb::before{content:"";position:absolute;inset:1px 12% auto;height:48%;border-radius:50%;
  background:radial-gradient(ellipse 60% 100% at 50% 0%,rgba(255,255,255,.95),rgba(255,255,255,0) 72%);opacity:.9;}
.lq-thumb::after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:radial-gradient(60% 120% at var(--hx,50%) 100%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 70%);}
[data-theme="dark"] .lq{box-shadow:inset 0 1px 2px rgba(0,0,0,.35);}
[data-theme="dark"] .lq-thumb{background:linear-gradient(165deg,rgba(255,255,255,.26),rgba(255,255,255,.08) 50%,rgba(208,180,124,.2));
  box-shadow:inset 0 1px 1px rgba(255,255,255,.35),inset 0 -1px 2px rgba(208,180,124,.2),0 6px 18px rgba(0,0,0,.4);}
[data-theme="dark"] .lq-thumb::before{background:radial-gradient(ellipse 60% 100% at 50% 0%,rgba(255,255,255,.32),rgba(255,255,255,0) 72%);}
.lq>button{position:relative;border:0;background:none;margin:0;padding:6px 13px;border-radius:999px;color:var(--ink2);
  font:inherit;font-size:12px;line-height:1.2;white-space:nowrap;cursor:inherit;transition:color .28s,opacity .2s;}
.lq>button[data-on]{color:var(--accent);}
.lq>button:disabled{opacity:.42;cursor:not-allowed;}
/* 全站按钮的悬停上浮、按压下沉交给滑块自己的“鼓起”表现，这里不叠加 */
.ruhua-root .lq>button,.ruhua-root .lq>button:hover,.ruhua-root .lq>button:active{transform:none!important;box-shadow:none!important;background:none!important;}
.lq>button:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
.lq-md{border-radius:24px;padding:5px;}
.lq-md .lq-thumb{top:5px;bottom:5px;border-radius:19px;}
.lq-md>button{padding:15px 10px;border-radius:19px;}
.lq-md>button strong{display:block;font-size:16px;font-weight:600;margin-bottom:5px;}
.lq-md>button span{display:block;font-size:11px;letter-spacing:.015em;color:var(--ink3);}
.lq-md>button[data-on] span{color:inherit;opacity:.85;}
@media(prefers-reduced-motion:reduce){.lq>button{transition:none;}}
`;

let styleInjected = false;
function useStyle() {
  useLayoutEffect(() => {
    if (styleInjected || typeof document === "undefined") return;
    styleInjected = true;
    const style = document.createElement("style");
    style.dataset.liquid = "";
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

export default function LiquidSegmented<T extends string>({ options, value, onChange, size = "sm", ariaLabel, disabled = false, className = "", style }: {
  options: LiquidOption<T>[]; value: T; onChange: (value: T) => void; size?: "sm" | "md";
  ariaLabel: string; disabled?: boolean; className?: string; style?: React.CSSProperties;
}) {
  useStyle();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const springRef = useRef<LiquidSpring | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const pressRef = useRef(1);
  const [hot, setHot] = useState<T | null>(null);   // 拖动中滑块下的选项，文字先亮起
  const [dragging, setDragging] = useState(false);
  const reduced = useRef(false);

  const rects = useCallback(() => {
    const track = trackRef.current;
    if (!track) return [];
    return Array.from(track.querySelectorAll<HTMLButtonElement>(":scope > button")).map(b => ({ left: b.offsetLeft, right: b.offsetLeft + b.offsetWidth }));
  }, []);

  const paint = useCallback(() => {
    const spring = springRef.current, thumb = thumbRef.current, track = trackRef.current;
    if (!spring || !thumb || !track) return;
    const width = Math.max(0, spring.right - spring.left);
    thumb.style.width = width + "px";
    thumb.style.transform = `translate3d(${spring.left}px,0,0) scale(${pressRef.current},${spring.squash * pressRef.current})`;
    // 高光跟着滑块在槽里的位置走，像光从一侧打过来
    thumb.style.setProperty("--hx", `${Math.round(((spring.left + width / 2) / Math.max(1, track.clientWidth)) * 100)}%`);
  }, []);

  const animate = useCallback(() => {
    if (rafRef.current) return;
    lastRef.current = 0;
    const frame = (now: number) => {
      const spring = springRef.current;
      if (!spring) { rafRef.current = 0; return; }
      const dt = lastRef.current ? Math.min(.05, (now - lastRef.current) / 1000) : 1 / 60;
      lastRef.current = now;
      const moving = spring.step(dt);
      const pressTarget = spring.dragging ? 1.05 : 1;
      pressRef.current += (pressTarget - pressRef.current) * Math.min(1, dt * 18);
      paint();
      if (moving || Math.abs(pressRef.current - pressTarget) > .002) rafRef.current = requestAnimationFrame(frame);
      else { pressRef.current = pressTarget; paint(); rafRef.current = 0; }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [paint]);

  const index = Math.max(0, options.findIndex(o => o.value === value));
  const indexRef = useRef(index);
  indexRef.current = index;
  const place = useCallback((immediate: boolean) => {
    const target = rects()[indexRef.current];
    if (!target) return;
    if (!springRef.current) { springRef.current = new LiquidSpring(target); paint(); return; }
    springRef.current.setTarget(target, immediate || reduced.current);
    if (immediate || reduced.current) paint(); else animate();
  }, [rects, paint, animate]);
  // 选中项变化（点选、拖动、外部改动）：弹簧流过去
  useLayoutEffect(() => {
    reduced.current = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    place(false);
  }, [index, options.length, place]);
  // 轨道尺寸真的变了（窗口缩放、文字变化）才直接对齐，不播放流动
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let size = `${track.clientWidth}x${track.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const next = `${track.clientWidth}x${track.clientHeight}`;
      if (next !== size) { size = next; place(true); }
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [place]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ---- 拖动 ----
  const drag = useRef<{ id: number; x: number; moved: boolean; width: number } | null>(null);
  const suppressClick = useRef(false);
  const nearest = (center: number) => {
    const all = rects();
    let best = -1, distance = Infinity;
    all.forEach((r, i) => {
      if (options[i]?.disabled) return;
      const d = Math.abs((r.left + r.right) / 2 - center);
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || !springRef.current) return;
    const spring = springRef.current;
    drag.current = { id: event.pointerId, x: event.clientX, moved: false, width: spring.right - spring.left };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current, spring = springRef.current, track = trackRef.current;
    if (!state || state.id !== event.pointerId || !spring || !track) return;
    if (!state.moved && Math.abs(event.clientX - state.x) < 4) return;
    if (!state.moved) {
      state.moved = true; spring.dragging = true; setDragging(true);
      track.setPointerCapture(event.pointerId);
    }
    const box = track.getBoundingClientRect();
    const center = event.clientX - box.left;
    // 拖到哪个选项附近，宽度就渐变成那个选项的宽度
    const target = rects()[nearest(center)];
    if (target) state.width += ((target.right - target.left) - state.width) * .25;
    spring.drag(center, state.width, 4, track.clientWidth - 4);
    const i = nearest(center);
    setHot(i >= 0 ? options[i].value : null);
    animate();
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current, spring = springRef.current, track = trackRef.current;
    drag.current = null;
    if (!state?.moved || !spring || !track) return;
    suppressClick.current = true;
    spring.dragging = false; setDragging(false); setHot(null);
    const i = nearest((spring.left + spring.right) / 2);
    const target = rects()[i >= 0 ? i : index];
    if (target) spring.setTarget(target);
    animate();
    if (i >= 0 && options[i].value !== value) onChange(options[i].value);
    try { track.releasePointerCapture(event.pointerId); } catch {}
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    for (let i = index + step; i >= 0 && i < options.length; i += step) {
      if (!options[i].disabled) {
        onChange(options[i].value);
        trackRef.current?.querySelectorAll<HTMLButtonElement>(":scope > button")[i]?.focus();
        break;
      }
    }
  };

  return <div ref={trackRef} data-no-press="" className={`lq lq-${size} ${className}`} style={style} role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined}
    data-dragging={dragging || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish} onKeyDown={onKeyDown}>
    <span ref={thumbRef} className="lq-thumb" aria-hidden="true" />
    {options.map(option => {
      const on = hot !== null ? hot === option.value : option.value === value;
      return <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1}
        disabled={disabled || option.disabled} title={option.title} data-on={on || undefined}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (option.value !== value) onChange(option.value); }}>
        {size === "md" ? <><strong>{option.label}</strong>{option.sub !== undefined && <span>{option.sub}</span>}</> : option.label}
      </button>;
    })}
  </div>;
}

/** 只有流动效果、不接管交互的指示条（导航栏当前页的玻璃底块）。left/width 为像素。 */
export function LiquidIndicator({ left, width, className }: { left: number; width: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const springRef = useRef<LiquidSpring | null>(null);
  const rafRef = useRef(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const paint = () => {
      const spring = springRef.current!;
      element.style.width = Math.max(0, spring.right - spring.left) + "px";
      element.style.transform = `translate3d(${spring.left}px,0,0) scaleY(${spring.squash})`;
    };
    const target = { left, right: left + width };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!springRef.current || reduced) { springRef.current = new LiquidSpring(target); paint(); return; }
    springRef.current.setTarget(target);
    let last = 0;
    cancelAnimationFrame(rafRef.current);
    const frame = (now: number) => {
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const moving = springRef.current!.step(dt);
      paint();
      rafRef.current = moving ? requestAnimationFrame(frame) : 0;
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [left, width]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  return <span ref={ref} aria-hidden="true" className={className} style={{ transition: "none", transformOrigin: "center" }} />;
}
