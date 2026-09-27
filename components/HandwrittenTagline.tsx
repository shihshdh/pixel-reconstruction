"use client";
// 手写诗句：一笔一划写出来，像 iPhone 开机的 hello / 你好。
//
// 笔画数据由 scripts/prepare-handwriting.py 生成（lib/handwriting.generated.json）：拉丁文字是单线手写体的
// 中心线，汉字是真实笔顺的中线，日文是 KanjiVG 的笔画；都按书写顺序排好。这里把每一笔画成圆头单线，
// 用 stroke-dashoffset 从头描到尾。笔速恒定（每笔用时与长度成正比），笔画之间短暂提笔，单词 / 字之间停得稍长。
//
// 流畅度：
// - 光晕不用 CSS 滤镜（每帧重绘都要重新模糊），而是每笔下面垫一条更宽、半透明的同色调线，一起描出来；
// - 3D 场景载入（解析、排序）会占主线程，笔画动画在主线程上跑，所以等场景就绪（hold 为 false）再写；
// - 写完后把最终状态写进样式并释放全部动画，之后不再有逐帧开销。
//
// 换场景时与液态玻璃标题同一套节奏：旧诗句 120ms 模糊退出，新诗句在标题落定、场景就绪后开始书写。
// 页面开场动画播放期间不写。减少动态效果时直接显示整句。
import { useEffect, useRef, useState, type CSSProperties } from "react";

export type Handwriting = {
  lang: string; text: string; source: string;
  w: number; h: number; weight: number;
  strokes: { d: string; len: number; gap: "word" | "stroke" }[];
};

const EXIT_MS = 120;
const PAD = 8;
const MAX_MS = 3400;

/** 每一笔的开始时间与时长（毫秒）。先按恒定笔速排，整句超过 3.4 秒就整体等比加快（提笔停顿一起缩短）。 */
function schedule(data: Handwriting) {
  const cjk = data.lang.startsWith("zh") || data.lang === "ja";
  const lift = cjk ? 26 : 30, pause = cjk ? 70 : 100;
  const speed = cjk ? .9 : 1.25;   // 每毫秒走过的单位长度（字高为 100）
  let t = 0;
  const plan = data.strokes.map((s, i) => {
    if (i > 0) t += s.gap === "word" ? pause : lift;
    const duration = Math.max(cjk ? 80 : 55, s.len / speed);
    const at = t;
    t += duration;
    return { at, duration };
  });
  const k = Math.min(1, MAX_MS / t);
  return plan.map(({ at, duration }) => ({ at: at * k, duration: duration * k }));
}

type Shown = { data: Handwriting; ink: string; halo: string };

export default function HandwrittenTagline({ data, ink, halo, hold = false, delay = 0, className, style }: {
  data: Handwriting; ink: string; halo: string; hold?: boolean; delay?: number; className?: string; style?: CSSProperties;
}) {
  const [shown, setShown] = useState<Shown>({ data, ink, halo });
  const [written, setWritten] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const first = useRef(true);
  const holdRef = useRef(hold);
  const release = useRef<(() => void) | null>(null);
  holdRef.current = hold;

  // 换诗句：旧的模糊退出，再换成新的（墨色跟着诗句一起换，退出途中不变色）
  useEffect(() => {
    if (data === shown.data) return;
    const svg = svgRef.current;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!svg || reduced) { setShown({ data, ink, halo }); return; }
    const exit = svg.animate([{ opacity: 1, filter: "blur(0px)", scale: 1 }, { opacity: 0, filter: "blur(6px)", scale: .96 }],
      { duration: EXIT_MS, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    exit.onfinish = () => setShown({ data, ink, halo });
    return () => { exit.onfinish = null; };
  }, [data, shown.data, ink, halo]);

  // 场景就绪：放行等待中的书写
  useEffect(() => { if (!hold) release.current?.(); }, [hold]);

  // 书写
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    setWritten(false);
    svg.getAnimations().forEach(a => a.cancel());
    const strokes = Array.from(svg.querySelectorAll<SVGGElement>("g[data-stroke]"));
    const paths = strokes.map(g => Array.from(g.querySelectorAll("path")));
    const settle = () => paths.flat().forEach(p => { p.style.strokeDashoffset = "0"; p.style.opacity = "1"; });
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { settle(); setWritten(true); return; }
    const plan = schedule(shown.data);
    const start = first.current ? delay + 400 : delay;
    first.current = false;
    let animations: Animation[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const write = () => {
      animations = paths.flatMap((group, i) => group.map(path => path.animate([
        { strokeDashoffset: 1, opacity: 0 },
        { strokeDashoffset: .995, opacity: 1, offset: .02 },
        { strokeDashoffset: 0, opacity: 1 },
      ], { duration: plan[i].duration, delay: plan[i].at, easing: "cubic-bezier(.42,.08,.4,1)", fill: "both" })));
      Promise.all(animations.map(a => a.finished)).then(() => {
        if (cancelled) return;
        // 最终状态写进样式，释放动画
        settle();
        animations.forEach(a => a.cancel());
        setWritten(true);
      }).catch(() => {});
    };
    // 写之前每一笔都藏起来（不然开场前会先闪一下整句）
    paths.flat().forEach(p => { p.style.strokeDashoffset = "1"; p.style.opacity = "0"; });
    // 依次等：页面开场动画结束 → 场景就绪 → 标题落定（delay）
    const html = document.documentElement;
    let watcher: MutationObserver | undefined;
    const afterIntro = () => {
      const go = () => { release.current = null; timer = setTimeout(write, start); };
      if (holdRef.current) release.current = go; else go();
    };
    if (html.getAttribute("data-intro") === "play") {
      watcher = new MutationObserver(() => { if (html.getAttribute("data-intro") !== "play") { watcher?.disconnect(); afterIntro(); } });
      watcher.observe(html, { attributes: true, attributeFilter: ["data-intro"] });
    } else afterIntro();
    return () => { cancelled = true; release.current = null; watcher?.disconnect(); if (timer) clearTimeout(timer); animations.forEach(a => a.cancel()); };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: d, ink: color, halo: glow } = shown;
  return <figure className={className} style={{ margin: 0, ...style }} lang={d.lang}>
    <svg ref={svgRef} role="img" aria-label={d.text.replace(/\n/g, " ")} viewBox={`${-PAD} ${-PAD} ${d.w + PAD * 2} ${d.h + PAD * 2}`}
      style={{ display: "block", width: `calc(${(d.w + PAD * 2) / 100} * var(--hw-size, 44px))`, maxWidth: "100%", height: "auto", overflow: "visible", transformOrigin: "0 50%" }}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {d.strokes.map((s, i) => <g key={`${d.text}-${i}`} data-stroke="">
          {/* 光晕：同一笔的宽线垫在下面，和墨线一起描出来 */}
          <path d={s.d} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} stroke={glow} strokeWidth={d.weight * 3.6} strokeOpacity={.38} />
          <path d={s.d} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} stroke={color} strokeWidth={d.weight} />
        </g>)}
      </g>
    </svg>
    <figcaption style={{ color, opacity: written ? .88 : 0, translate: written ? "0 0" : "0 4px", transition: "opacity .7s ease, translate .7s cubic-bezier(.16,1,.3,1)",
      textShadow: `0 0 2px ${glow}, 0 1px 8px ${glow}` }}>{d.source}</figcaption>
  </figure>;
}
