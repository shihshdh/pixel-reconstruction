"use client";
// 无边框客户端窗口的最小化 / 最大化 / 关闭按钮。网页版不显示。
import { useEffect, useState } from "react";
import { isDesktopApp, windowAction } from "@/lib/desktop";

const STYLE = `
.wc{display:flex;align-items:center;gap:6px;margin-left:6px;flex:none;}
.wc button{width:30px;height:30px;display:grid;place-items:center;border-radius:50%;border:1px solid transparent;background:transparent;color:inherit;opacity:.72;padding:0;transition:background .2s,opacity .2s,border-color .2s;}
.wc button:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent);border-color:color-mix(in srgb,currentColor 18%,transparent);}
.wc button.close:hover{background:#e5484d;border-color:#e5484d;color:#fff;}
.wc.on-scene button{color:#fff;opacity:.92;background:rgba(10,14,20,.22);border-color:rgba(255,255,255,.22);backdrop-filter:blur(12px) saturate(1.4);-webkit-backdrop-filter:blur(12px) saturate(1.4);}
.wc.on-scene button:hover{background:rgba(10,14,20,.38);}
.wc svg{width:12px;height:12px;stroke:currentColor;stroke-width:1.4;fill:none;stroke-linecap:round;}
`;
let injected = false;

export default function WindowControls({ className = "" }: { className?: string }) {
  const [show, setShow] = useState(false);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!injected) { injected = true; const s = document.createElement("style"); s.textContent = STYLE; document.head.appendChild(s); }
    setShow(true);
    const sync = () => { void windowAction("is_maximized").then(v => setMaximized(!!v)).catch(() => {}); };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  if (!show) return null;
  return <div className={`wc ${className}`} data-no-press="">
    <button type="button" aria-label="最小化" title="最小化" onClick={() => void windowAction("minimize")}><svg viewBox="0 0 12 12"><path d="M2.5 6h7" /></svg></button>
    <button type="button" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void windowAction("toggle_maximize")}>
      {maximized ? <svg viewBox="0 0 12 12"><rect x="2.5" y="4" width="5.5" height="5.5" rx="1" /><path d="M4.5 2.5h4a1 1 0 0 1 1 1v4" /></svg> : <svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" /></svg>}
    </button>
    <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => void windowAction("close")}><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg></button>
  </div>;
}
