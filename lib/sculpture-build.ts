// 线的雕塑：把同一场景的三张视角图变成一团立体彩线（浏览器版，跑在 Web Worker 里）。
// 是 Desktop\line-sculpture 里 paint.py + lift.py 的移植，参数沿用离线流程调好的值：
// 1. 每张图顺着纹理方向（结构张量）铺几万根短笔触，颜色逐点取自图片；露白处补种，直到覆盖约 93%。
// 2. 每一笔放在它所属视角的视线上，在一串候选深度里挑一个，让它在另外两个视角里投影最短、最不显眼。
// 输出格式与首页 public/sculpture/*.bin 相同，LineSculpture 直接能读。

export type SculptureImage = { width: number; height: number; rgba: Uint8ClampedArray };
export type SculptureMeta = {
  lineWidth: number; width: number; height: number; strokes: number; points: number; posScale: number; bin: string;
  views: { position: [number, number, number]; fov: number }[];
};
type Stroke = { pts: Float32Array; rgb: Uint8Array };

const P = { strokes: 24000, minLen: 8, maxLen: 30, step: 2, coverage: .975, spread: 80, radius: 3.2, distance: 5.2, fov: 30, candidates: 60, elev: [28, -6, 34] };

// —— 小工具：可分离高斯模糊、Sobel、双线性采样 ——
function blur(src: Float32Array, W: number, H: number, sigma: number) {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += src[y * W + Math.min(W - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * W + x] = a;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x] * k[i + r];
    out[y * W + x] = a;
  }
  return out;
}
const bilinear = (f: Float32Array, W: number, H: number, x: number, y: number) => {
  x = Math.min(W - 1.001, Math.max(0, x)); y = Math.min(H - 1.001, Math.max(0, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) + (f[i + W] * (1 - fx) + f[i + W + 1] * fx) * fy;
};

// 简单可复现的随机数（同一张图每次结果一样）
function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** 一张视角图 → 顺着纹理的彩色笔触 */
export function paint(img: SculptureImage, seed = 3): Stroke[] {
  const { width: W, height: H, rgba } = img;
  const rand = rng(seed);
  const lum = new Float32Array(W * H), cr = new Float32Array(W * H), cg = new Float32Array(W * H), cb = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    cr[i] = rgba[i * 4] / 255; cg[i] = rgba[i * 4 + 1] / 255; cb[i] = rgba[i * 4 + 2] / 255;
    lum[i] = .299 * cr[i] + .587 * cg[i] + .114 * cb[i];
  }
  const s = blur(lum, W, H, 1.2);
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    gx[i] = (s[i - W + 1] + 2 * s[i + 1] + s[i + W + 1]) - (s[i - W - 1] + 2 * s[i - 1] + s[i + W - 1]);
    gy[i] = (s[i + W - 1] + 2 * s[i + W] + s[i + W + 1]) - (s[i - W - 1] + 2 * s[i - W] + s[i - W + 1]);
  }
  const jxx = new Float32Array(W * H), jxy = new Float32Array(W * H), jyy = new Float32Array(W * H), mag = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { jxx[i] = gx[i] * gx[i]; jxy[i] = gx[i] * gy[i]; jyy[i] = gy[i] * gy[i]; mag[i] = Math.sqrt(jxx[i] + jyy[i]); }
  const bxx = blur(jxx, W, H, 3), bxy = blur(jxy, W, H, 3), byy = blur(jyy, W, H, 3);
  const tx = new Float32Array(W * H), ty = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const th = .5 * Math.atan2(2 * bxy[i], bxx[i] - byy[i]) + Math.PI / 2; tx[i] = Math.cos(th); ty[i] = Math.sin(th); }
  const detail = blur(mag, W, H, 2);
  const sorted = Float32Array.from(detail).sort(), p99 = sorted[Math.floor(sorted.length * .99)] + 1e-6;
  for (let i = 0; i < W * H; i++) detail[i] = Math.min(1, detail[i] / p99);
  // 颜色取轻微模糊后的图，1 像素的线不至于取到噪点
  const sr = blur(cr, W, H, .8), sg = blur(cg, W, H, .8), sb = blur(cb, W, H, .8);

  const make = (seeds: number[][]) => {
    const out: Stroke[] = [];
    for (const [x0, y0] of seeds) {
      const d0 = bilinear(detail, W, H, x0, y0);
      const len = P.maxLen - (P.maxLen - P.minLen) * Math.sqrt(d0), n = Math.max(2, Math.floor(len / P.step / 2));
      const half = (sign: number) => {
        const path: number[][] = []; let x = x0, y = y0, px = 0, py = 0, first = true;
        for (let k = 0; k < n; k++) {
          let vx = bilinear(tx, W, H, x, y) * sign, vy = bilinear(ty, W, H, x, y) * sign;
          if (!first && vx * px + vy * py < 0) { vx = -vx; vy = -vy; }   // 方向场是 ±：保持朝向一致
          x += vx * P.step; y += vy * P.step; px = vx; py = vy; first = false;
          path.push([x, y]);
        }
        return path;
      };
      let pts = [...half(-1).reverse(), [x0, y0], ...half(1)].filter(([x, y]) => x >= 0 && x < W && y >= 0 && y < H);
      if (pts.length < 2) continue;
      if (pts.length > 6) pts = pts.filter((_, i) => i % 2 === 0);   // 短笔画 4px 一个点足够
      const fp = new Float32Array(pts.length * 2), rgb = new Uint8Array(pts.length * 3);
      pts.forEach(([x, y], i) => {
        fp[i * 2] = x; fp[i * 2 + 1] = y;
        rgb[i * 3] = Math.round(bilinear(sr, W, H, x, y) * 255); rgb[i * 3 + 1] = Math.round(bilinear(sg, W, H, x, y) * 255); rgb[i * 3 + 2] = Math.round(bilinear(sb, W, H, x, y) * 255);
      });
      out.push({ pts: fp, rgb });
    }
    return out;
  };

  // 种子：一半均匀铺满，一半按细节浓度加权
  const seeds: number[][] = [];
  for (let i = 0; i < P.strokes / 2; i++) seeds.push([rand() * W, rand() * H]);
  const cdf = new Float32Array(W * H); let acc = 0;
  for (let i = 0; i < W * H; i++) { acc += .15 + detail[i]; cdf[i] = acc; }
  for (let i = 0; i < P.strokes / 2; i++) {
    const t = rand() * acc; let lo = 0, hi = W * H - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < t) lo = m + 1; else hi = m; }
    seeds.push([lo % W + rand(), Math.floor(lo / W) + rand()]);
  }
  const strokes = make(seeds);

  // 补空：把现有笔触画进 2 像素宽的遮罩，在露白处补种，反复几轮
  const mask = new Uint8Array(W * H);
  const stamp = (x: number, y: number) => { const xi = x | 0, yi = y | 0; for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const X = xi + dx, Y = yi + dy; if (X < W && Y < H) mask[Y * W + X] = 1; } };
  const rasterize = (list: Stroke[]) => {
    for (const st of list) for (let i = 0; i + 3 < st.pts.length; i += 2) {
      const x0 = st.pts[i], y0 = st.pts[i + 1], x1 = st.pts[i + 2], y1 = st.pts[i + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k <= n; k++) stamp(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
    }
  };
  rasterize(strokes);
  for (let round = 0; round < 6; round++) {
    const bare: number[] = [];
    for (let i = 0; i < W * H; i++) if (!mask[i]) bare.push(i);
    if (1 - bare.length / (W * H) >= P.coverage) break;
    const n = Math.min(bare.length, Math.max(500, Math.floor(bare.length / 30)));
    const pick: number[][] = [];
    for (let k = 0; k < n; k++) { const i = bare[Math.floor(rand() * bare.length)]; pick.push([i % W + rand(), Math.floor(i / W) + rand()]); }
    const more = make(pick); rasterize(more); strokes.push(...more);
  }
  return strokes;
}

type Cam = { pos: number[]; f: number[]; r: number[]; u: number[] };
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

function camera(i: number, n: number): Cam {
  const az = (i - (n - 1) / 2) * P.spread * Math.PI / 180, el = P.elev[i % P.elev.length] * Math.PI / 180;
  const pos = [Math.sin(az) * Math.cos(el) * P.distance, Math.sin(el) * P.distance, Math.cos(az) * Math.cos(el) * P.distance];
  const f = unit(pos.map(v => -v)), r = unit(cross(f, [0, 1, 0])), u = cross(r, f);
  return { pos, f, r, u };
}

/** 三组笔触 → 立体线团（二进制），progress 0..1 */
export function lift(views: Stroke[][], W: number, H: number, progress?: (p: number) => void): { meta: SculptureMeta; bin: ArrayBuffer } {
  const n = views.length, cams = Array.from({ length: n }, (_, i) => camera(i, n));
  const aspect = W / H, tan = Math.tan(P.fov * Math.PI / 360);
  const z0 = P.distance - P.radius, z1 = P.distance + P.radius;
  const cands = Array.from({ length: P.candidates }, (_, k) => z0 + (z1 - z0) * k / (P.candidates - 1));
  const rand = rng(7);
  // 像素 → 视线方向
  const ray = (c: Cam, x: number, y: number) => {
    const xn = (x / W * 2 - 1) * tan * aspect, yn = (1 - y / H * 2) * tan;
    return [c.f[0] + xn * c.r[0] + yn * c.u[0], c.f[1] + xn * c.r[1] + yn * c.u[1], c.f[2] + xn * c.r[2] + yn * c.u[2]];
  };
  const project = (c: Cam, p: number[]) => {
    const q = sub(p, c.pos), z = dot(q, c.f);
    return [((dot(q, c.r) / (z * tan * aspect)) + 1) / 2 * W, (1 - dot(q, c.u) / (z * tan)) / 2 * H, z];
  };
  const total = views.reduce((a, v) => a + v.length, 0);
  const out: { v: number; p: Float32Array; rgb: Uint8Array }[] = [];
  let done = 0;
  views.forEach((strokes, vi) => {
    const cam = cams[vi];
    for (const st of strokes) {
      const m = st.pts.length / 2;
      // 每隔约 8 像素取一个样点估成本
      const idx: number[] = [0];
      for (let i = 1, acc = 0; i < m; i++) { acc += Math.hypot(st.pts[i * 2] - st.pts[i * 2 - 2], st.pts[i * 2 + 1] - st.pts[i * 2 - 1]); if (acc >= 8 || i === m - 1) { idx.push(i); acc = 0; } }
      const dirs = idx.map(i => ray(cam, st.pts[i * 2], st.pts[i * 2 + 1]));
      const own = Math.max(1, idx.length > 1 ? (idx.length - 1) * 8 : 1);
      let best = 0, bestCost = Infinity;
      for (let c = 0; c < cands.length; c++) {
        const z = cands[c];
        const P3 = dirs.map(d => [cam.pos[0] + d[0] * z, cam.pos[1] + d[1] * z, cam.pos[2] + d[2] * z]);
        let cost = 0;
        for (const p of P3) cost += Math.max(0, Math.hypot(p[0], p[1], p[2]) - P.radius) * 6 / P3.length;
        for (let j = 0; j < n; j++) {
          if (j === vi) continue;
          const px = P3.map(p => project(cams[j], p));
          const vis = px.map(([x, y, d]) => (d > 0 && x > 0 && x < W && y > 0 && y < H) ? 1 : 0);
          if (px.length < 2) { cost += vis[0]; continue; }
          let seen = 0;
          for (let k = 1; k < px.length; k++) seen += Math.hypot(px[k][0] - px[k - 1][0], px[k][1] - px[k - 1][1]) * (vis[k] + vis[k - 1]) / 2;
          cost += seen / own;
        }
        cost += rand() * .04;   // 打破平局，自由的笔画在深度上散开
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      const z = cands[best], p = new Float32Array(m * 3);
      for (let i = 0; i < m; i++) {
        const d = ray(cam, st.pts[i * 2], st.pts[i * 2 + 1]);
        p[i * 3] = cam.pos[0] + d[0] * z; p[i * 3 + 1] = cam.pos[1] + d[1] * z; p[i * 3 + 2] = cam.pos[2] + d[2] * z;
      }
      out.push({ v: vi, p, rgb: st.rgb });
      if (++done % 2000 === 0) progress?.(done / total);
    }
  });
  // 打包：uint32 offsets[S+1] | uint8 view[S]（补齐 4 字节）| int16 xyz[3P] | uint8 rgb[3P]
  const S = out.length, points = out.reduce((a, s) => a + s.p.length / 3, 0), posScale = 8 / 32767;
  const pad = (4 - S % 4) % 4, xyzAt = (S + 1) * 4 + S + pad;
  const bin = new ArrayBuffer(xyzAt + points * 6 + points * 3);
  const offsets = new Uint32Array(bin, 0, S + 1), vid = new Uint8Array(bin, (S + 1) * 4, S);
  const xyz = new Int16Array(bin, xyzAt, points * 3), rgb = new Uint8Array(bin, xyzAt + points * 6, points * 3);
  let at = 0;
  out.forEach((s, i) => {
    offsets[i] = at; vid[i] = s.v;
    for (let k = 0; k < s.p.length; k++) xyz[at * 3 + k] = Math.max(-32767, Math.min(32767, Math.round(s.p[k] / posScale)));
    rgb.set(s.rgb, at * 3); at += s.p.length / 3;
  });
  offsets[S] = at;
  const meta: SculptureMeta = { lineWidth: 3.2, width: W, height: H, strokes: S, points, posScale, bin: "",
    views: cams.map(c => ({ position: c.pos.map(v => +v.toFixed(5)) as [number, number, number], fov: P.fov })) };
  return { meta, bin };
}
