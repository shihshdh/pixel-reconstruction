'use client';

// 工作室「线雕」：把当前作品做成线的雕塑。
// capture 由 SplatViewer 提供（在场景里换三个机位各拍一张）；之后在 Web Worker 里铺笔触、挑深度，
// 全程在本机浏览器里完成，不上传任何东西。完成后全屏打开，可拖动旋转、对齐三个视角。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LineSculpture, { type Meta } from "@/components/LineSculpture";
import type { SculptureImage } from "@/lib/sculpture-build";

type Phase = { kind: "idle" } | { kind: "capture" } | { kind: "build"; progress: number } | { kind: "error"; message: string };

export default function SculptureMaker({ capture, disabled, title }: { capture: () => Promise<SculptureImage[]>; disabled?: boolean; title?: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<{ meta: Meta; bin: ArrayBuffer } | null>(null);
  const [open, setOpen] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => workerRef.current?.terminate(), []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);

  const make = async () => {
    setPhase({ kind: "capture" });
    let images: SculptureImage[];
    try { images = await capture(); }
    catch (e) { setPhase({ kind: "error", message: e instanceof Error ? e.message : "取景失败，请重试。" }); return; }
    setPhase({ kind: "build", progress: 0 });
    workerRef.current?.terminate();
    const worker = new Worker(new URL("../lib/sculpture.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ progress?: number; done?: boolean; meta?: Meta; bin?: ArrayBuffer; error?: string }>) => {
      const d = event.data;
      if (d.error) { setPhase({ kind: "error", message: "生成失败：" + d.error }); worker.terminate(); return; }
      if (d.done && d.meta && d.bin) { setResult({ meta: d.meta, bin: d.bin }); setPhase({ kind: "idle" }); setOpen(true); worker.terminate(); return; }
      if (typeof d.progress === "number") setPhase({ kind: "build", progress: d.progress });
    };
    worker.onerror = () => { setPhase({ kind: "error", message: "生成失败，请重试。" }); worker.terminate(); };
    worker.postMessage({ images }, images.map(i => i.rgba.buffer));
  };

  const busy = phase.kind === "capture" || phase.kind === "build";
  return <>
    <div className="rig-card sculpture-card">
      <div className="rig-card-title">线雕 <span>把这个场景做成一团线，只在三个角度拼回画面</span></div>
      <div className="sculpture-row">
        <button className="key" onClick={() => void make()} disabled={disabled || busy}>
          {phase.kind === "capture" ? "正在取景…" : phase.kind === "build" ? `正在铺线 ${Math.round(phase.progress * 100)}%` : result ? "重新生成" : "生成线雕"}
        </button>
        {result && !busy && <button className="key ghost" onClick={() => setOpen(true)}>打开</button>}
        <span className="seq-hint">{phase.kind === "error" ? phase.message : "在本机完成，约 10 秒；取景时画面会短暂跳动。"}</span>
      </div>
    </div>
    {/* 挂到 body 上：工作室外层有入场动画的 transform，会让 position:fixed 相对它定位、被裁掉 */}
    {open && result && createPortal(<div className="sculpture-overlay" role="dialog" aria-modal="true" aria-label="线的雕塑">
      <button className="sculpture-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
      <LineSculpture variant="overlay" custom={result} title={title} />
    </div>, document.body)}
    <style>{`
      .sculpture-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .sculpture-overlay{position:fixed;inset:0;z-index:10050;background:var(--bg);color:var(--ink);font-family:"SF Pro SC","PingFang SC","Segoe UI Variable Display","Microsoft YaHei UI",sans-serif;animation:sculpture-in .45s cubic-bezier(.16,1,.3,1) both;}
      .sculpture-close{position:absolute;right:26px;top:22px;z-index:2;width:38px;height:38px;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:20px;line-height:1;cursor:pointer;}
      @keyframes sculpture-in{from{opacity:0;transform:scale(.985);}to{opacity:1;transform:none;}}
      @media(prefers-reduced-motion:reduce){.sculpture-overlay{animation:none;}}
    `}</style>
  </>;
}
