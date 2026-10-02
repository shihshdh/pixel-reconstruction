'use client';

// 作品库的“光盘架”：每件作品印成一张光盘，沿一条从左下到右上的弧排开，
// 滚轮、拖动或方向键让光盘依次转到画面中央，左上角的片名表跟着换。
// 只有一个进度 p 驱动全部光盘：第 i 张的偏移 d = i - p 决定它在弧上的位置、大小、倾角和自转，
// 所以只需在 rAF 里用弹簧把 p 推向目标，再把变换直接写进 style，不触发 React 重渲染。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReduced } from "@/lib/motion";
import styles from "./DiscShelf.module.css";

type DiscItem = { id: string; title: string; date: string; meta: string; fav: boolean };

type Props<T extends DiscItem> = {
  items: T[];
  renderThumb: (item: T) => ReactNode;
  status: (item: T) => string;
  onOpen: (item: T) => void;
  onToggleFav: (item: T) => void;
  opening?: string;
};

// 只挂载中央附近的光盘：缩略图从 IndexedDB 读，离得远的不必占内存
const WINDOW = 4;

export default function DiscShelf<T extends DiscItem>({ items, renderThumb, status, onOpen, onToggleFav, opening = "" }: Props<T>) {
  const n = items.length;
  const stageRef = useRef<HTMLDivElement>(null);
  const discRefs = useRef(new Map<number, HTMLButtonElement>());
  const motion = useRef({ p: 0, v: 0, target: 0, spin: 0, last: 0 });
  const [current, setCurrent] = useState(0);
  const [visible, setVisible] = useState<[number, number]>([0, Math.min(n - 1, WINDOW)]);
  const reduced = useRef(false);

  const go = useCallback((index: number) => {
    const target = Math.max(0, Math.min(n - 1, index));
    motion.current.target = target;
    setCurrent(Math.round(target));
  }, [n]);

  // 首次出现时光盘从右侧沿弧线依次滑入（A24 的入场）：把 p 放在 -3，让弹簧把它带回 0
  useEffect(() => {
    reduced.current = prefersReduced();
    const m = motion.current;
    m.p = reduced.current ? 0 : -3.2; m.v = 0; m.target = 0;
  }, []);
  // 列表变短（删除、切换筛选）时把当前位置收回范围内
  useEffect(() => { if (motion.current.target > n - 1) go(n - 1); }, [n, go]);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const m = motion.current;
      const dt = Math.min(0.05, m.last ? (now - m.last) / 1000 : 0.016); m.last = now;
      if (reduced.current) { m.p = m.target; m.v = 0; }
      else {
        // 临界阻尼附近的弹簧：快速到位、略带一点过冲
        const k = 70, c = 15;
        m.v += ((m.target - m.p) * k - m.v * c) * dt;
        m.p += m.v * dt;
        m.spin += dt * 9 + m.v * dt * 60;
      }
      const stage = stageRef.current;
      if (stage) {
        const w = stage.clientWidth, h = stage.clientHeight;
        const unit = Math.min(w / 1100, h / 520);
        const size = 300 * unit;
        discRefs.current.forEach((el, i) => {
          const d = i - m.p, a = Math.abs(d);
          // 弧线：右边更高、更近、更大，左边沉下去变小
          const x = w * .5 + d * 250 * unit;
          const y = h * .5 - d * 54 * unit + d * d * 5 * unit;
          const scale = Math.max(.42, Math.min(1.5, 1 + d * .15 - a * .03));
          // 中央那张更正（倾角小），越往两侧越斜
          const tilt = 34 + Math.min(a, 1.6) * 12;
          const spin = reduced.current ? -d * 40 : m.spin * (1 + i % 3 * .15) - d * 40;
          const fade = a > 3.2 ? Math.max(0, 1 - (a - 3.2) / .8) : 1;
          el.style.width = el.style.height = size + "px";
          el.style.transform = `translate3d(${x - size / 2}px,${y - size / 2}px,0) scale(${scale}) perspective(${900 * unit}px) rotateZ(-24deg) rotateX(${tilt}deg) rotateZ(${spin}deg)`;
          el.style.opacity = String(fade);
          el.style.zIndex = String(200 - Math.round(a * 20) + (d > 0 ? 6 : 0));
          el.style.setProperty("--lift", d === 0 ? "1" : String(Math.max(0, 1 - a)));
        });
      }
      const lo = Math.max(0, Math.floor(m.p) - WINDOW), hi = Math.min(n - 1, Math.ceil(m.p) + WINDOW);
      setVisible(prev => prev[0] === lo && prev[1] === hi ? prev : [lo, hi]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n]);

  // 滚轮：滑动时跟手，停下 140ms 后吸附到最近一张。到头再往外滚就把滚动还给页面
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let snap = 0;
    const wheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const m = motion.current;
      if ((delta < 0 && m.target <= 0) || (delta > 0 && m.target >= n - 1)) return;
      event.preventDefault();
      m.target = Math.max(0, Math.min(n - 1, m.target + delta / 340));
      clearTimeout(snap);
      snap = window.setTimeout(() => go(Math.round(motion.current.target)), 140);
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => { stage.removeEventListener("wheel", wheel); clearTimeout(snap); };
  }, [n, go]);

  // 拖动：横向拖一张光盘的距离换一张；位移很小时当作点击
  const drag = useRef({ id: -1, x: 0, start: 0, moved: false });
  const down = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, start: motion.current.target, moved: false };
  };
  const move = (event: React.PointerEvent) => {
    const g = drag.current;
    if (g.id !== event.pointerId) return;
    const dx = event.clientX - g.x;
    if (!g.moved && Math.abs(dx) > 6) { g.moved = true; stageRef.current?.setPointerCapture(event.pointerId); }
    if (g.moved) motion.current.target = Math.max(-.4, Math.min(n - .6, g.start - dx / 230));
  };
  const up = (event: React.PointerEvent) => {
    const g = drag.current;
    if (g.id !== event.pointerId) return;
    drag.current.id = -1;
    if (g.moved) go(Math.round(motion.current.target));
  };
  const clickDisc = (index: number) => {
    if (drag.current.moved) { drag.current.moved = false; return; }
    if (index === current) onOpen(items[index]); else go(index);
  };
  // 左右方向键在整个作品库页都能翻，不必先把焦点放到光盘上；正在输入文字时不抢按键。
  // 以弹簧的目标值为基准，按住不放时连续翻页也不会因为动画还没到位而跳回
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest("[role=dialog]"))) return;
      event.preventDefault();
      go(Math.round(motion.current.target) + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [go]);
  const key = (event: React.KeyboardEvent) => {
    if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(n - 1); }
  };

  const item = items[current];
  if (!item) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const discs: ReactNode[] = [];
  for (let i = visible[0]; i <= visible[1]; i++) {
    const disc = items[i];
    discs.push(<button key={disc.id} type="button" className={styles.disc} tabIndex={-1}
      ref={el => { if (el) discRefs.current.set(i, el); else discRefs.current.delete(i); }}
      aria-label={i === current ? "打开" + disc.title : "转到" + disc.title} onClick={() => clickDisc(i)}>
      <span className={styles.face}>{renderThumb(disc)}</span>
      <span className={styles.sheen} aria-hidden="true" />
      <span className={styles.hub} aria-hidden="true" />
    </button>);
  }

  return <section className={styles.shelf} aria-roledescription="轮播" aria-label="作品光盘架">
    <div key={item.id} className={styles.sheet} aria-live="polite">
      <h2 className={styles.title}>{item.title}</h2>
      <dl className={styles.facts}>
        <div><dt>日期</dt><dd>{item.date}</dd></div>
        <div><dt>规格</dt><dd>{item.meta || "—"}</dd></div>
        <div><dt>保存</dt><dd>{status(item)}</dd></div>
      </dl>
    </div>
    <div ref={stageRef} className={styles.stage} tabIndex={0} onKeyDown={key}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      aria-label="左右方向键切换作品，点击中央光盘打开">
      {discs}
    </div>
    <div className={styles.footer}>
      <div className={styles.actions}>
        <button type="button" className={styles.open} disabled={!!opening} onClick={() => onOpen(item)}>{opening === item.id ? "正在打开…" : "打开场景"} <span aria-hidden="true">↗</span></button>
        <button type="button" className={styles.fav} aria-pressed={item.fav} onClick={() => onToggleFav(item)}>{item.fav ? "★ 已收藏" : "☆ 收藏"}</button>
      </div>
      <p className={styles.hint}>滚动、拖动或用方向键翻阅</p>
      <p className={styles.counter} aria-label={`第 ${current + 1} 件，共 ${n} 件`}><strong>{pad(current + 1)}</strong><span>/ {pad(n)}</span></p>
    </div>
  </section>;
}
