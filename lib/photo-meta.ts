// 照片的拍摄信息（EXIF）：拍摄时间、相机、镜头参数和 GPS。
// 服务端会去掉 EXIF，所以要在上传前从用户选的原始照片里读出来，跟作品一起存进作品库。
// 只解析 TIFF 结构里用得到的几个标签，JPEG、HEIC、PNG、WebP 都按“找到 TIFF 头再解析”处理。

export type PhotoMeta = {
  /** 拍摄时间，照片里记录的当地时间，格式 2026-09-28 21:14 */
  taken?: string;
  make?: string; model?: string; lens?: string;
  /** 实际焦距（mm）与 35mm 等效焦距 */
  focal?: number; focal35?: number;
  fNumber?: number;
  /** 快门（秒） */
  exposure?: number;
  iso?: number;
  lat?: number; lon?: number;
  /** 反查得到的中文地名；查过但没查到时为空串 */
  place?: string;
};

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** 在整段数据里找 TIFF 头：先找 "Exif\0\0"（JPEG、HEIC、部分 WebP），再找 PNG 的 eXIf / WebP 的 EXIF 块 */
function findTiff(data: Uint8Array): number {
  const isTiff = (i: number) => (data[i] === 0x49 && data[i + 1] === 0x49 && data[i + 2] === 0x2a && data[i + 3] === 0)
    || (data[i] === 0x4d && data[i + 1] === 0x4d && data[i + 2] === 0 && data[i + 3] === 0x2a);
  for (let i = 0; i < data.length - 10; i++) {
    const c = data[i];
    if (c === 0x45 && data[i + 1] === 0x78 && data[i + 2] === 0x69 && data[i + 3] === 0x66 && data[i + 4] === 0 && data[i + 5] === 0 && isTiff(i + 6)) return i + 6;
    // PNG "eXIf" 与 WebP "EXIF" 块：4 字节标记 + 4 字节长度，之后可能直接是 TIFF，也可能还带 "Exif\0\0"
    if ((c === 0x65 && ascii(data.subarray(i, i + 4)) === "eXIf") || (c === 0x45 && ascii(data.subarray(i, i + 4)) === "EXIF")) {
      if (isTiff(i + 8)) return i + 8;
    }
  }
  return -1;
}

function parseTiff(data: Uint8Array, start: number): PhotoMeta {
  const view = new DataView(data.buffer, data.byteOffset + start, data.length - start);
  const le = view.getUint16(0) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, le), u32 = (o: number) => view.getUint32(o, le);
  const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  type Entry = { type: number; count: number; at: number };
  const readIfd = (offset: number) => {
    const out = new Map<number, Entry>();
    if (offset <= 0 || offset + 2 > view.byteLength) return out;
    const n = u16(offset);
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      if (e + 12 > view.byteLength) break;
      const type = u16(e + 2), count = u32(e + 4), size = (SIZES[type] || 1) * count;
      out.set(u16(e), { type, count, at: size <= 4 ? e + 8 : u32(e + 8) });
    }
    return out;
  };
  const text = (e?: Entry) => {
    if (!e || e.at + e.count > view.byteLength) return undefined;
    let s = "";
    for (let k = 0; k < e.count; k++) { const b = view.getUint8(e.at + k); if (!b) break; s += String.fromCharCode(b); }
    return s.trim() || undefined;
  };
  const num = (e?: Entry, index = 0) => {
    if (!e) return undefined;
    const at = e.at + index * (SIZES[e.type] || 1);
    if (at + (SIZES[e.type] || 1) > view.byteLength) return undefined;
    if (e.type === 3) return u16(at);
    if (e.type === 4) return u32(at);
    if (e.type === 5) { const d = u32(at + 4); return d ? u32(at) / d : undefined; }
    if (e.type === 10) { const d = view.getInt32(at + 4, le); return d ? view.getInt32(at, le) / d : undefined; }
    return undefined;
  };
  const ifd0 = readIfd(u32(4));
  const exif = readIfd(num(ifd0.get(0x8769)) || 0);
  const gps = readIfd(num(ifd0.get(0x8825)) || 0);

  const meta: PhotoMeta = {};
  const when = text(exif.get(0x9003)) || text(ifd0.get(0x0132));
  const m = when?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
  if (m && m[1] !== "0000") meta.taken = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  meta.make = text(ifd0.get(0x010f)); meta.model = text(ifd0.get(0x0110)); meta.lens = text(exif.get(0xa434));
  meta.focal = num(exif.get(0x920a)); meta.focal35 = num(exif.get(0xa405)) || undefined;
  meta.fNumber = num(exif.get(0x829d)); meta.exposure = num(exif.get(0x829a)); meta.iso = num(exif.get(0x8827));
  const dms = (e?: Entry) => { const d = num(e, 0), mi = num(e, 1), s = num(e, 2); return d === undefined ? undefined : d + (mi || 0) / 60 + (s || 0) / 3600; };
  const lat = dms(gps.get(2)), lon = dms(gps.get(4));
  if (lat !== undefined && lon !== undefined && (lat || lon)) {
    meta.lat = +(text(gps.get(1)) === "S" ? -lat : lat).toFixed(5);
    meta.lon = +(text(gps.get(3)) === "W" ? -lon : lon).toFixed(5);
  }
  for (const key of Object.keys(meta) as (keyof PhotoMeta)[]) if (meta[key] === undefined || Number.isNaN(meta[key])) delete meta[key];
  return meta;
}

/** 从照片读拍摄信息。没有 EXIF 或解析失败时返回 null，不会抛错 */
export async function readPhotoMeta(blob: Blob): Promise<PhotoMeta | null> {
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const at = findTiff(data);
    if (at < 0) return null;
    const meta = parseTiff(data, at);
    return Object.keys(meta).length ? meta : null;
  } catch { return null; }
}

/** GPS 坐标反查中文地名（BigDataCloud 免费接口，无需密钥）。只发经纬度；失败返回 undefined，下次再试 */
export async function lookupPlace(lat: number, lon: number): Promise<string | undefined> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh-Hans`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return undefined;
    const d = await response.json();
    // 国内省略国名；省市同名（上海市 · 上海市）只留一个
    const parts = [d.countryCode === "CN" ? "" : d.countryName, d.principalSubdivision, d.city, d.locality]
      .map((s: unknown) => typeof s === "string" ? s.trim() : "").filter(Boolean)
      .filter((s: string, i: number, all: string[]) => all.indexOf(s) === i);
    return parts.join(" · ");
  } catch { return undefined; }
}

const trim = (n: number) => String(+n.toFixed(1));
/** 器材：去掉型号里重复的厂商名（Apple iPhone 15 Pro，而不是 Apple Apple iPhone…） */
export function photoDevice(meta: PhotoMeta) {
  const { make = "", model = "" } = meta;
  const device = !make || model.toLowerCase().startsWith(make.toLowerCase().split(" ")[0]) ? model : `${make} ${model}`;
  return device.trim() || undefined;
}
/** 参数行：等效焦距 · 光圈 · 快门 · ISO，缺哪项就省哪项 */
export function photoSettings(meta: PhotoMeta) {
  const parts: string[] = [];
  if (meta.focal35) parts.push(`${meta.focal35}mm 等效`); else if (meta.focal) parts.push(`${trim(meta.focal)}mm`);
  if (meta.fNumber) parts.push(`f/${trim(meta.fNumber)}`);
  if (meta.exposure) parts.push(meta.exposure >= 1 ? `${trim(meta.exposure)}s` : `1/${Math.round(1 / meta.exposure)}s`);
  if (meta.iso) parts.push(`ISO ${meta.iso}`);
  return parts.join(" · ") || undefined;
}
export function photoCoords(meta: PhotoMeta) {
  if (meta.lat === undefined || meta.lon === undefined) return undefined;
  return `${Math.abs(meta.lat).toFixed(4)}°${meta.lat >= 0 ? "N" : "S"} ${Math.abs(meta.lon).toFixed(4)}°${meta.lon >= 0 ? "E" : "W"}`;
}
