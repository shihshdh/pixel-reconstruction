'use client';
import { useEffect, useRef, useState } from 'react';
import { registerCompanionImage } from '@/lib/companion-vision';

/** A bounded particle loop; task status always comes from the backend. */
export default function DevelopPainting({ file }: { file: File | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(3 / 2);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!file) return;
    const image = new Image(), url = URL.createObjectURL(file);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let alive = true, raf = 0, elapsed = 0, lastTime = 0, lastPaint = 0, visible = true;
    let resize: ResizeObserver | undefined, intersection: IntersectionObserver | undefined;
    let unregister: (() => void) | undefined;
    let render: ((time: number) => void) | undefined, fit: (() => void) | undefined;
    const cancel = () => { cancelAnimationFrame(raf); raf = 0; lastTime = 0; };
    const tick = (now: number) => {
      if (!alive || !visible || document.hidden || media.matches) { cancel(); return; }
      if (lastTime) elapsed += Math.min(80, now - lastTime);
      lastTime = now;
      if (now - lastPaint > 1000 / 30) { render?.(elapsed); lastPaint = now; }
      raf = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancel();
      if (!alive || !visible || document.hidden || !render) return;
      if (media.matches) render(4000); else raf = requestAnimationFrame(tick);
    };
    const visibility = () => document.hidden ? cancel() : resume();
    document.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', resume);
    setFailed(false);
    image.onerror = () => { if (alive) setFailed(true); };
    image.onload = () => {
      if (alive && canvas.current) unregister = registerCompanionImage(canvas.current, image, '用户刚上传的完整原图（不是显影动画）');
      if (!alive) return;
      setRatio(image.naturalWidth / image.naturalHeight);
      fit = () => {
        const el = canvas.current, ctx = el?.getContext('2d');
        if (!el || !ctx || !el.clientWidth) return;
        const width = el.clientWidth, height = width * image.naturalHeight / image.naturalWidth;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        el.width = Math.round(width * dpr); el.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // 粒子密度随画面面积走：电脑上约 4.5px 一颗（上限 26000），手机上自动变少
        const budget = Math.max(1200, Math.min(26000, Math.round(width * height / 20)));
        const cols = Math.max(2, Math.round(Math.sqrt(budget * width / height)));
        const rows = Math.max(2, Math.min(Math.floor(budget / cols), Math.round(cols * height / width)));
        const sample = document.createElement('canvas'); sample.width = cols; sample.height = rows;
        const pixels = sample.getContext('2d', { willReadFrequently: true });
        if (!pixels) return;
        pixels.imageSmoothingEnabled = true; pixels.imageSmoothingQuality = 'high';
        pixels.drawImage(image, 0, 0, cols, rows);
        const colors = pixels.getImageData(0, 0, cols, rows).data;
        const cw = width / cols, ch = height / rows, diag = Math.hypot(width, height) / 2;
        const points = Array.from({ length: cols * rows }, (_, i) => {
          const rand = (k: number) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
          const x = (i % cols + .5) * cw, y = (Math.floor(i / cols) + .5) * ch;
          // 从中心向外一圈圈显影：越靠外越晚落位，再叠一点随机让边缘不整齐
          const radial = Math.hypot(x - width / 2, y - height / 2) / diag;
          const angle = rand(1) * Math.PI * 2, reach = .45 + rand(2) * .95;
          return {
            x, y, delay: radial * .34 + rand(3) * .16,
            // 起点散到画框外面，飞行范围覆盖整幅画
            dx: Math.cos(angle) * width * reach, dy: Math.sin(angle) * height * reach,
            grow: 1.4 + rand(4) * 2.2, // 远处的粒子更大更虚，落位时收成一格
            color: `rgb(${colors[i * 4]},${colors[i * 4 + 1]},${colors[i * 4 + 2]})`,
          };
        });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        const CYCLE = 8400, GATHER = 3000, REVEAL = 2700, FADE = 800, HOLD = 5200, SCATTER = 3000;
        const easeOut = (t: number) => 1 - Math.pow(1 - t, 3), easeIn = (t: number) => t * t * t;
        let holding = false;
        render = (time: number) => {
          const phase = time % CYCLE, nextHolding = phase >= REVEAL + FADE && phase < HOLD;
          if (holding && nextHolding) return;
          holding = nextHolding;
          ctx.clearRect(0, 0, width, height);
          const photo = phase < HOLD
            ? Math.max(0, Math.min(1, (phase - REVEAL) / FADE))
            : Math.max(0, 1 - (phase - HOLD) / 450);
          if (photo < 1) {
            for (const p of points) {
              let k: number, alpha: number;
              if (phase < HOLD) {
                const t = Math.min(1, Math.max(0, (phase / GATHER - p.delay) / .5));
                k = easeOut(t); alpha = Math.min(1, t * 3);
              } else {
                const t = Math.min(1, Math.max(0, ((phase - HOLD) / SCATTER - (.5 - p.delay)) / .5));
                k = 1 - easeIn(t); alpha = 1 - t * t;
              }
              if (alpha <= .01) continue;
              const scale = 1 + (p.grow - 1) * (1 - k) * (1 - k);
              const w = cw * scale * (k > .98 ? 1.1 : .82), h = ch * scale * (k > .98 ? 1.1 : .82);
              ctx.globalAlpha = alpha * (1 - photo) * (k > .98 ? 1 : .85);
              ctx.fillStyle = p.color;
              ctx.fillRect(p.x + p.dx * (1 - k) - w / 2, p.y + p.dy * (1 - k) - h / 2, w, h);
            }
          }
          if (photo > 0) { ctx.globalAlpha = photo; ctx.drawImage(image, 0, 0, width, height); }
          ctx.globalAlpha = 1;
        };
        render(media.matches ? 4000 : elapsed); resume();
      };
      requestAnimationFrame(() => {
        if (!alive) return;
        fit?.(); resize = new ResizeObserver(() => fit?.());
        intersection = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); resume(); }, { threshold: .02 });
        if (canvas.current) { resize.observe(canvas.current); intersection.observe(canvas.current); }
      });
    };
    image.src = url;
    return () => { alive = false; unregister?.(); cancel(); resize?.disconnect(); intersection?.disconnect(); document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', resume); URL.revokeObjectURL(url); };
  }, [file]);
  return <figure className="develop-painting" style={{ width: `min(100%, calc(min(68vh, 860px) * ${ratio.toFixed(4)}))` }}>
    <div className="develop-mat"><div style={{ position: 'relative', aspectRatio: String(ratio), overflow: 'hidden', background: '#20251c' }}>
      <canvas ref={canvas} aria-label="照片循环从彩色粒子聚成完整画面，表示正在处理" style={{ display: 'block', width: '100%', height: '100%' }} />
      {failed && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#e8e6de', fontSize: 13 }}>照片已接收，等待云端处理</span>}
    </div></div>
    <figcaption style={{ textAlign: 'center', color: 'var(--ink3)', fontSize: 11, letterSpacing: '.18em', marginTop: 16 }}>Pixel Reconstruction · 场景重建中</figcaption>
  </figure>;
}
