// ============================================================
// 动效地基 —— 时长 / 缓动 / 降级，全站共用一套
// ============================================================
// 规矩（参考 impeccable 的 animate 规范）：
//   · 动效必须有职责：确认操作 / 说清状态 / 保持连续性 / 引导注意 / 体现气质
//   · 只动 transform 和 opacity，绝不动 width/height/top/left/margin
//   · 缓动只用自然减速，不用回弹
//   · prefers-reduced-motion 是"去掉位移"，不是"关掉一切"
// ============================================================

import { useLayoutEffect, useRef } from "react";

/** 自然减速：所有"到位"的动作都用它 */
export const EASE = "cubic-bezier(.16,1,.3,1)";
/** 进入视口/淡出用的对称缓动 */
export const EASE_SOFT = "cubic-bezier(.4,0,.2,1)";

/** 时长分级（毫秒） */
export const D = {
  /** 即时反馈：按下、hover */
  fb: 120,
  /** 常规状态变化 */
  state: 220,
  /** 布局、遮罩、视图切换 */
  layout: 380,
  /** 刻意设计的主角入场 */
  hero: 640,
} as const;

/** 用户是否要求减少动效 */
export function prefersReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * FLIP 列表：容器内子元素位置变化时平滑滑移，新增的元素缩放淡入。
 * 用法：给容器 ref，给每个子元素 data-flip="唯一key"。
 * 只动 transform，不碰布局属性。
 * stagger：让位/新增的元素按先后依次错开（毫秒）。
 * frameRef：外框高度随内容变化时一起过渡（收缩等补位基本走完再收，增长立即跟上）。
 * 外框只有一个元素，过渡它的 height 代价很小，是这里对“只动 transform”的唯一例外。
 */
export function useFlipList(
  containerRef: { current: HTMLElement | null },
  dep: unknown,
  { stagger = 0, frameRef }: { stagger?: number; frameRef?: { current: HTMLElement | null } } = {}
) {
  const prev = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevHeight = useRef(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 相对容器、换算回未缩放的本地坐标：两次变化之间页面滚动过、或祖先被平移缩放过，
    // 记下的旧位置依然有效（用视口坐标会让整列从错误的位置飞回来）
    const box = el.getBoundingClientRect();
    const scale = el.offsetWidth ? box.width / el.offsetWidth || 1 : 1;
    const next = new Map<string, { x: number; y: number }>();
    const kids = Array.from(el.children) as HTMLElement[];
    kids.forEach((c) => {
      const k = c.dataset.flip;
      if (!k) return;
      const r = c.getBoundingClientRect();
      next.set(k, { x: (r.left - box.left) / scale, y: (r.top - box.top) / scale });
    });
    const frame = frameRef?.current;
    const height = frame?.offsetHeight ?? 0;
    const wasHeight = prevHeight.current;
    prevHeight.current = height;

    if (prefersReduced() || typeof el.animate !== "function") {
      prev.current = next;
      return;
    }

    let order = 0;
    kids.forEach((c) => {
      const k = c.dataset.flip;
      if (!k) return;
      const now = next.get(k);
      const was = prev.current.get(k);
      if (!now) return;

      if (was) {
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          // 让位：老位置 → 新位置
          c.animate(
            [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }],
            { duration: D.state + 40, easing: EASE, delay: order++ * stagger, fill: "backwards" }
          );
        }
      } else if (prev.current.size > 0) {
        // 新来的：缩放淡入（首次渲染整列不做，避免开页面就一堆动画）
        c.animate(
          [
            { transform: "scale(.82)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration: D.state + 40, easing: EASE, delay: order++ * stagger, fill: "backwards" }
        );
      }
    });

    if (frame && wasHeight && Math.abs(wasHeight - height) > 0.5) {
      const shrinking = height < wasHeight;
      frame.animate(
        [{ height: `${wasHeight}px` }, { height: `${height}px` }],
        { duration: D.layout, easing: EASE, delay: shrinking ? Math.min(order * stagger, 200) + 80 : 0, fill: "backwards" }
      );
    }

    prev.current = next;
  }, [containerRef, dep, stagger, frameRef]);
}

// ------------------------------------------------------------
// 弹簧：图标形变与按压回弹共用一套物理参数
// ζ = c / (2√k) ≈ 0.87：几乎不过冲，落点干净，不是"回弹"
// ------------------------------------------------------------
export const SPRING = { stiffness: 260, damping: 28 } as const;

/**
 * 把同一组弹簧参数采样成 CSS linear() 缓动，让 WAAPI / CSS 动画也走同一条曲线。
 * 返回 { easing, duration }；浏览器不支持 linear() 时回落到 EASE。
 */
export function springEasing(stiffness: number = SPRING.stiffness, damping: number = SPRING.damping) {
  let x = 0, v = 0, t = 0;
  const dt = 1 / 240;
  const points: number[] = [0];
  // Integrate until settled (|1−x| < 0.001 and |v| < 0.02, the same rule Morphicons uses).
  while (t < 2) {
    for (let i = 0; i < 4; i++) { const a = stiffness * (1 - x) - damping * v; v += a * dt; x += v * dt; t += dt; }
    points.push(+x.toFixed(4));
    if (Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.02) break;
  }
  points[points.length - 1] = 1;
  const duration = Math.round(t * 1000);
  const supported = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timing-function", "linear(0, 1)");
  // Thin the samples: keep every other point, which stays well under a pixel of error at UI sizes.
  const easing = supported ? `linear(${points.filter((_, i) => i % 2 === 0 || i === points.length - 1).join(",")})` : EASE;
  return { easing, duration };
}

/**
 * 按压反馈：root 内所有按钮与链接，按下时在 `scale` 属性上轻压，松开后按弹簧回位。
 * 用独立的 `scale` 属性而不是 transform，所以悬停上浮等已有变换照常叠加；
 * 快速轻点也一定能看见完整的"按下—回弹"。减少动效时不安装。返回卸载函数。
 */
export function installPressFeedback(root: HTMLElement) {
  if (prefersReduced() || typeof root.animate !== "function") return () => {};
  const { easing, duration } = springEasing();
  const SELECTOR = 'button:not(:disabled), a[href], [role="button"]:not([aria-disabled="true"])';
  const running = new Map<HTMLElement, Animation>();
  // Small targets dip more, large surfaces barely: the same felt pressure at every size.
  const depth = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    return size < 48 ? 0.9 : size < 160 ? 0.95 : size < 360 ? 0.975 : 0.99;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const el = (event.target as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
    if (!el || !root.contains(el) || el.closest("[data-no-press]")) return;
    running.get(el)?.cancel();
    const press = el.animate([{ scale: "1" }, { scale: String(depth(el)) }], { duration: D.fb, easing: EASE, fill: "forwards" });
    running.set(el, press);
    const up = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      const from = getComputedStyle(el).scale;
      press.cancel();
      const back = el.animate([{ scale: !from || from === "none" ? "1" : from }, { scale: "1" }], { duration, easing });
      running.set(el, back);
      back.finished.then(() => { if (running.get(el) === back) running.delete(el); }, () => {});
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  };
  root.addEventListener("pointerdown", down, { passive: true });
  root.setAttribute("data-press", "");
  return () => {
    root.removeEventListener("pointerdown", down);
    root.removeAttribute("data-press");
    running.forEach(animation => animation.cancel());
    running.clear();
  };
}

/**
 * 视差滚动：root 内带 data-parallax="速度" 的元素，随页面滚动以不同速度移动。
 * 正值更"远"（比页面慢），负值更"近"。元素在它的阅读位置（中心到达视口中心；
 * 首屏元素则是页面顶端）时偏移为 0，所以静止时的排版与设计稿完全一致。
 * 只写独立的 `translate` 属性，和入场动画、悬停变换互不干扰；减少动效时不启用。
 */
export function useParallax(rootRef: { current: HTMLElement | null }, active: boolean, limit = 56) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !active || prefersReduced()) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-parallax]")).map(el => ({ el, speed: parseFloat(el.dataset.parallax || "0") || 0, y: 0 }));
    if (!items.length) return;
    root.setAttribute("data-parallax-on", "");
    let frame = 0;
    const update = () => {
      frame = 0;
      const vh = window.innerHeight, scroll = window.scrollY;
      // Read everything first, then write, so one frame never forces layout twice.
      const next = items.map(item => {
        const r = item.el.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) return item.y;
        const docCenter = r.top - item.y + scroll + r.height / 2;
        const rest = Math.max(0, docCenter - vh / 2);
        return Math.max(-limit, Math.min(limit, (scroll - rest) * item.speed));
      });
      next.forEach((y, i) => {
        const item = items[i];
        if (Math.abs(y - item.y) < 0.1) return;
        item.y = y;
        item.el.style.translate = `0 ${y.toFixed(1)}px`;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      root.removeAttribute("data-parallax-on");
      items.forEach(item => { item.el.style.translate = ""; });
    };
  }, [rootRef, active, limit]);
}
