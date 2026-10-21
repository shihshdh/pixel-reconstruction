"use client";
// iOS 26 标签栏式的液态玻璃。和以前的磨砂胶囊不同，这是一块真正的透镜：
// - 整条栏是一片胶囊玻璃：边缘一圈圆弧斜面把背后的画面往里折（SVG 位移贴图作 backdrop-filter），中间几乎不弯；
//   轻磨砂 + 很淡的色调，1px 镜面边缘光从指针方向打来，对侧有一道更淡的反光。
// - 静止时选中项下面是一块浅色的“药丸”。按下、拖动或切换途中，药丸浮起成一滴透明的透镜：
//   比栏更高、略宽，把底下的文字放大约 1.2 倍，边缘带不到 1px 的色散；松手后落回去、重新变成药丸。
// - 透镜的两条边各挂一根弹簧（lib/liquid.ts）：移动时前沿先走、后沿跟上，被拉长变薄，到位轻轻回弹。
// 折射只在 Chromium 内核里有（Windows 客户端的 WebView2 也是）；其他浏览器退回普通磨砂玻璃，交互不变。
// 减少动态效果时没有透镜，药丸直接跳到目标。
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LiquidSpring, Spring } from "@/lib/liquid";
import { lensMap, supportsRefraction } from "@/lib/glass-lens";

export type TabItem<T extends string> = { value: T; label: ReactNode; icon?: ReactNode; title?: string; disabled?: boolean };

const CSS = `
@property --ltb-la{syntax:"<angle>";inherits:true;initial-value:315deg;}
/* 布局与尺寸放在 :where() 里（零优先级）：这段样式在运行时插进 <head>，排在页面的 CSS 模块后面，
   不这样做的话使用方给的定位、尺寸都会被它盖掉 */
:where(.ltb){--ltb-h:44px;--ltb-pad:4px;position:relative;display:inline-flex;align-items:stretch;height:var(--ltb-h);padding:var(--ltb-pad);border-radius:999px;box-sizing:border-box;}
:where(.ltb[data-variant="dock"]){--ltb-h:62px;--ltb-pad:5px;}
.ltb{isolation:isolate;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;}
:where(.lgs){position:relative;border-radius:999px;box-sizing:border-box;}
.lgs{isolation:isolate;}
.ltb,.lgs{--ltb-tint:rgba(255,255,255,.2);--ltb-flat:rgba(250,252,255,.74);--ltb-hi:rgba(255,255,255,.95);--ltb-lo:rgba(255,255,255,.3);--ltb-edge:rgba(55,75,105,.1);
  --ltb-shadow:0 12px 32px -12px rgba(25,45,75,.3),0 2px 7px -2px rgba(25,45,75,.12);--ltb-pill:rgba(104,124,150,.15);
  --ltb-ink:var(--ink2);--ltb-on:var(--accent);--ltb-lens:rgba(255,255,255,.07);--ltb-lens-shadow:0 12px 28px -8px rgba(20,40,70,.3),0 2px 8px -2px rgba(20,40,70,.16);}
[data-theme="dark"] .ltb,.ltb[data-tone="dark"],[data-theme="dark"] .lgs,.lgs[data-tone="dark"]{--ltb-tint:rgba(26,24,21,.3);--ltb-flat:rgba(24,22,19,.8);--ltb-hi:rgba(255,247,228,.6);--ltb-lo:rgba(255,247,228,.13);--ltb-edge:rgba(0,0,0,.42);
  --ltb-shadow:0 14px 36px -12px rgba(0,0,0,.66),0 2px 7px -2px rgba(0,0,0,.42);--ltb-pill:rgba(255,248,232,.11);--ltb-lens:rgba(255,250,240,.04);--ltb-lens-shadow:0 14px 30px -8px rgba(0,0,0,.55),0 2px 8px -2px rgba(0,0,0,.4);}
.ltb[data-tone="dark"]{--ltb-ink:rgba(242,238,230,.78);--ltb-on:#e6c78c;}
[data-theme="dark"] .ltb[data-tone="dark"]{--ltb-on:var(--accent);}
.ltb-glass{position:absolute;inset:0;border-radius:inherit;z-index:-3;pointer-events:none;background:var(--ltb-tint);box-shadow:var(--ltb-shadow);}
.ltb:not([data-refract]) .ltb-glass,.lgs:not([data-refract]) .ltb-glass{background:var(--ltb-flat);-webkit-backdrop-filter:blur(18px) saturate(1.8);backdrop-filter:blur(18px) saturate(1.8);}
.ltb-shine{position:absolute;inset:0;border-radius:inherit;z-index:-2;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(255,255,255,0) 48%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),inset 0 -1px 0 var(--ltb-edge),inset 0 0 14px rgba(255,255,255,.16);}
[data-theme="dark"] .ltb-shine,.ltb[data-tone="dark"] .ltb-shine,.lgs[data-tone="dark"] .ltb-shine{background:linear-gradient(180deg,rgba(255,248,232,.07),rgba(255,248,232,0) 48%);box-shadow:inset 0 1px 0 rgba(255,248,232,.16),inset 0 -1px 0 var(--ltb-edge),inset 0 0 14px rgba(255,248,232,.05);}
/* 镜面边缘光：一圈 1px 的环，最亮处朝向光源（指针），对侧一道更淡的反光 */
.ltb-rim{position:absolute;inset:0;border-radius:inherit;padding:1px;z-index:3;pointer-events:none;
  background:conic-gradient(from calc(var(--ltb-la) - 70deg),var(--ltb-lo) 0deg,var(--ltb-hi) 70deg,var(--ltb-lo) 130deg,transparent 160deg,var(--ltb-lo) 200deg,color-mix(in srgb,var(--ltb-hi) 55%,transparent) 250deg,var(--ltb-lo) 300deg,transparent 330deg,var(--ltb-lo) 360deg);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);
  transition:--ltb-la .6s cubic-bezier(.2,.8,.2,1);}
.ltb-pill{position:absolute;left:0;top:var(--ltb-pad);bottom:var(--ltb-pad);width:0;border-radius:999px;z-index:-1;pointer-events:none;transform-origin:center;will-change:transform,width,opacity;
  background:var(--ltb-pill);box-shadow:inset 0 .5px 0 rgba(255,255,255,.32);}
/* 透镜容器只做位移与伸缩；不透明度放在子层上——容器带 opacity 会成为 backdrop root，里面的折射就看不到背后了 */
.ltb-lens{position:absolute;left:0;top:var(--ltb-pad);bottom:var(--ltb-pad);border-radius:999px;z-index:2;pointer-events:none;visibility:hidden;transform-origin:center;will-change:transform;}
.ltb-lens>span{opacity:var(--ltb-o,0);}
.ltb-lens-glass{position:absolute;inset:0;border-radius:inherit;background:var(--ltb-lens);}
.ltb:not([data-refract]) .ltb-lens-glass{background:rgba(255,255,255,.2);-webkit-backdrop-filter:blur(1px) saturate(1.4) brightness(1.06);backdrop-filter:blur(1px) saturate(1.4) brightness(1.06);}
.ltb-lens-rim{position:absolute;inset:0;border-radius:inherit;
  box-shadow:var(--ltb-lens-shadow),inset 0 0 0 .5px rgba(255,255,255,.72),inset 1.5px 1.5px 1px -.5px rgba(255,255,255,.9),inset -1.5px -1.5px 1px -.5px rgba(255,255,255,.5),inset 0 0 12px rgba(255,255,255,.2);}
.ltb>button{position:relative;z-index:1;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:7px;min-width:0;border:0;background:none;margin:0;padding:0 18px;border-radius:999px;
  color:var(--ltb-ink);font:inherit;font-size:12px;font-weight:500;letter-spacing:.05em;line-height:1;white-space:nowrap;cursor:pointer;transition:color .3s;}
.ltb>button[data-on]{color:var(--ltb-on);}
.ltb>button:disabled{opacity:.4;cursor:not-allowed;}
.ltb>button svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
.ltb>button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
.ltb[data-variant="dock"]>button{flex-direction:column;gap:4px;padding:0 16px;font-size:10px;letter-spacing:.02em;}
.ltb[data-variant="dock"]>button svg{width:24px;height:24px;stroke-width:1.5;}
.ruhua-root .ltb>button,.ruhua-root .ltb>button:hover,.ruhua-root .ltb>button:active{transform:none!important;box-shadow:none!important;background:none!important;}
.lgs>.ltb-glass,.lgs>.ltb-shine,.lgs>.ltb-rim{border-radius:inherit;}
.ltb-defs{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;}
@media(prefers-reduced-motion:reduce){.ltb>button{transition:none;}.ltb-rim{transition:none;}}
`;

let styleInjected = false;
function useStyle() {
  useLayoutEffect(() => {
    if (styleInjected || typeof document === "undefined") return;
    styleInjected = true;
    const style = document.createElement("style");
    style.dataset.liquidTabbar = "";
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// 透镜比药丸高出 36%、宽出 16%：在 44px 的栏上会探出上下沿各约 6px
const LIFT_Y = .36, LIFT_X = .16;

export default function LiquidTabBar<T extends string>({ items, value, onChange, ariaLabel, variant = "bar", nav = false, tone, className = "", style, id: idProp }: {
  items: TabItem<T>[]; value: T; onChange: (value: T) => void; ariaLabel: string;
  /** bar：横排文字（导航）；dock：图标在上、文字在下（底部标签栏） */
  variant?: "bar" | "dock";
  /** 作导航用：按钮标 aria-current="page"，而不是 tab 语义 */
  nav?: boolean;
  /** 悬浮在三维画面、视频上时用 dark，跟随页面主题时不填 */
  tone?: "dark";
  className?: string; style?: CSSProperties; id?: string;
}) {
  useStyle();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  const springRef = useRef<LiquidSpring | null>(null);
  const liftRef = useRef(new Spring(0, .3, .7));
  const pressingRef = useRef(false);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const reduced = useRef(false);
  const [refract, setRefract] = useState(false);
  const [dims, setDims] = useState({ w: 0, h: 0, lw: 0, lh: 0 });
  const [hot, setHot] = useState<T | null>(null);
  useEffect(() => { setRefract(supportsRefraction()); }, []);

  const rects = useCallback(() => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLButtonElement>(":scope > button")).map(b => ({ left: b.offsetLeft, right: b.offsetLeft + b.offsetWidth }));
  }, []);

  const paint = useCallback(() => {
    const spring = springRef.current, pill = pillRef.current, lens = lensRef.current, root = rootRef.current;
    if (!spring || !pill || !lens || !root) return;
    const width = Math.max(0, spring.right - spring.left);
    const lift = reduced.current ? 0 : smooth(liftRef.current.value);
    pill.style.width = width + "px";
    pill.style.transform = `translate3d(${spring.left}px,0,0) scaleY(${spring.squash})`;
    pill.style.opacity = String(1 - lift);
    const base = lens.offsetWidth || 1;
    const sx = width / base * (1 + LIFT_X * lift), sy = (1 + LIFT_Y * lift) * (.6 + .4 * spring.squash);
    lens.style.transform = `translate3d(${(spring.left + spring.right) / 2 - base / 2}px,0,0) scale(${sx},${sy})`;
    lens.style.setProperty("--ltb-o", lift.toFixed(3));
    lens.style.visibility = lift < .005 ? "hidden" : "visible";
    root.style.setProperty("--ltb-lift", lift.toFixed(3));
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
      // 按住时透镜一直浮着；切换途中按剩余距离浮起，快到位时落回成药丸
      const lift = liftRef.current;
      const target = rectsTarget.current;
      const remaining = target ? Math.abs((target.left + target.right) / 2 - (spring.left + spring.right) / 2) : 0;
      lift.target = pressingRef.current || spring.dragging ? 1 : Math.min(.9, remaining / 70);
      lift.configure(lift.target > lift.value ? .26 : .42, lift.target > lift.value ? .68 : .84);
      const lifting = lift.step(dt);
      paint();
      if (moving || lifting || pressingRef.current) rafRef.current = requestAnimationFrame(frame);
      else rafRef.current = 0;
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [paint]);

  const index = Math.max(0, items.findIndex(item => item.value === value));
  const indexRef = useRef(index);
  indexRef.current = index;
  const rectsTarget = useRef<{ left: number; right: number } | null>(null);
  const aim = useCallback((i: number, immediate = false) => {
    const target = rects()[i];
    if (!target) return;
    rectsTarget.current = target;
    if (!springRef.current) { springRef.current = new LiquidSpring(target); paint(); return; }
    springRef.current.setTarget(target, immediate || reduced.current);
    if (immediate || reduced.current) paint(); else animate();
  }, [rects, paint, animate]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const pad = parseFloat(getComputedStyle(root).paddingTop) || 0;
    const widths = rects().map(r => r.right - r.left);
    const next = { w: root.offsetWidth, h: root.offsetHeight, lw: Math.round(Math.max(24, ...widths)), lh: Math.round(root.offsetHeight - pad * 2) };
    setDims(prev => prev.w === next.w && prev.h === next.h && prev.lw === next.lw && prev.lh === next.lh ? prev : next);
  }, [rects]);

  useLayoutEffect(() => {
    reduced.current = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    aim(indexRef.current);
  }, [index, items.length, aim]);
  useLayoutEffect(() => { measure(); }, [measure, items.length]);
  // 字体载入、窗口缩放：只重新对齐，不播放流动
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => { measure(); aim(indexRef.current, true); });
    observer.observe(root);
    root.querySelectorAll(":scope > button").forEach(b => observer.observe(b));
    return () => observer.disconnect();
  }, [measure, aim, items.length]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  // 透镜的固定尺寸（伸缩用 transform）；尺寸变了才重绘
  useLayoutEffect(() => { if (lensRef.current) { lensRef.current.style.width = dims.lw + "px"; paint(); } }, [dims.lw, paint]);

  const barMap = useMemo(() => refract && dims.w ? lensMap(dims.w, dims.h, "bar") : null, [refract, dims.w, dims.h]);
  const lensMapData = useMemo(() => refract && dims.lw ? lensMap(dims.lw, dims.lh, "lens", { magnify: 1.2 }) : null, [refract, dims.lw, dims.lh]);

  // ---- 光源跟随指针 ----
  const light = (event: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || event.pointerType === "touch") return;
    const box = root.getBoundingClientRect();
    const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
    const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
    root.style.setProperty("--ltb-la", `${Math.round(Math.atan2(dx, -dy) * 180 / Math.PI)}deg`);
  };
  const unlight = () => rootRef.current?.style.removeProperty("--ltb-la");

  // ---- 按下、拖动 ----
  const drag = useRef<{ id: number; x: number; moved: boolean; width: number; start: number } | null>(null);
  const suppressClick = useRef(false);
  const nearest = (center: number) => {
    let best = -1, distance = Infinity;
    rects().forEach((r, i) => {
      if (items[i]?.disabled) return;
      const d = Math.abs((r.left + r.right) / 2 - center);
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  };
  const setPressed = (on: boolean) => { pressingRef.current = on; if (!reduced.current) animate(); };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !springRef.current) return;
    const root = rootRef.current!;
    const box = root.getBoundingClientRect();
    const scale = box.width / Math.max(1, root.offsetWidth);
    const pressed = nearest((event.clientX - box.left) / scale);
    drag.current = { id: event.pointerId, x: event.clientX, moved: false, width: springRef.current.right - springRef.current.left, start: pressed };
    setPressed(true);
    // 按下就让透镜往按住的那一项流过去，像 iOS 一样不用等松手
    if (pressed >= 0 && !items[pressed].disabled) { aim(pressed); setHot(items[pressed].value); }
    const release = () => {
      removeEventListener("pointerup", release); removeEventListener("pointercancel", release);
      if (pressingRef.current) setPressed(false);
    };
    addEventListener("pointerup", release);
    addEventListener("pointercancel", release);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    light(event);
    const state = drag.current, spring = springRef.current, root = rootRef.current;
    if (!state || state.id !== event.pointerId || !spring || !root) return;
    if (!state.moved && Math.abs(event.clientX - state.x) < 5) return;
    if (!state.moved) { state.moved = true; spring.dragging = true; root.setPointerCapture(event.pointerId); }
    const box = root.getBoundingClientRect();
    const scale = box.width / Math.max(1, root.offsetWidth);
    const center = (event.clientX - box.left) / scale;
    const i = nearest(center);
    const target = rects()[i];
    if (target) state.width += ((target.right - target.left) - state.width) * .25;
    const pad = (root.offsetHeight - dims.lh) / 2 || 4;
    spring.drag(center, state.width, pad, root.offsetWidth - pad);
    setHot(i >= 0 ? items[i].value : null);
    animate();
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current, spring = springRef.current, root = rootRef.current;
    drag.current = null;
    if (state) setPressed(false);
    setHot(null);
    if (!state || !spring || !root) return;
    try { root.releasePointerCapture(event.pointerId); } catch {}
    if (!state.moved) { if (state.start >= 0 && items[state.start].value === value) aim(index); return; }
    suppressClick.current = true;
    spring.dragging = false;
    const i = nearest((spring.left + spring.right) / 2);
    aim(i >= 0 ? i : index);
    if (i >= 0 && items[i].value !== value) onChange(items[i].value);
  };
  const cancel = () => {
    const spring = springRef.current;
    drag.current = null; setHot(null);
    if (spring) spring.dragging = false;
    setPressed(false);
    aim(indexRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    for (let i = index + step; i >= 0 && i < items.length; i += step) {
      if (items[i].disabled) continue;
      onChange(items[i].value);
      rootRef.current?.querySelectorAll<HTMLButtonElement>(":scope > button")[i]?.focus();
      break;
    }
  };

  const id = idProp || `ltb-${uid}`;
  const barFilter = barMap ? `url(#${id}-b) blur(2.5px) saturate(1.75) brightness(1.04)` : undefined;
  const lensFilter = lensMapData ? `url(#${id}-l) blur(.3px) saturate(1.5) brightness(1.06)` : undefined;
  return <div ref={rootRef} id={idProp} data-no-press="" className={`ltb ${className}`} style={style} data-variant={variant} data-tone={tone} data-refract={refract || undefined}
    role={nav ? undefined : "tablist"} aria-label={ariaLabel}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={cancel} onPointerLeave={unlight} onKeyDown={onKeyDown}>
    <span className="ltb-glass" aria-hidden="true" style={barFilter ? { WebkitBackdropFilter: barFilter, backdropFilter: barFilter } as CSSProperties : undefined} />
    <span className="ltb-shine" aria-hidden="true" />
    <span ref={pillRef} className="ltb-pill" aria-hidden="true" />
    {items.map((item, i) => {
      const selected = item.value === value;
      const on = hot !== null ? hot === item.value : selected;
      return <button key={item.value} type="button" data-own-motion="" title={item.title} disabled={item.disabled} data-on={on || undefined}
        role={nav ? undefined : "tab"} aria-selected={nav ? undefined : selected} aria-current={nav && selected ? "page" : undefined}
        tabIndex={selected ? 0 : -1}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          aim(i);
          if (!selected) onChange(item.value);
        }}>
        {item.icon}{item.label}
      </button>;
    })}
    <span ref={lensRef} className="ltb-lens" aria-hidden="true">
      <span className="ltb-lens-glass" style={lensFilter ? { WebkitBackdropFilter: lensFilter, backdropFilter: lensFilter } as CSSProperties : undefined} />
      <span className="ltb-lens-rim" />
    </span>
    <span className="ltb-rim" aria-hidden="true" />
    {refract && (barMap || lensMapData) && <svg className="ltb-defs" aria-hidden="true" focusable="false">
      {barMap && <filter id={`${id}-b`} x="0" y="0" width={dims.w} height={dims.h} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={barMap.url} x="0" y="0" width={dims.w} height={dims.h} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={barMap.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>}
      {/* 透镜：三个通道用略有差别的位移量各取一次再相加，色散只在边缘、不到 1px */}
      {lensMapData && <filter id={`${id}-l`} x="0" y="0" width={dims.lw} height={dims.lh} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={lensMapData.url} x="0" y="0" width={dims.lw} height={dims.lh} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={lensMapData.scale * .985} xChannelSelector="R" yChannelSelector="G" result="dr" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={lensMapData.scale} xChannelSelector="R" yChannelSelector="G" result="dg" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={lensMapData.scale * 1.015} xChannelSelector="R" yChannelSelector="G" result="db" />
        <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
        <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
        <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
        <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
        <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" />
      </filter>}
    </svg>}
  </div>;
}

/** 不带选择逻辑的同款玻璃胶囊（导航栏两侧的分组、漫游界面的按钮组）。尺寸变了自动重算折射贴图。 */
export function GlassSurface({ children, className = "", style, tone, ...rest }: { children?: ReactNode; className?: string; style?: CSSProperties; tone?: "dark" } & React.HTMLAttributes<HTMLDivElement>) {
  useStyle();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [refract, setRefract] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0, r: 0 });
  useEffect(() => { setRefract(supportsRefraction()); }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      const r = Math.min(h / 2, parseFloat(getComputedStyle(el).borderTopLeftRadius) || h / 2);
      setSize(prev => prev.w === w && prev.h === h && prev.r === r ? prev : { w, h, r });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const map = useMemo(() => refract && size.w ? lensMap(size.w, size.h, "bar", { radius: size.r, bezel: Math.min(size.h * .42, size.r * 1.2 + 4) }) : null, [refract, size.w, size.h, size.r]);
  const filter = map ? `url(#lgs-${uid}) blur(2.5px) saturate(1.75) brightness(1.04)` : undefined;
  const light = (event: React.PointerEvent<HTMLDivElement>) => {
    rest.onPointerMove?.(event);
    const el = ref.current;
    if (!el || event.pointerType === "touch") return;
    const box = el.getBoundingClientRect();
    const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2), dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
    el.style.setProperty("--ltb-la", `${Math.round(Math.atan2(dx, -dy) * 180 / Math.PI)}deg`);
  };
  return <div {...rest} ref={ref} className={`lgs ${className}`} style={style} data-tone={tone} data-refract={refract || undefined}
    onPointerMove={light} onPointerLeave={event => { rest.onPointerLeave?.(event); ref.current?.style.removeProperty("--ltb-la"); }}>
    <span className="ltb-glass" aria-hidden="true" style={filter ? { WebkitBackdropFilter: filter, backdropFilter: filter } as CSSProperties : undefined} />
    <span className="ltb-shine" aria-hidden="true" />
    {children}
    <span className="ltb-rim" aria-hidden="true" />
    {map && <svg className="ltb-defs" aria-hidden="true" focusable="false">
      <filter id={`lgs-${uid}`} x="0" y="0" width={size.w} height={size.h} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={map.url} x="0" y="0" width={size.w} height={size.h} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>}
  </div>;
}
