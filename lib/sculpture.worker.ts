// Web Worker：在后台把三张视角图做成线的雕塑，不卡界面。
import { lift, paint, type SculptureImage } from "./sculpture-build";

self.onmessage = (event: MessageEvent<{ images: SculptureImage[] }>) => {
  const { images } = event.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const views = images.map((img, i) => { post({ stage: "paint", progress: i / images.length * .45 }); return paint(img, 3 + i); });
    const { width: W, height: H } = images[0];
    const { meta, bin } = lift(views, W, H, p => post({ stage: "lift", progress: .45 + p * .55 }));
    post({ done: true, meta, bin }, [bin]);
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) });
  }
};
