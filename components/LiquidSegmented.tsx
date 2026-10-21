"use client";
// 液态玻璃分段滑块：点选、拖动、键盘都可以。滑块是一块会流动的玻璃——
// 移动时前沿先走、后沿跟上被拉长变薄，到位回弹；按下时玻璃抬起鼓起（从不缩小）、边缘光变亮，
// 拖动时跟手，松手吸附到最近的选项。
// 和导航标签栏（components/LiquidTabBar.tsx）同一种玻璃：按住、拖动或切换途中，滑块浮起成一滴透明的透镜，
// 把底下的文字放大、边缘折射（Chromium 内核里），松手落回去。
// 物理见 lib/liquid.ts。减少动态效果时直接跳到目标。
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LiquidSpring, Spring } from "@/lib/liquid";
import { lensMap, supportsRefraction } from "@/lib/glass-lens";

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
.lq-thumb[data-pressed]{box-shadow:inset 0 1px 1.5px #fff,inset 0 -1px 2px rgba(0,90,200,.18),0 8px 22px rgba(0,70,160,.2),0 1px 3px rgba(0,40,110,.12);}
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
/* 浮起的透镜：容器只管位移伸缩，不透明度放在子层（容器带 opacity 会成为 backdrop root，折射就看不到背后） */
.lq-lens{position:absolute;top:4px;bottom:4px;left:0;border-radius:999px;z-index:2;pointer-events:none;visibility:hidden;transform-origin:center;will-change:transform;}
.lq-md .lq-lens{top:5px;bottom:5px;border-radius:19px;}
.lq-lens>span{position:absolute;inset:0;border-radius:inherit;opacity:var(--lq-o,0);}
.lq-lens-glass{background:rgba(255,255,255,.06);}
.lq:not([data-refract]) .lq-lens-glass{background:rgba(255,255,255,.22);-webkit-backdrop-filter:blur(1px) saturate(1.4) brightness(1.05);backdrop-filter:blur(1px) saturate(1.4) brightness(1.05);}
.lq-lens-rim{box-shadow:0 10px 24px -8px rgba(20,40,70,.26),0 2px 6px -2px rgba(20,40,70,.14),inset 0 0 0 .5px rgba(255,255,255,.75),inset 1.5px 1.5px 1px -.5px rgba(255,255,255,.9),inset -1.5px -1.5px 1px -.5px rgba(255,255,255,.5),inset 0 0 12px rgba(255,255,255,.2);}
[data-theme="dark"] .lq-lens-glass{background:rgba(255,250,240,.04);}
[data-theme="dark"] .lq-lens-rim{box-shadow:0 12px 26px -8px rgba(0,0,0,.55),0 2px 6px -2px rgba(0,0,0,.4),inset 0 0 0 .5px rgba(255,246,226,.45),inset 1.5px 1.5px 1px -.5px rgba(255,246,226,.6),inset -1.5px -1.5px 1px -.5px rgba(255,246,226,.25),inset 0 0 12px rgba(255,246,226,.08);}
.lq-defs{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;}
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
  // 按下：response 0.25、阻尼 0.72 的弹簧鼓起到 1.08
  const pressRef = useRef(new Spring(1, .25, .72));
  const pressingRef = useRef(false);
  const [hot, setHot] = useState<T | null>(null);   // 拖动中滑块下的选项，文字先亮起
  const [dragging, setDragging] = useState(false);
  const reduced = useRef(false);
  // 透镜：按住或切换途中浮起（0–1），尺寸固定、伸缩用 transform
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const lensRef = useRef<HTMLSpanElement>(null);
  const liftRef = useRef(new Spring(0, .3, .7));
  const targetRef = useRef<{ left: number; right: number } | null>(null);
  const [refract, setRefract] = useState(false);
  const [lens, setLens] = useState({ w: 0, h: 0, r: 0 });
  useEffect(() => { setRefract(supportsRefraction()); }, []);

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
    const press = pressRef.current.value;
    thumb.style.transform = `translate3d(${spring.left}px,0,0) scale(${press},${spring.squash * press})`;
    // 高光跟着滑块在槽里的位置走，像光从一侧打过来
    thumb.style.setProperty("--hx", `${Math.round(((spring.left + width / 2) / Math.max(1, track.clientWidth)) * 100)}%`);
    const lensEl = lensRef.current;
    if (!lensEl) return;
    const v = reduced.current ? 0 : Math.max(0, Math.min(1, liftRef.current.value));
    const lift = v * v * (3 - 2 * v);
    thumb.style.opacity = String(1 - lift * .9);
    const base = lensEl.offsetWidth || 1;
    lensEl.style.transform = `translate3d(${(spring.left + spring.right) / 2 - base / 2}px,0,0) scale(${width / base * (1 + .1 * lift)},${(1 + .26 * lift) * (.6 + .4 * spring.squash)})`;
    lensEl.style.setProperty("--lq-o", lift.toFixed(3));
    lensEl.style.visibility = lift < .005 ? "hidden" : "visible";
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
      const press = pressRef.current;
      press.target = spring.dragging || pressingRef.current ? 1.08 : 1;
      const swelling = press.step(dt);
      // 按住时透镜一直浮着；切换途中按剩余距离浮起，快到位时落回成滑块
      const lift = liftRef.current, target = targetRef.current;
      const remaining = target ? Math.abs((target.left + target.right) / 2 - (spring.left + spring.right) / 2) : 0;
      lift.target = pressingRef.current || spring.dragging ? 1 : Math.min(.85, remaining / 60);
      lift.configure(lift.target > lift.value ? .26 : .42, lift.target > lift.value ? .68 : .84);
      const lifting = lift.step(dt);
      paint();
      if (moving || swelling || lifting || pressingRef.current) rafRef.current = requestAnimationFrame(frame);
      else rafRef.current = 0;
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [paint]);

  const index = Math.max(0, options.findIndex(o => o.value === value));
  const indexRef = useRef(index);
  indexRef.current = index;
  const place = useCallback((immediate: boolean) => {
    const target = rects()[indexRef.current];
    if (!target) return;
    targetRef.current = target;
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
    const measureLens = () => {
      const thumb = thumbRef.current;
      const widths = rects().map(r => r.right - r.left);
      const h = thumb?.offsetHeight || 0;
      const r = Math.min(h / 2, parseFloat(thumb ? getComputedStyle(thumb).borderTopLeftRadius : "") || h / 2);
      const next = { w: Math.round(Math.max(16, ...widths)), h, r };
      setLens(prev => prev.w === next.w && prev.h === next.h && prev.r === next.r ? prev : next);
    };
    measureLens();
    const observer = new ResizeObserver(() => {
      measureLens();
      const next = `${track.clientWidth}x${track.clientHeight}`;
      if (next !== size) { size = next; place(true); }
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [place]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  useLayoutEffect(() => { if (lensRef.current && lens.w) { lensRef.current.style.width = lens.w + "px"; paint(); } }, [lens.w, paint]);
  const map = useMemo(() => refract && lens.w && lens.h ? lensMap(lens.w, lens.h, "lens", { radius: lens.r, magnify: 1.14, bend: Math.min(lens.h * .16, 9), bezel: Math.min(lens.h * .36, lens.r + 4) }) : null, [refract, lens.w, lens.h, lens.r]);
  const lensFilter = map ? `url(#lq-${uid}) blur(.3px) saturate(1.5) brightness(1.05)` : undefined;

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
    setPressed(true);
    // 在控件外松开也要落回原大小
    const release = () => { removeEventListener("pointerup", release); removeEventListener("pointercancel", release); if (pressingRef.current) setPressed(false); };
    addEventListener("pointerup", release);
    addEventListener("pointercancel", release);
  };
  const setPressed = (on: boolean) => {
    pressingRef.current = on;
    if (on) thumbRef.current?.setAttribute("data-pressed", "");
    else thumbRef.current?.removeAttribute("data-pressed");
    if (!reduced.current) animate();
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
    if (state) setPressed(false);
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

  return <div ref={trackRef} data-no-press="" className={`lq lq-${size} ${className}`} style={style} role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} data-refract={refract || undefined}
    data-dragging={dragging || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish} onKeyDown={onKeyDown}>
    <span ref={thumbRef} className="lq-thumb" aria-hidden="true" />
    <span ref={lensRef} className="lq-lens" aria-hidden="true">
      <span className="lq-lens-glass" style={lensFilter ? { WebkitBackdropFilter: lensFilter, backdropFilter: lensFilter } as CSSProperties : undefined} />
      <span className="lq-lens-rim" />
    </span>
    {map && <svg className="lq-defs" aria-hidden="true" focusable="false">
      <filter id={`lq-${uid}`} x="0" y="0" width={lens.w} height={lens.h} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={map.url} x="0" y="0" width={lens.w} height={lens.h} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>}
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
