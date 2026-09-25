// 上传前在本地把照片准备好：先完整读进内存，只有超过 20MB 才压缩。
// 电脑上的 iCloud 照片常是“云端占位文件”，浏览器第一次读取时 Windows 才去 iCloud 下载原图，
// 国内网络下这一步可能要很久，看起来像卡死。这里把读取单独拆出来显示进度，读完之后
// 显影动画、鲸鱼看图和上传都只用内存里的副本，不再碰磁盘上的占位文件。

export const UPLOAD_LIMIT = 20 * 1024 * 1024;
// 服务端收到后本来就会缩到长边 4096，这里同样封顶，不会比原流程损失更多细节。
const MAX_EDGE = 4096;
// 压缩目标：略低于 20MB，给表单开销留余量。先用高质量，放不下再逐级降低。
const TARGET = 19.5 * 1024 * 1024;
const QUALITIES = [0.95, 0.92, 0.88, 0.84];
const STALL_MS = 6000;

export type ReadProgress = { read: number; total: number; stalled: boolean };

function abortError() { return new DOMException("已取消", "AbortError"); }

/** 把整张照片读进内存。无进展超过数秒时 stalled=true（通常是 iCloud 还在下载原图）。 */
export async function readLocalPhoto(file: File, onProgress: (p: ReadProgress) => void, signal?: AbortSignal): Promise<Blob> {
  const total = file.size;
  let read = 0, last = performance.now(), stalled = false;
  const report = () => onProgress({ read, total, stalled });
  const watch = setInterval(() => {
    const now = stalled || performance.now() - last > STALL_MS;
    if (now !== stalled) { stalled = now; report(); }
  }, 1000);
  report();
  try {
    if (typeof file.stream !== "function") {
      const buffer = await file.arrayBuffer();
      if (signal?.aborted) throw abortError();
      read = buffer.byteLength; report();
      return new Blob([buffer], { type: file.type });
    }
    const reader = file.stream().getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    const chunks: BlobPart[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal?.aborted) throw abortError();
        if (done) break;
        chunks.push(value);
        read += value.byteLength; last = performance.now();
        if (stalled) stalled = false;
        report();
      }
    } finally { signal?.removeEventListener("abort", cancel); }
    return new Blob(chunks, { type: file.type });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    // 占位文件下载失败、文件被移动或权限变化时，浏览器只会给出 NotReadableError
    throw new Error("无法读取这张照片。如果它存放在 iCloud，请先在 iCloud 照片里下载到本机，或换一张照片。", { cause: error });
  } finally { clearInterval(watch); }
}

async function decode(blob: Blob): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();          // 现代浏览器绘制时按 EXIF 方向摆正
    return image.naturalWidth && image.naturalHeight ? image : null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => { try { canvas.toBlob(resolve, "image/jpeg", quality); } catch { resolve(null); } });
}

/**
 * ≤ 20MB 的照片原样上传，一个字节都不改。超过 20MB 时才压缩：分辨率保留到服务端同样的 4096 上限，
 * 从高质量 JPEG 开始逐级尝试，取第一个能放进约 20MB 的结果；实在放不下才再缩小尺寸。
 * 服务端本来就会去掉 EXIF、摆正方向并重存 JPEG，所以这里重编码不会丢掉后续用到的信息。
 */
export async function preparePhoto(blob: Blob, name: string): Promise<{ file: File; compressed: boolean }> {
  if (blob.size <= UPLOAD_LIMIT) return { file: new File([blob], name, { type: blob.type }), compressed: false };
  const tooLarge = () => new Error("这张照片超过 20MB，且当前浏览器无法在本地压缩它（HEIC 在电脑浏览器上常见）。请先导出为 JPG 再上传。");
  const image = await decode(blob);
  if (!image) throw tooLarge();
  const { naturalWidth: w, naturalHeight: h } = image;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw tooLarge();
  try {
    for (let scale = Math.min(1, MAX_EDGE / Math.max(w, h)); scale > 0.2; scale *= 0.85) {
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const out = await encode(canvas, quality);
        if (!out) throw tooLarge();
        if (out.size <= TARGET) return { file: new File([out], name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }), compressed: true };
      }
    }
    throw tooLarge();
  } finally { canvas.width = canvas.height = 0; }   // 及时释放大画布（iOS 对画布内存很敏感）
}
