// Moments the companion can react to: a photo was just picked for developing, or a develop just
// finished. The page only announces them; the companion asks the user before looking at anything.
import { encodeVisionImage } from "./companion-vision";

export type CompanionMoment = { kind: "upload"; file: File } | { kind: "developed" };
export const MOMENT_EVENT = "companion:moment";

export function announceMoment(moment: CompanionMoment) {
  try { window.dispatchEvent(new CustomEvent<CompanionMoment>(MOMENT_EVENT, { detail: moment })); } catch {}
}

// A photo dropped on the companion: she hands it to the page, which develops it exactly as if it had
// been dropped on the create page. The page answers synchronously so she can say what happened.
export type UploadAnswer = "started" | "busy" | "unavailable";
export type UploadRequest = { file: File; answer: (result: UploadAnswer) => void };
export const UPLOAD_REQUEST_EVENT = "companion:upload";
export const PHOTO_LIMIT = 20 * 1024 * 1024;

/** The same formats and size the create page accepts. */
export function isDevelopablePhoto(file: File) {
  return (file.type.startsWith("image/") || /\.heic$/i.test(file.name)) && file.size <= PHOTO_LIMIT;
}

export function requestUpload(file: File): UploadAnswer {
  let result: UploadAnswer = "unavailable";
  try { window.dispatchEvent(new CustomEvent<UploadRequest>(UPLOAD_REQUEST_EVENT, { detail: { file, answer: value => { result = value; } } })); } catch {}
  return result;
}

/** The picked photo as a small JPEG for the model. HEIC and other formats the browser can't decode throw. */
export async function photoForVision(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("too large");
    return encodeVisionImage(image, image.naturalWidth, image.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** True when the canvas is one flat colour (scene not drawn yet). */
function blank(canvas: HTMLCanvasElement) {
  const probe = document.createElement("canvas");
  probe.width = 24; probe.height = 16;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) { const v = data[i] + data[i + 1] + data[i + 2]; min = Math.min(min, v); max = Math.max(max, v); }
  return max - min < 24;
}

/** A still of the studio's 3D view once the scene has drawn (the viewer keeps its drawing buffer). */
export async function captureScene(timeout = 45000): Promise<string | undefined> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const canvas = document.querySelector<HTMLCanvasElement>(".showcase-workspace .screen[data-scene-ready] canvas");
    if (canvas && canvas.width && canvas.height) {
      await wait(700); await frame(); await frame();
      try { if (!blank(canvas)) return encodeVisionImage(canvas, canvas.width, canvas.height); } catch { return undefined; }
    }
    await wait(500);
  }
  return undefined;
}
