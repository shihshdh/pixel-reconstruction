// 液态玻璃的位移贴图：按 iOS 26 标签栏的玻璃做——是透镜，不是磨砂板。
// 胶囊形玻璃的边缘是一圈圆弧斜面：越靠近边缘越陡，背后的画面被往外“拉”进来（你在边缘看到的是玻璃外面一点点的东西），
// 中间平坦、几乎不弯折。按下时浮起的透镜再叠一层放大：采样点向中心收拢，底下的文字被放大。
//
// 贴图给 SVG feDisplacementMap 用：输出像素 P 取背后 P + scale·(R−0.5, G−0.5) 处的颜色。
// 所以 R/G 存的是“往哪里采样”的偏移，归一化到 ±scale/2。按设备像素比生成，结果按尺寸缓存。

export type LensKind = "bar" | "lens";
export type LensMap = { url: string; scale: number };

const cache = new Map<string, LensMap>();

/** 圆角矩形的有向距离（内部为负）与外法线 */
function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  const cx = w / 2, cy = h / 2;
  const px = x - cx, py = y - cy;
  const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const outside = Math.hypot(ox, oy);
  const d = outside + Math.min(Math.max(qx, qy), 0) - r;
  let nx: number, ny: number;
  if (qx > 0 && qy > 0) { nx = ox / (outside || 1); ny = oy / (outside || 1); }
  else if (qx > qy) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
  return { d, nx: nx * Math.sign(px || 1), ny: ny * Math.sign(py || 1) };
}

/**
 * w、h 为 CSS 像素。bar：只有边缘弯折；lens：边缘弯折 + 整体放大 magnify 倍。
 * bezel 为斜面宽度（默认高度的 0.42），bend 为边缘最大偏移（px）。
 */
export function lensMap(w: number, h: number, kind: LensKind, options: { radius?: number; bezel?: number; bend?: number; magnify?: number; dpr?: number } = {}): LensMap | null {
  if (typeof document === "undefined" || w < 4 || h < 4) return null;
  const dpr = Math.min(2, options.dpr ?? (window.devicePixelRatio || 1));
  const r = Math.min(options.radius ?? h / 2, w / 2, h / 2);
  const bezel = options.bezel ?? h * .42;
  const bend = options.bend ?? (kind === "lens" ? h * .32 : h * .22);
  const magnify = kind === "lens" ? options.magnify ?? 1.18 : 1;
  const key = [Math.round(w), Math.round(h), kind, r.toFixed(1), bezel.toFixed(1), bend.toFixed(1), magnify, dpr].join(":");
  const hit = cache.get(key);
  if (hit) return hit;

  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  // 最大偏移：边缘弯折 + 放大在最远处带来的收拢量
  const pull = 1 - 1 / magnify;
  const maxOffset = bend + Math.max(w, h) / 2 * pull + 1;
  const scale = Math.ceil(maxOffset * 2);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(W, H);
  const data = image.data;
  for (let j = 0; j < H; j++) {
    const y = (j + .5) / dpr;
    for (let i = 0; i < W; i++) {
      const x = (i + .5) / dpr;
      const { d, nx, ny } = roundedRect(x, y, w, h, r);
      let ox = 0, oy = 0;
      const t = -d; // 离边缘的距离（向内为正）
      if (t > 0 && t < bezel) {
        // 圆弧斜面的坡度：边缘最陡、到斜面内侧归零；用平滑曲线避免边缘出现硬折痕
        const u = 1 - t / bezel;
        const slope = u * u * (3 - 2 * u) * Math.pow(u, .6);
        ox += nx * bend * slope; oy += ny * bend * slope;
      }
      if (pull > 0 && t > 0) {
        // 放大：采样点向中心收拢；越靠边缘收拢越多，与边缘弯折叠加
        ox -= (x - w / 2) * pull; oy -= (y - h / 2) * pull;
      }
      const k = (j * W + i) * 4;
      data[k] = Math.round(Math.max(0, Math.min(255, (.5 + ox / scale) * 255)));
      data[k + 1] = Math.round(Math.max(0, Math.min(255, (.5 + oy / scale) * 255)));
      data[k + 2] = 128;
      data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const result = { url: canvas.toDataURL("image/png"), scale };
  if (cache.size > 48) cache.clear();
  cache.set(key, result);
  return result;
}

let refractSupport: boolean | undefined;
/** 只有 Chromium 内核支持把 SVG 滤镜用作 backdrop-filter（Windows 客户端的 WebView2 也是）。其他浏览器退回磨砂玻璃。 */
export function supportsRefraction(): boolean {
  if (refractSupport !== undefined) return refractSupport;
  refractSupport = false;
  try {
    refractSupport = /Chrome|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent)
      && CSS.supports("backdrop-filter", "url(#x)");
  } catch {}
  return refractSupport;
}
