"use client";
// 液态玻璃标题：每个字都是一块透镜，折射它后面的画面（展示页的 3D 场景）。
//
// 材质按 Apple Liquid Glass 的描述来做：
// - 是透镜而不是磨砂塑料。一层覆盖标题的元素加 backdrop-filter，用 SVG clipPath 裁成字形；
//   滤镜把字形模糊成高度场，Sobel 求梯度，feDisplacementMap 沿梯度位移背后的画面——
//   梯度只在字形边缘附近（约 14px 内）才大，所以弯折集中在边缘，字心基本透明。
// - 色散只在边缘、最多约 1px：R/G/B 三个通道用略有差别的位移量各取一次再相加。
// - 轻磨砂 + 10–16% 的白色调；白色里掺一点场景的主光颜色，随场景切换。
// - 1px 镜面边缘光从左上方打来，右下方有一道更淡的反向高光；光的方向跟着指针缓慢偏转。
// - 柔和的接触投影只画在字形外面（半透明字形透出投影，玻璃就“脏”了）。
// - 背景太亮时不加重色调，而是在标题下方自适应压暗（由展示页按原图亮度控制）。
//
// 换语言时不交叉淡化：旧字 120ms 退出（模糊 6px、缩到 0.96、淡出），60ms 后新字按弹簧
// （response 0.45、阻尼 0.86）进入，新旧文字不重叠；色调在整个过程中连续变化。
//
// 字形位置按真实排版逐行测量（字体、字号、字距一致），窗口或字体变化时重新测量。
// SVG 滤镜用于 backdrop-filter 目前只有 Chromium 支持（Windows 客户端的 WebView2 即是）；
// 其他浏览器退回普通磨砂玻璃，文字照常可读。
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Spring } from "@/lib/liquid";

type Line = { text: string; x: number; y: number };
type Title = { lines: string[]; lang?: string };

const STYLE = `
/* 换场缩放用独立的 scale 属性：展示页的入场动画占用了 transform */
/* 每行不折行：玻璃层按行测量位置，行内折行会让折射与文字错开。字号由使用方保证放得下 */
.gt{position:relative;display:inline-block;transform-origin:0 50%;white-space:nowrap;
  scale:var(--gt-s,1);--gt-o:1;--gt-b:0;}
/* 表面层：只画上沿的一抹反光，字形内部保持透明，让下面的玻璃层透出来。
   细描边只在没有折射的浏览器里加重，保证那里仍然看得清字形。 */
.gt-rim{position:relative;z-index:2;display:block;color:transparent;text-shadow:none;
  -webkit-text-stroke:.6px rgba(255,255,255,.34);
  background:linear-gradient(174deg,rgba(255,255,255,.42) 0%,rgba(255,255,255,.06) 28%,rgba(255,255,255,0) 50%,rgba(255,255,255,.1) 100%);
  -webkit-background-clip:text;background-clip:text;
  opacity:var(--gt-o);filter:blur(calc(var(--gt-b) * 1px));}
.gt[data-refract] .gt-rim{-webkit-text-stroke-color:rgba(255,255,255,.14);}
.gt-rim>span{display:inline;}
.gt-glass{position:absolute;inset:0;pointer-events:none;z-index:0;opacity:var(--gt-o);}
.gt-layer{position:absolute;inset:0;pointer-events:none;display:block;color:#fff;opacity:var(--gt-o);}
.gt-shadow{z-index:-1;}
.gt-bevel{z-index:1;}
.gt-bevel.hi{mix-blend-mode:screen;}
.gt-bevel.lo{mix-blend-mode:multiply;}
.gt-defs{position:absolute;width:0;height:0;overflow:hidden;}
`;
let injected = false;

// 光源：默认左上方（SVG 方位角顺时针自 x 轴，y 向下，235° 即左上），指针移动时最多偏转 ±28°
const LIGHT_AZIMUTH = 235, LIGHT_SWING = 28;
const EXIT_MS = 120, GAP_MS = 60, EXIT_BLUR = 6, EXIT_SCALE = .96;

export default function GlassTitle({ lines, lang, tint = "#ffffff", luma = .15, className, style, label }: {
  lines: string[]; lang?: string; tint?: string; luma?: number; className?: string; style?: CSSProperties; label?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<HTMLHeadingElement>(null);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [shown, setShown] = useState<Title>({ lines, lang });
  const [layout, setLayout] = useState<{ w: number; h: number; font: string; size: number; spacing: string; weight: string; lines: Line[] } | null>(null);
  const [refract, setRefract] = useState(false);
  const reduced = useRef(false);
  // 逐帧直接写 DOM 的部分（不经过 React）：光源方向、色调
  const lights = useRef<{ key: SVGFEDistantLightElement | null; counter: SVGFEDistantLightElement | null; body: SVGFEDistantLightElement | null }>({ key: null, counter: null, body: null });
  const shadeRef = useRef<SVGFEDiffuseLightingElement | null>(null);
  const glassRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!injected) { injected = true; const s = document.createElement("style"); s.textContent = STYLE; document.head.appendChild(s); }
    // 只有支持 SVG 滤镜作 backdrop-filter 的内核才开折射
    setRefract(/Chrome|Edg\//.test(navigator.userAgent) && CSS_supports("backdrop-filter", "url(#x)"));
    reduced.current = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // ---- 换语言：退出 → 间隔 → 弹簧进入 ----
  // pending：新文字已交给 React、还在等排版测量；进入动画由测量完成后启动
  const anim = useRef({ o: 1, b: 0, s: 1, raf: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, pending: false });
  const paintSwap = () => {
    const root = rootRef.current, a = anim.current;
    if (!root) return;
    root.style.setProperty("--gt-o", a.o.toFixed(3));
    root.style.setProperty("--gt-b", a.b.toFixed(2));
    root.style.setProperty("--gt-s", a.s.toFixed(4));
  };
  const key = lines.join("\n") + "|" + (lang || "");
  const shownKey = shown.lines.join("\n") + "|" + (shown.lang || "");
  const startEnter = () => {
    const a = anim.current;
    // 从当前的透明度出发，打断退出时也连续
    const progress = new Spring(Math.min(1, a.o), .45, .86);
    progress.target = 1;
    let last = 0;
    const enter = (now: number) => {
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const moving = progress.step(dt);
      const p = progress.value;
      a.o = Math.min(1, p); a.b = EXIT_BLUR * Math.max(0, 1 - p); a.s = EXIT_SCALE + (1 - EXIT_SCALE) * p;
      paintSwap();
      a.raf = moving ? requestAnimationFrame(enter) : 0;
    };
    cancelAnimationFrame(a.raf);
    a.raf = requestAnimationFrame(enter);
  };
  useEffect(() => {
    const a = anim.current;
    if (key === shownKey) {
      // 退出途中又切回了正在显示的文字：原地进入
      if (!a.pending && a.o < 1 && !reduced.current) { if (a.timer) { clearTimeout(a.timer); a.timer = 0; } startEnter(); }
      return;
    }
    cancelAnimationFrame(a.raf);
    if (a.timer) clearTimeout(a.timer);
    if (reduced.current) { setShown({ lines, lang }); return; }
    // 退出：从当前状态出发（打断进入时也不会跳）
    const from = { o: a.o, b: a.b, s: a.s };
    const started = performance.now();
    const exit = (now: number) => {
      const t = Math.min(1, (now - started) / EXIT_MS);
      const e = t * t; // 加速离开
      a.o = from.o * (1 - e); a.b = from.b + (EXIT_BLUR - from.b) * e; a.s = from.s + (EXIT_SCALE - from.s) * e;
      paintSwap();
      if (t < 1) { a.raf = requestAnimationFrame(exit); return; }
      a.timer = setTimeout(() => { a.timer = 0; a.pending = true; setShown({ lines, lang }); }, GAP_MS);
    };
    a.raf = requestAnimationFrame(exit);
    return () => { if (!a.pending) { cancelAnimationFrame(a.raf); if (a.timer) clearTimeout(a.timer); a.timer = 0; } };
  }, [key, shownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 进入：新文字排好版以后开始（等 layout 测量完，否则会先闪一下旧位置的玻璃）
  useEffect(() => {
    if (!anim.current.pending || !layout) return;
    anim.current.pending = false;
    startEnter();
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancelAnimationFrame(anim.current.raf); if (anim.current.timer) clearTimeout(anim.current.timer); }, []);

  // ---- 色调：整个换场过程中连续变化，不硬切 ----
  const color = useRef({ from: hexRgb(tint), to: hexRgb(tint), mix: new Spring(1, .45, .86), raf: 0 });
  const paintTint = () => {
    const c = color.current, root = rootRef.current;
    if (!root) return;
    const rgb = c.from.map((v, i) => v + (c.to[i] - v) * c.mix.value);
    // 玻璃的色调：白色里掺 45% 场景主光，整体 14% 不透明——看得出颜色，又不像彩色塑料
    const glass = rgb.map(v => Math.round(v * .45 + 255 * .55));
    if (glassRef.current) glassRef.current.style.backgroundColor = `rgba(${glass.join(",")},.14)`;
    // 背光面的暗部也带一点同样的颜色，字身就有了“有色玻璃”的体积
    shadeRef.current?.setAttribute("lighting-color", `rgb(${rgb.map(v => Math.round(v * .5 + 255 * .5)).join(",")})`);
    root.style.setProperty("--gt-tint", rgb.map(Math.round).join(","));
  };
  useEffect(() => {
    const c = color.current;
    const next = hexRgb(tint);
    if (next.join() === c.to.join()) { paintTint(); return; }
    // 从当前显示的颜色出发
    c.from = c.from.map((v, i) => v + (c.to[i] - v) * c.mix.value) as RGB;
    c.to = next;
    if (reduced.current) { c.mix.set(1); paintTint(); return; }
    c.mix.set(0); c.mix.target = 1;
    let last = 0;
    cancelAnimationFrame(c.raf);
    const frame = (now: number) => {
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const moving = c.mix.step(dt);
      paintTint();
      c.raf = moving ? requestAnimationFrame(frame) : 0;
    };
    c.raf = requestAnimationFrame(frame);
  }, [tint, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(color.current.raf), []);

  // ---- 光源跟随指针（弹簧 response 0.3、阻尼 0.9），高光在字形边缘上滑动 ----
  useEffect(() => {
    if (reduced.current) return;
    const azimuth = new Spring(LIGHT_AZIMUTH, .3, .9), elevation = new Spring(0, .3, .9);
    let raf = 0, last = 0;
    const paint = () => {
      const { key, counter, body } = lights.current;
      const az = azimuth.value, el = elevation.value;
      key?.setAttribute("azimuth", az.toFixed(1));
      key?.setAttribute("elevation", (26 + el).toFixed(1));
      counter?.setAttribute("azimuth", (az + 180).toFixed(1));
      body?.setAttribute("azimuth", az.toFixed(1));
    };
    const frame = (now: number) => {
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const a = azimuth.step(dt), b = elevation.step(dt);
      paint();
      raf = a || b ? requestAnimationFrame(frame) : 0;
      if (!raf) last = 0;
    };
    const move = (event: PointerEvent) => {
      const x = event.clientX / Math.max(1, innerWidth) - .5, y = event.clientY / Math.max(1, innerHeight) - .5;
      azimuth.target = LIGHT_AZIMUTH + x * 2 * LIGHT_SWING;
      elevation.target = -y * 14;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => { removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, []);

  // ---- 排版测量 ----
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      if (!box.width) return;
      const cs = getComputedStyle(root);
      const size = parseFloat(cs.fontSize);
      const font = cs.fontFamily, weight = cs.fontWeight, spacing = cs.letterSpacing;
      // 基线：行内框的顶部 + 字体的 ascent（与浏览器排版使用同一字体度量）
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${weight} ${size}px ${font}`;
      const ascent = ctx.measureText("照Mg").fontBoundingBoxAscent || size * .88;
      // 用户坐标以元素的边框盒为原点；transform 缩放时按比例换回布局尺寸
      const scale = box.width / root.offsetWidth || 1;
      const measured = lineRefs.current.slice(0, shown.lines.length).map((el, i) => {
        const r = el!.getBoundingClientRect();
        return { text: shown.lines[i], x: (r.left - box.left) / scale, y: (r.top - box.top) / scale + ascent };
      });
      setLayout({ w: root.offsetWidth, h: root.offsetHeight, font, size, spacing, weight, lines: measured });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [shown]);

  const text = (fill: string) => layout?.lines.map((l, i) => <text key={i} x={l.x} y={l.y} fill={fill}
    style={{ fontFamily: layout.font, fontSize: layout.size, fontWeight: layout.weight as CSSProperties["fontWeight"], letterSpacing: layout.spacing, whiteSpace: "pre" }}>{l.text}</text>);
  // 滤镜里的字形高度场：白字黑底的 SVG，作为 feImage 引入
  const shape = layout ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.w}" height="${layout.h}"><rect width="100%" height="100%" fill="black"/>` +
    layout.lines.map(l => `<text x="${l.x}" y="${l.y}" fill="white" style="font-family:${layout.font.replace(/"/g, "'")};font-size:${layout.size}px;font-weight:${layout.weight};letter-spacing:${layout.spacing};white-space:pre">${escapeXml(l.text)}</text>`).join("") + "</svg>") : "";
  const blur = layout ? Math.max(3, layout.size * .06) : 4;
  const bevel = layout ? Math.max(1.5, layout.size * .028) : 2;
  const displace = layout ? -Math.round(layout.size * .9) : -60;
  // 色散：边缘处位移约 12–18px，蓝通道多走约 7%，与红通道相差约 1px
  const dispersion = [1, 1.035, 1.07];
  // 背景越亮，玻璃提亮越少；很亮的背景（白天的城市、阳光下的海）上变成略带烟色的玻璃，字形才从背景里分出来
  const dim = Math.max(0, Math.min(1, (luma - .12) / .3));
  const lift = (1.4 - dim * .55).toFixed(2);
  const frost = (blur * .28).toFixed(1);
  const backdrop = refract
    ? `url(#gt-r-${id}) blur(calc(${frost}px + var(--gt-b) * 1px)) saturate(1.55) brightness(${lift})`
    : `blur(calc(6px + var(--gt-b) * 1px)) saturate(1.6) brightness(${lift})`;
  const glyphs = shown.lines.map((line, i) => <span key={i}>{line}{i < shown.lines.length - 1 && <br />}</span>);

  return <h1 ref={rootRef} className={`gt ${className || ""}`} style={style} lang={shown.lang} data-refract={refract || undefined}
    aria-label={label || shown.lines.join(" ")}>
    {layout && <span ref={glassRef} className="gt-glass" aria-hidden="true" style={{ clipPath: `url(#gt-c-${id})`, WebkitBackdropFilter: backdrop, backdropFilter: backdrop } as CSSProperties} />}
    {layout && <span className="gt-layer gt-shadow" aria-hidden="true" style={{ filter: `url(#gt-sh-${id}) blur(calc(var(--gt-b) * 1px))` }}>{glyphs}</span>}
    {layout && <span className="gt-layer gt-bevel hi" aria-hidden="true" style={{ filter: `url(#gt-hi-${id}) blur(calc(var(--gt-b) * 1px))` }}>{glyphs}</span>}
    {layout && <span className="gt-layer gt-bevel lo" aria-hidden="true" style={{ filter: `url(#gt-lo-${id}) blur(calc(var(--gt-b) * 1px))` }}>{glyphs}</span>}
    <span className="gt-rim" aria-hidden="true">{shown.lines.map((line, i) => <span key={i}><span ref={el => { lineRefs.current[i] = el; }}>{line}</span>{i < shown.lines.length - 1 && <br />}</span>)}</span>
    {layout && <svg className="gt-defs" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`gt-c-${id}`} clipPathUnits="userSpaceOnUse">{text("#000")}</clipPath>
        <filter id={`gt-r-${id}`} x="0" y="0" width={layout.w} height={layout.h} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feImage href={shape} x="0" y="0" width={layout.w} height={layout.h} preserveAspectRatio="none" result="shape" />
          <feGaussianBlur in="shape" stdDeviation={blur} result="height" />
          {/* Sobel 梯度，0.5 为零点 */}
          <feConvolveMatrix in="height" order="3" kernelMatrix="-1 0 1 -2 0 2 -1 0 1" divisor="1" bias="0.5" edgeMode="duplicate" preserveAlpha="true" result="dx" />
          <feConvolveMatrix in="height" order="3" kernelMatrix="-1 -2 -1 0 0 0 1 2 1" divisor="1" bias="0.5" edgeMode="duplicate" preserveAlpha="true" result="dy" />
          <feColorMatrix in="dx" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="rx" />
          <feColorMatrix in="dy" type="matrix" values="0 0 0 0 0  1 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="gy" />
          <feComposite in="rx" in2="gy" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="normal" />
          {/* 三个通道各折射一次，位移量略有差别，边缘出现不超过约 1px 的色散 */}
          {dispersion.map((k, i) => <feDisplacementMap key={i} in="SourceGraphic" in2="normal" scale={Math.round(displace * k)} xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />)}
          <feColorMatrix in="d0" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cr" />
          <feColorMatrix in="d1" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 0" result="cg" />
          <feColorMatrix in="d2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 0" result="cb" />
          <feComposite in="cr" in2="cg" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="crg" />
          <feComposite in="crg" in2="cb" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" />
        </filter>
        {/* 接触投影：0 10 30 的柔和阴影，只保留字形外面的部分 */}
        <filter id={`gt-sh-${id}`} x="-10%" y="-10%" width="120%" height="140%" colorInterpolationFilters="sRGB">
          <feOffset in="SourceAlpha" dy={Math.max(3, layout.size * .07)} result="o" />
          <feGaussianBlur in="o" stdDeviation={Math.max(4, layout.size * .11)} result="b" />
          <feComposite in="b" in2="SourceAlpha" operator="out" result="outside" />
          <feColorMatrix in="outside" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .22 0" />
        </filter>
        {/* 高光：斜面上的镜面反射 + 1px 边缘光（左上主光、右下更淡的反向光），只留在字形内部 */}
        <filter id={`gt-hi-${id}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation={bevel} result="h" />
          <feSpecularLighting in="h" surfaceScale={bevel * 1.2} specularConstant=".85" specularExponent="22" lightingColor="#ffffff" result="spec">
            <feDistantLight ref={el => { lights.current.body = el; }} azimuth={LIGHT_AZIMUTH} elevation="38" />
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceAlpha" operator="in" result="lit" />
          {/* 1px 的边缘带：字形减去向内收缩 1px 的字形 */}
          <feMorphology in="SourceAlpha" operator="erode" radius="1" result="inner" />
          <feComposite in="SourceAlpha" in2="inner" operator="out" result="band" />
          <feGaussianBlur in="SourceAlpha" stdDeviation=".9" result="edge" />
          <feSpecularLighting in="edge" surfaceScale="3" specularConstant="1.6" specularExponent="6" lightingColor="#ffffff" result="keyLit">
            <feDistantLight ref={el => { lights.current.key = el; }} azimuth={LIGHT_AZIMUTH} elevation="26" />
          </feSpecularLighting>
          <feSpecularLighting in="edge" surfaceScale="3" specularConstant=".55" specularExponent="6" lightingColor="#ffffff" result="counterLit">
            <feDistantLight ref={el => { lights.current.counter = el; }} azimuth={LIGHT_AZIMUTH + 180} elevation="26" />
          </feSpecularLighting>
          <feComposite in="keyLit" in2="band" operator="in" result="keyRim" />
          <feComposite in="counterLit" in2="band" operator="in" result="counterRim" />
          <feMerge>
            <feMergeNode in="lit" />
            <feMergeNode in="keyRim" />
            <feMergeNode in="counterRim" />
          </feMerge>
        </filter>
        {/* 暗面：漫反射，背光斜面压暗一点并带上场景色调，给字身体积 */}
        <filter id={`gt-lo-${id}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation={bevel} result="h" />
          <feDiffuseLighting ref={shadeRef} in="h" surfaceScale={bevel * 1.2} diffuseConstant="1" lightingColor="#ffffff" result="diff">
            <feDistantLight azimuth={LIGHT_AZIMUTH} elevation="50" />
          </feDiffuseLighting>
          <feComponentTransfer in="diff" result="shade"><feFuncR type="linear" slope=".5" intercept=".5" /><feFuncG type="linear" slope=".5" intercept=".5" /><feFuncB type="linear" slope=".5" intercept=".5" /></feComponentTransfer>
          <feComposite in="shade" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
    </svg>}
  </h1>;
}

type RGB = [number, number, number];
function hexRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function CSS_supports(property: string, value: string) {
  try { return CSS.supports(property, value); } catch { return false; }
}
function escapeXml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}
