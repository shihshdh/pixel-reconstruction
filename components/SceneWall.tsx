'use client';

// 首页的“场景墙”：展示页的九个场景排成瀑布流。
// 两个细节来自设计灵感站：其中一格像翻页书一样快切（这里切的是四种运镜的画面），
// 鼠标划过照片时冒出几块像素马赛克和错位条——正好呼应“Pixel”。
import { useEffect, useRef, useState } from "react";
import { LANDING_SCENES } from "@/lib/landing-scenes";
import { prefersReduced } from "@/lib/motion";
import FolderFan from "./FolderFan";
import styles from "./SceneWall.module.css";

// 照片原本都是 16:10，裁成不同比例才排得出错落的瀑布流
const LAYOUT: { id: string; ratio: string; tags: string[] }[] = [
  { id: "victoria", ratio: "4 / 5", tags: ["city", "night"] },
  { id: "flipbook", ratio: "16 / 10", tags: ["city", "coast", "night"] },
  { id: "quote", ratio: "auto", tags: ["city", "coast", "night"] },
  { id: "yozakura", ratio: "3 / 4", tags: ["night"] },
  { id: "louvre", ratio: "1 / 1", tags: ["city"] },
  { id: "kelingking", ratio: "16 / 10", tags: ["coast"] },
  { id: "london", ratio: "4 / 5", tags: ["city", "night"] },
  { id: "nice", ratio: "1 / 1", tags: ["coast", "city"] },
  { id: "seine", ratio: "3 / 4", tags: ["city"] },
  { id: "california", ratio: "16 / 11", tags: ["coast"] },
  { id: "harbor", ratio: "4 / 5", tags: ["night", "coast"] },
];
const FILTERS = [{ id: "all", label: "全部" }, { id: "city", label: "城市" }, { id: "coast", label: "海岸" }, { id: "night", label: "夜晚" }];
// 四段运镜示例各取三帧，按顺序快切
const MOTIONS = ["环绕", "缓推", "弧推", "变焦"];
const FRAMES = Array.from({ length: 12 }, (_, i) => `/scene/wall/motion-${i + 1}.webp`);

type Block = { x: number; y: number; w: number; h: number; born: number; life: number; kind: "mosaic" | "shift"; cell: number; shift: number };

/** 鼠标划过时在照片上画像素故障：马赛克块（先缩小再放大、关掉平滑）和横向错位条 */
function usePixelGlitch(img: React.RefObject<HTMLImageElement | null>, canvas: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const cv = canvas.current, tile = cv?.parentElement;
    if (!cv || !tile || prefersReduced()) return;
    const ctx = cv.getContext("2d");
    const tiny = document.createElement("canvas"), tctx = tiny.getContext("2d");
    if (!ctx || !tctx) return;
    let blocks: Block[] = [], raf = 0, lastSpawn = 0;
    const fit = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(tile.clientWidth * dpr); cv.height = Math.round(tile.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    // 显示坐标 → 原图坐标（object-fit: cover，再叠上悬停时的 1.04 放大）
    const source = (x: number, y: number, w: number, h: number) => {
      const im = img.current!, W = tile.clientWidth, H = tile.clientHeight;
      const zoom = 1.04, s = Math.max(W / im.naturalWidth, H / im.naturalHeight) * zoom;
      const ox = (W - im.naturalWidth * s) / 2, oy = (H - im.naturalHeight * s) / 2;
      return [(x - ox) / s, (y - oy) / s, w / s, h / s] as const;
    };
    const draw = (now: number) => {
      const im = img.current;
      ctx.clearRect(0, 0, tile.clientWidth, tile.clientHeight);
      blocks = blocks.filter(b => now - b.born < b.life);
      if (im?.complete && im.naturalWidth) for (const b of blocks) {
        const t = (now - b.born) / b.life;
        // 前 15% 闪现，最后 35% 断续消失（像信号不稳）
        if (t > .65 && Math.floor(now / 45) % 2) continue;
        ctx.globalAlpha = t < .15 ? t / .15 : 1;
        if (b.kind === "mosaic") {
          const cols = Math.max(1, Math.round(b.w / b.cell)), rows = Math.max(1, Math.round(b.h / b.cell));
          tiny.width = cols; tiny.height = rows;
          tctx.drawImage(im, ...source(b.x, b.y, b.w, b.h), 0, 0, cols, rows);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tiny, b.x, b.y, b.w, b.h);
        } else {
          // 错位条：把旁边一段画面横移过来，再叠一层偏青的色差
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(im, ...source(b.x - b.shift, b.y, b.w, b.h), b.x, b.y, b.w, b.h);
          ctx.globalCompositeOperation = "screen"; ctx.fillStyle = "rgba(60,200,255,.16)";
          ctx.fillRect(b.x + 3, b.y, b.w, b.h); ctx.globalCompositeOperation = "source-over";
        }
      }
      ctx.globalAlpha = 1;
      raf = blocks.length ? requestAnimationFrame(draw) : 0;
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const now = performance.now();
      if (now - lastSpawn < 55 || blocks.length > 20) return;
      lastSpawn = now;
      const r = tile.getBoundingClientRect(), cx = event.clientX - r.left, cy = event.clientY - r.top;
      for (let k = 0; k < 3; k++) {
        const kind = Math.random() < .62 ? "mosaic" : "shift";
        const w = kind === "mosaic" ? 12 + Math.random() * 30 : 34 + Math.random() * 80;
        const h = kind === "mosaic" ? 8 + Math.random() * 20 : 3 + Math.random() * 8;
        blocks.push({ kind, w, h, x: cx - w / 2 + (Math.random() - .5) * 70, y: cy - h / 2 + (Math.random() - .5) * 60,
          born: now, life: 260 + Math.random() * 300, cell: 3 + Math.round(Math.random() * 4), shift: (Math.random() < .5 ? -1 : 1) * (8 + Math.random() * 22) });
      }
      if (!raf) raf = requestAnimationFrame(draw);
    };
    fit();
    const resize = new ResizeObserver(fit); resize.observe(tile);
    tile.addEventListener("pointermove", move);
    return () => { tile.removeEventListener("pointermove", move); resize.disconnect(); cancelAnimationFrame(raf); };
  }, [img, canvas]);
}

function PhotoTile({ id, ratio, hidden }: { id: string; ratio: string; hidden: boolean }) {
  const scene = LANDING_SCENES.find(s => s.id === id);
  const img = useRef<HTMLImageElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  usePixelGlitch(img, canvas);
  if (!scene) return null;
  return <figure className={styles.tile} data-scene={id} data-hidden={hidden || undefined} style={{ aspectRatio: ratio }}>
    <img ref={img} src={`/scene/wall/${id}.webp`} alt={scene.alt} loading="lazy" decoding="async" />
    <canvas ref={canvas} className={styles.glitch} aria-hidden="true" />
    <figcaption><strong>{scene.name}</strong><span>{scene.place}</span></figcaption>
  </figure>;
}

function FlipbookTile({ ratio, hidden }: { ratio: string; hidden: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReduced()) return;
    let timer = 0;
    // 进入视口才翻；先把十二帧都解码好，避免翻到没加载的帧闪白
    const preload = FRAMES.map(src => { const im = new Image(); im.src = src; return im.decode?.().catch(() => {}); });
    const io = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry.isIntersecting) void Promise.all(preload).then(() => { clearInterval(timer); timer = window.setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 700); });
    }, { threshold: .2 });
    io.observe(el);
    return () => { io.disconnect(); clearInterval(timer); };
  }, []);
  return <figure ref={ref} className={`${styles.tile} ${styles.flip}`} data-hidden={hidden || undefined} style={{ aspectRatio: ratio }}>
    <img src={FRAMES[frame]} alt="同一场景的四种运镜画面轮流播放" decoding="async" />
    <figcaption className={styles.always}><strong>运镜 · {MOTIONS[Math.floor(frame / 3)]}</strong><span>{String(frame + 1).padStart(2, "0")} / 12</span></figcaption>
  </figure>;
}

// 文件夹里插的五张：两端挂上地名标签
const FOLDER = ["victoria", "yozakura", "louvre", "london", "kelingking"];

export default function SceneWall() {
  const [filter, setFilter] = useState("all");
  const gridRef = useRef<HTMLDivElement>(null);
  const smooth = () => (prefersReduced() ? "instant" : "smooth") as ScrollBehavior;
  // 点文件夹里的卡片：切回「全部」，滚到墙上那一格并让它闪一下
  const showTile = (id: string) => {
    setFilter("all");
    requestAnimationFrame(() => {
      const tile = gridRef.current?.querySelector<HTMLElement>(`[data-scene="${id}"]`);
      if (!tile) return;
      tile.scrollIntoView({ behavior: smooth(), block: "center" });
      tile.removeAttribute("data-flash"); void tile.offsetWidth; tile.setAttribute("data-flash", "");
    });
  };
  return <section className={styles.wall} aria-labelledby="scene-wall-title">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>场景墙 · 9 个空间</p><h2 id="scene-wall-title">走过的地方。</h2>
        <div className={styles.chips} role="group" aria-label="筛选场景">
          {FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
      </div>
      <FolderFan label="场景" note="9 个空间"
        cards={FOLDER.map((id, i) => { const scene = LANDING_SCENES.find(s => s.id === id)!; return { key: id, title: scene.name, tag: i === 0 || i === FOLDER.length - 1 ? scene.name : undefined, thumb: <img src={`/scene/wall/${id}.webp`} alt="" loading="lazy" /> }; })}
        onOpenCard={showTile} onOpen={() => gridRef.current?.scrollIntoView({ behavior: smooth(), block: "start" })} />
    </header>
    <div ref={gridRef} className={styles.grid}>
      {LAYOUT.map(({ id, ratio, tags }) => {
        const hidden = filter !== "all" && !tags.includes(filter);
        if (id === "flipbook") return <FlipbookTile key={id} ratio={ratio} hidden={hidden} />;
        if (id === "quote") return <div key={id} className={`${styles.tile} ${styles.quote}`} data-hidden={hidden || undefined}>
          <p>照片记住的，<br />比你看见的<span aria-hidden="true" className={styles.dot} />更多。</p>
          <small>展示页里的九个场景，各由一张照片重建。</small>
        </div>;
        return <PhotoTile key={id} id={id} ratio={ratio} hidden={hidden} />;
      })}
    </div>
  </section>;
}
