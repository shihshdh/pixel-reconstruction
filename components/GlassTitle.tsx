"use client";
// 液态玻璃标题：每个字都是一块玻璃，折射并虚化它后面的画面（展示页的 3D 场景）。
//
// 做法：一层覆盖标题的元素加 backdrop-filter，用 SVG clipPath 裁成与标题完全相同的字形。
// 滤镜里把字形模糊成高度场，Sobel 求出 x/y 梯度写进 R/G 通道，再用 feDisplacementMap
// 按梯度位移背后的画面——字形边缘像透镜一样弯折背景，中间基本不动，这就是玻璃的折射。
// 之上再叠磨砂模糊、提亮与饱和，最后由真实文字层画出边缘高光与投影。
//
// 字形位置按真实排版逐行测量（字体、字号、字距一致），窗口或字体变化时重新测量。
// SVG 滤镜用于 backdrop-filter 目前只有 Chromium 支持（Windows 客户端的 WebView2 即是）；
// 其他浏览器退回普通磨砂玻璃，文字照常可读。
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

type Line = { text: string; x: number; y: number };

const STYLE = `
.gt{position:relative;display:inline-block;}
/* 表面层：只画玻璃的边缘高光与上沿反光，字形内部保持透明，让下面的玻璃层透出来。
   不加深色投影——半透明字形会把投影透出来，玻璃就“脏”了。 */
.gt-rim{position:relative;z-index:1;display:block;color:transparent;text-shadow:none;
  -webkit-text-stroke:.8px rgba(255,255,255,.7);
  background:linear-gradient(174deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.08) 30%,rgba(255,255,255,0) 52%,rgba(255,255,255,.18) 100%);
  -webkit-background-clip:text;background-clip:text;}
.gt-rim>span{display:inline;}
.gt-glass{position:absolute;inset:0;pointer-events:none;z-index:0;background:rgba(255,255,255,.1);}
/* 斜面光照：字形模糊成高度场，按左上方的光源打光——朝光的斜面发亮、背光的斜面变暗，
   这就是 iPhone 锁屏数字那种“有厚度的玻璃”的立体感 */
.gt-bevel{position:absolute;inset:0;z-index:1;pointer-events:none;display:block;color:#fff;}
.gt-bevel.hi{mix-blend-mode:screen;}
.gt-bevel.lo{mix-blend-mode:multiply;}
.gt-defs{position:absolute;width:0;height:0;overflow:hidden;}
`;
let injected = false;

export default function GlassTitle({ lines, className, style, label }: { lines: string[]; className?: string; style?: CSSProperties; label?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<HTMLHeadingElement>(null);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [layout, setLayout] = useState<{ w: number; h: number; font: string; size: number; spacing: string; weight: string; lines: Line[] } | null>(null);
  const [refract, setRefract] = useState(false);

  useLayoutEffect(() => {
    if (!injected) { injected = true; const s = document.createElement("style"); s.textContent = STYLE; document.head.appendChild(s); }
    // 只有支持 SVG 滤镜作 backdrop-filter 的内核才开折射
    setRefract(/Chrome|Edg\//.test(navigator.userAgent) && CSS_supports("backdrop-filter", "url(#x)"));
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
      const measured = lineRefs.current.map((el, i) => {
        const r = el!.getBoundingClientRect();
        return { text: lines[i], x: (r.left - box.left) / scale, y: (r.top - box.top) / scale + ascent };
      });
      setLayout({ w: root.offsetWidth, h: root.offsetHeight, font, size, spacing, weight, lines: measured });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [lines]);

  const text = (fill: string) => layout?.lines.map((l, i) => <text key={i} x={l.x} y={l.y} fill={fill}
    style={{ fontFamily: layout.font, fontSize: layout.size, fontWeight: layout.weight as CSSProperties["fontWeight"], letterSpacing: layout.spacing, whiteSpace: "pre" }}>{l.text}</text>);
  // 滤镜里的字形高度场：白字黑底的 SVG，作为 feImage 引入
  const shape = layout ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.w}" height="${layout.h}"><rect width="100%" height="100%" fill="black"/>` +
    layout.lines.map(l => `<text x="${l.x}" y="${l.y}" fill="white" style="font-family:${layout.font.replace(/"/g, "'")};font-size:${layout.size}px;font-weight:${layout.weight};letter-spacing:${layout.spacing};white-space:pre">${escapeXml(l.text)}</text>`).join("") + "</svg>") : "";
  const blur = layout ? Math.max(3, layout.size * .06) : 4;
  const bevel = layout ? Math.max(1.5, layout.size * .028) : 2;
  const backdrop = refract
    ? `url(#gt-r-${id}) blur(${(blur * .28).toFixed(1)}px) saturate(1.6) brightness(1.38)`
    : "blur(6px) saturate(1.6) brightness(1.35)";

  return <h1 ref={rootRef} className={`gt ${className || ""}`} style={style} aria-label={label || lines.join("")}>
    {layout && <span className="gt-glass" aria-hidden="true" style={{ clipPath: `url(#gt-c-${id})`, WebkitBackdropFilter: backdrop, backdropFilter: backdrop } as CSSProperties} />}
    {layout && <span className="gt-bevel hi" aria-hidden="true" style={{ filter: `url(#gt-hi-${id})` }}>{lines.map((line, i) => <span key={i}>{line}{i < lines.length - 1 && <br />}</span>)}</span>}
    {layout && <span className="gt-bevel lo" aria-hidden="true" style={{ filter: `url(#gt-lo-${id})` }}>{lines.map((line, i) => <span key={i}>{line}{i < lines.length - 1 && <br />}</span>)}</span>}
    <span className="gt-rim" aria-hidden="true">{lines.map((line, i) => <span key={i}><span ref={el => { lineRefs.current[i] = el; }}>{line}</span>{i < lines.length - 1 && <br />}</span>)}</span>
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
          <feDisplacementMap in="SourceGraphic" in2="normal" scale={-(layout.size * .9).toFixed(0)} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* 高光：镜面反射，只留在字形内部 */}
        <filter id={`gt-hi-${id}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation={bevel} result="h" />
          <feSpecularLighting in="h" surfaceScale={bevel * 1.2} specularConstant="1.1" specularExponent="22" lightingColor="#ffffff" result="spec">
            <feDistantLight azimuth="235" elevation="38" />
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceAlpha" operator="in" result="lit" />
          <feComponentTransfer in="lit"><feFuncA type="linear" slope=".95" /></feComponentTransfer>
        </filter>
        {/* 暗面：漫反射，背光斜面压暗一点，给字身体积 */}
        <filter id={`gt-lo-${id}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation={bevel} result="h" />
          <feDiffuseLighting in="h" surfaceScale={bevel * 1.2} diffuseConstant="1" lightingColor="#ffffff" result="diff">
            <feDistantLight azimuth="235" elevation="50" />
          </feDiffuseLighting>
          <feComponentTransfer in="diff" result="shade"><feFuncR type="linear" slope=".55" intercept=".45" /><feFuncG type="linear" slope=".55" intercept=".45" /><feFuncB type="linear" slope=".6" intercept=".42" /></feComponentTransfer>
          <feComposite in="shade" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
    </svg>}
  </h1>;
}

function CSS_supports(property: string, value: string) {
  try { return CSS.supports(property, value); } catch { return false; }
}
function escapeXml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}
