'use client';

// Pixel Reconstruction — scene creation, studio and image editing.

import { useState, useEffect, useRef, useCallback, type CSSProperties, type ElementType, type ReactNode } from "react";
import dynamic from "next/dynamic";
import DevelopPainting from "@/components/DevelopPainting";
import CompanionPageImage from "@/components/CompanionPageImage";
import { announceMoment, isDevelopablePhoto, UPLOAD_REQUEST_EVENT, type UploadRequest } from "@/lib/companion-moments";
import { useScenePoster } from "@/components/ScenePoster";
import { cacheGalleryItem, deleteGalleryItem, galleryId, isSameGalleryScene, getGalleryAsset, getGalleryScene, listGallery, setGalleryFavorite, subscribeGallery, type GalleryItem } from "@/lib/gallery-storage";
import DoubaoSettings, { type DoubaoPreferences } from "@/components/DoubaoSettings";
import EditPromptPicker from "@/components/EditPromptPicker";
import BrandMark from "@/components/BrandMark";
import InteriorStyles from "@/components/InteriorStyles";
import WorkflowPreview from "@/components/WorkflowPreview";
import ShowcaseTransition from "@/components/ShowcaseTransition";
import BrandIntro from "@/components/BrandIntro";
import PixelLoader from "@/components/PixelLoader";
import { MorphIcon } from "morphicons/react";
import { ICON } from "@/lib/icons";
import AuthorContact from "@/components/AuthorContact";
import { isDesktopApp, openWorksFolder } from "@/lib/desktop";
// 现有 API（lib/api.ts）——创作/工作室/修图都用它
import {
  submitPhoto, checkStatus, editImage, requestRerender,
  fileUrl, downloadJobFile, ping, getBase, getDefaultBase, saveBase, normalizeBase, registerJobAccess, refreshJobAccess,
} from "@/lib/api";
// 动效地基：时长 / 缓动 / 降级判断 / FLIP
import { prefersReduced, SPRING, installPressFeedback, useParallax } from "@/lib/motion";
// Three.js 渲染器：禁 SSR
function LandingFallback() {
  return <div className="landing-fallback" role="status" aria-label="正在准备三维展示">
    <img src="/scene/landing.jpg" alt="夕阳照进临海的房间，窗外是停泊的船" fetchPriority="high" />
    <div className="landing-fallback-shade" aria-hidden="true" />
    <div className="landing-fallback-brand" data-brand-target=""><BrandMark size={40} /><span>Pixel<br />Reconstruction<small>SINGLE-IMAGE 3D</small></span></div>
    <p>正在准备三维展示<span aria-hidden="true">…</span><noscript> · 请启用 JavaScript 以浏览三维场景</noscript></p>
  </div>;
}
const LandingExperience = dynamic(() => import("@/components/LandingExperience"), { ssr: false, loading: LandingFallback });
const SplatViewer = dynamic(() => import("@/components/SplatViewer"), { ssr: false });
// Site companion; loads only after the landing and only when the gateway can chat.
const WhaleCompanion = dynamic(() => import("@/components/WhaleCompanion"), { ssr: false });

// Public gateway URLs only; no Beam account token is needed in the browser.
const BEAM_URL = getDefaultBase();
const SOURCE_URL = { beam: BEAM_URL, local: "http://localhost:8000" };
const SOURCE_META = {
  beam: { name: "Beam", sub: "RTX 4090 · Serverless" },
  local: { name: "本地", sub: "你自己的 GPU" },
};
type Source = keyof typeof SOURCE_URL;
const isLocalPage = () => typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const isLoopbackAddress = (value: string) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname); } catch { return false; } };

// ============================================================
// 设计系统：注入全局 CSS 变量 + 字体 + 动画
// ============================================================
const GLOBAL_CSS = `
*{box-sizing:border-box;}
:root{
  --bg:#ffffff;--bg2:#fafafa;--card:#ffffff;--track:#f0f0f3;
  --ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;
  --line:#e8e8ed;--line2:#d2d2d7;--accent:#0071e3;
  --glass:rgba(255,255,255,0.72);--glass-brd:rgba(255,255,255,0.65);--nav-brd:rgba(0,0,0,0.08);
  --shadow:0 30px 80px -34px rgba(0,0,0,0.4);
}
[data-theme="dark"]{
  --bg:#000000;--bg2:#0a0a0c;--card:#161618;--track:#1f1f22;
  --ink:#f5f5f7;--ink2:#a1a1a6;--ink3:#6e6e73;
  --line:rgba(255,255,255,0.10);--line2:rgba(255,255,255,0.16);--accent:#0a84ff;
  --glass:rgba(22,22,24,0.66);--glass-brd:rgba(255,255,255,0.14);--nav-brd:rgba(255,255,255,0.08);
  --shadow:0 30px 80px -30px rgba(0,0,0,0.8);
}
.ruhua-root{
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro SC","SF Pro Display","PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;
  color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;min-height:100vh;
}
.ruhua-root button{font-family:inherit;cursor:pointer;}
.ruhua-root ::selection{background:rgba(0,113,227,0.16);}
@keyframes floaty{0%,100%{transform:translateY(0);}50%{transform:translateY(-7px);}}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes sheen{0%{transform:translateX(-120%);}100%{transform:translateX(220%);}}

/* —— 滚动渐显：默认隐藏，进入视口加 .in 才浮现 —— */
.reveal{opacity:0;transform:translateY(28px);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1);}
.reveal.in{opacity:1;transform:none;}
/* 子元素依次错峰浮现 */
.reveal-stagger > *{opacity:0;transform:translateY(24px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1);}
.reveal-stagger.in > *{opacity:1;transform:none;}
.reveal-stagger.in > *:nth-child(1){transition-delay:.04s;}
.reveal-stagger.in > *:nth-child(2){transition-delay:.12s;}
.reveal-stagger.in > *:nth-child(3){transition-delay:.20s;}
.reveal-stagger.in > *:nth-child(4){transition-delay:.28s;}
.reveal-stagger.in > *:nth-child(5){transition-delay:.36s;}
.reveal-stagger.in > *:nth-child(6){transition-delay:.44s;}

/* —— 打字机：逐字显现 + 闪烁光标 —— */
@keyframes caret-blink{0%,100%{opacity:1;}50%{opacity:0;}}
.tw-caret{display:inline-block;width:0.06em;margin-left:0.04em;background:currentColor;animation:caret-blink 1s step-end infinite;vertical-align:-0.05em;border-radius:2px;}

/* —— 液态玻璃流动：胶囊滑块的高光在内部缓缓游动 —— */
@keyframes liquid-flow{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}
.liquid-thumb{
  position:absolute;top:3px;bottom:3px;border-radius:980px;z-index:0;
  background:linear-gradient(110deg,var(--accent),#5ac8fa,var(--accent),#5ac8fa);
  background-size:300% 100%;animation:liquid-flow 5s ease-in-out infinite;
  box-shadow:0 4px 14px -4px rgba(0,113,227,0.6),inset 0 1px 0 rgba(255,255,255,0.3);
  transition:transform .42s cubic-bezier(.16,1,.3,1);
}
.liquid-thumb::after{
  content:"";position:absolute;inset:0;border-radius:inherit;
  background:linear-gradient(120deg,transparent 20%,rgba(255,255,255,0.55) 50%,transparent 80%);
  background-size:200% 100%;animation:sheen 3.4s ease-in-out infinite;mix-blend-mode:overlay;
}
.seg-btn{position:relative;z-index:1;border:0;background:none;transition:color .3s;}

/* dock 白色液态滑块 */
.dock-thumb{
  position:absolute;top:5px;bottom:5px;border-radius:980px;z-index:0;background:#fff;
  box-shadow:0 6px 18px -6px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.9);
  transition:transform .42s cubic-bezier(.16,1,.3,1);
  overflow:hidden;
}
.dock-thumb::after{
  content:"";position:absolute;inset:0;
  background:linear-gradient(120deg,transparent 30%,rgba(0,113,227,0.16) 50%,transparent 70%);
  background-size:200% 100%;animation:sheen 4s ease-in-out infinite;
}

@media(prefers-reduced-motion:reduce){.reveal,.reveal-stagger>*{transition:none;opacity:1;transform:none;}.liquid-thumb{animation:none;}}

/* —— 液态玻璃容器反光：顶部一道流动高光，营造玻璃质感 —— */
@keyframes glass-shimmer{0%{transform:translateX(-60%);}100%{transform:translateX(160%);}}
.glass-reflect{position:relative;overflow:hidden;}
.glass-reflect::before{
  content:"";position:absolute;top:0;left:0;right:0;height:50%;border-radius:inherit;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,0.4),rgba(255,255,255,0));z-index:2;
}
.glass-reflect::after{
  content:"";position:absolute;top:0;bottom:0;width:40%;pointer-events:none;z-index:2;
  background:linear-gradient(110deg,transparent,rgba(255,255,255,0.35),transparent);
  filter:blur(4px);animation:glass-shimmer 6s ease-in-out infinite;
}
[data-theme="dark"] .glass-reflect::before{background:linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0));}

/* —— 作品库卡片：逐个浮现（行内错峰，越靠后延迟越多）—— */
.gallery-grid > *{opacity:0;transform:translateY(26px) scale(.98);transition:opacity .6s cubic-bezier(.2,.7,.2,1),transform .6s cubic-bezier(.2,.7,.2,1);}
.gallery-grid.in > *{opacity:1;transform:none;}
.gallery-grid.in > *:nth-child(1){transition-delay:.02s;}
.gallery-grid.in > *:nth-child(2){transition-delay:.08s;}
.gallery-grid.in > *:nth-child(3){transition-delay:.14s;}
.gallery-grid.in > *:nth-child(4){transition-delay:.20s;}
.gallery-grid.in > *:nth-child(5){transition-delay:.26s;}
.gallery-grid.in > *:nth-child(6){transition-delay:.32s;}
.gallery-grid.in > *:nth-child(7){transition-delay:.38s;}
.gallery-grid.in > *:nth-child(8){transition-delay:.44s;}
.gallery-grid.in > *:nth-child(n+9){transition-delay:.5s;}

/* —— 修图结果图淡入 —— */
@keyframes img-pop{from{opacity:0;transform:translateY(14px) scale(.97);}to{opacity:1;transform:none;}}
.img-pop{animation:img-pop .55s cubic-bezier(.2,.7,.2,1) both;}

/* —— 导航响应式 —— */
.nav-bar{display:flex;align-items:center;gap:0;padding:0 24px;height:52px;}
.nav-logo{display:inline-flex;align-items:center;gap:9px;font-size:13px;margin-right:28px;letter-spacing:-.015em;flex:none;white-space:nowrap;}
.nav-logo svg{flex:none;}
.nav-tabs{display:flex;align-items:center;gap:30px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;}
.nav-tabs::-webkit-scrollbar{display:none;}
.nav-tab{font-size:13px;white-space:nowrap;flex:none;}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:14px;flex:none;padding-left:12px;}
.nav-cta{font-size:13px;padding:8px 18px;white-space:nowrap;}
.nav-theme{width:34px;height:34px;font-size:15px;flex:none;}
.nav-download{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 9px;border:1px solid transparent;border-radius:11px;color:inherit;font-size:12px;white-space:nowrap;text-decoration:none;transition:background 180ms,border-color 180ms,transform 180ms;}
.nav-download svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round;}
.nav-download:hover{background:color-mix(in srgb,currentColor 5%,transparent);border-color:color-mix(in srgb,currentColor 8%,transparent);}
.nav-download:active{transform:scale(.96);}
@media(max-width:1023px){.nav-download{display:none;}}
.gallery-folder{margin-left:10px;padding:4px 12px;border:1px solid var(--line);border-radius:99px;background:var(--card);color:var(--ink);font-size:12px;}
@media(max-width:640px){
  .nav-bar{padding:0 14px;height:50px;}
  .nav-logo{font-size:13px;margin-right:14px;letter-spacing:0;}
  .nav-logo .brand-name{display:none;}
  .nav-tabs{gap:18px;-webkit-mask:linear-gradient(90deg,#000 88%,transparent);mask:linear-gradient(90deg,#000 88%,transparent);}
  .nav-tab{font-size:13px;}
  .nav-right{gap:8px;padding-left:8px;}
  .nav-cta{font-size:12px;padding:7px 13px;}
  .nav-theme{width:30px;height:30px;font-size:14px;}
}
@media(max-width:380px){
  .nav-logo{margin-right:10px;}
  .nav-tabs{gap:14px;}
  .nav-cta{padding:7px 11px;}
}

/* —— 移动端：内容页顶部留白收紧、左右边距小一点 —— */
@media(max-width:640px){
  .ruhua-root main{padding-left:16px;padding-right:16px;}
}

/* ============================================================
   动效地基：时长 / 缓动 token —— 全站只用这几个值
   即时反馈 120ms · 常规状态 220ms · 布局遮罩 380ms · 主角入场 640ms
   缓动一律自然减速，不用回弹。
   ============================================================ */
:root{
  --e-out:cubic-bezier(.16,1,.3,1);
  --d-fb:120ms;--d-state:220ms;--d-layout:380ms;--d-hero:640ms;
}

/* —— 片门（拖拽区）：边框改成 SVG，拖拽时蚁行 —— */
.dz{position:relative;border:0;background:var(--bg2);
  transition:background var(--d-state) var(--e-out);}
.dz-frame{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;}
.dz-rect{fill:none;stroke:var(--line2);stroke-width:1.5;stroke-dasharray:11 9;
  transition:stroke var(--d-state) var(--e-out),stroke-width var(--d-state) var(--e-out);}
@keyframes dz-ants{to{stroke-dashoffset:-40;}}
.dz-over{background:color-mix(in srgb,var(--accent) 7%,var(--bg2));}
.dz-over .dz-rect{stroke:var(--accent);stroke-width:2;animation:dz-ants 1s linear infinite;}
.dz-arrow{transition:transform var(--d-state) var(--e-out),box-shadow var(--d-state) var(--e-out);}
.dz-over .dz-arrow{transform:translateY(-7px) scale(1.07);
  box-shadow:0 14px 34px -10px color-mix(in srgb,var(--accent) 70%,transparent);}
/* 提示文案在"拖进来"和"松手"之间交叉切换，两层叠在同一格 */
.dz-swap{position:relative;display:grid;}
.dz-swap>*{grid-area:1/1;transition:opacity var(--d-state) var(--e-out),transform var(--d-state) var(--e-out);}
.dz-swap>.on-drag{opacity:0;transform:translateY(7px);}
.dz-over .dz-swap>.on-idle{opacity:0;transform:translateY(-7px);}
.dz-over .dz-swap>.on-drag{opacity:1;transform:none;}

/* —— 完成勾号：自己画出来 —— */
@keyframes ok-draw{to{stroke-dashoffset:0;}}
.ok-ring{stroke-dasharray:176;stroke-dashoffset:176;animation:ok-draw 520ms var(--e-out) forwards;}
.ok-check{stroke-dasharray:44;stroke-dashoffset:44;animation:ok-draw 300ms var(--e-out) 300ms forwards;}

/* —— 演示片段循环进度线：这段有多长、循环到哪了 —— */
.loop-track{position:relative;height:2px;border-radius:2px;background:var(--line);overflow:hidden;}
.loop-fill{position:absolute;inset:0;transform-origin:left;transform:scaleX(0);
  background:linear-gradient(90deg,var(--accent),#5ac8fa);border-radius:2px;}

/* —— 显影粒子画布：铺在处理面板底下，文字浮在上面 —— */
.develop-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}

@media(prefers-reduced-motion:reduce){
  .dz-over .dz-rect{animation:none;}
  .ok-ring,.ok-check{animation:none;stroke-dashoffset:0;}
  .dz-over .dz-arrow{transform:none;}
  .dz-swap>*{transition:opacity var(--d-state) linear;}
.dz-swap>.on-drag,.dz-over .dz-swap>.on-idle{transform:none;}
}

/* Clear, thin glass; refraction is suggested by the rim and reflected light. */
:root{--glass:rgba(255,255,255,.58);--glass-brd:rgba(255,255,255,.9);}
[data-theme="dark"]{--glass:rgba(24,26,29,.58);--glass-brd:rgba(255,255,255,.2);}
.ruhua-root{background:radial-gradient(ellipse at 80% 14%,rgba(104,173,199,.035),transparent 46%),var(--bg);}
.ruhua-root button,.ruhua-root a{touch-action:manipulation;}
.ruhua-root button{transition:transform 140ms var(--e-out),opacity 160ms,background 220ms,color 220ms;}
.ruhua-root button:active:not(:disabled){transform:scale(.97);}
.ruhua-root button:disabled{cursor:default;opacity:.48;}
.ruhua-root :focus-visible{outline:2px solid var(--accent);outline-offset:4px;}
.nav-bar{box-shadow:inset 0 1px 0 var(--glass-brd),0 6px 30px rgba(20,40,55,.025)!important;}
.nav-tab{position:relative;padding:17px 0!important;}
.nav-tab[aria-current="page"]::after{content:"";position:absolute;left:15%;right:15%;bottom:9px;height:2px;border-radius:3px;background:var(--accent);animation:line-open .38s var(--e-out);}
.liquid-thumb,.dock-thumb{transition:transform 420ms var(--e-out);animation:none;background-size:auto;overflow:hidden;}
.liquid-thumb{background:linear-gradient(150deg,#7fcbf7 0%,#2593e9 42%,#0874c7 76%,#58b8ed 100%);box-shadow:inset 0 1px 1px #e2f7ff,inset 0 -2px 4px #004d8b55,0 5px 12px #167bbc30;border:1px solid #ffffff70;}
.liquid-thumb::after,.dock-thumb::after{animation:none;transform:translateX(0);background:linear-gradient(175deg,#ffffff70,transparent 42%,#ffffff15 75%,#ffffff40);}
.glass-reflect::after{animation:none;filter:none;transform:translateX(0);width:100%;background:linear-gradient(110deg,#ffffff0a,transparent 45%,#ffffff10);}
.glass-reflect::before{opacity:.32;}
.source-track{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));position:relative;border-radius:23px;padding:5px;background:color-mix(in srgb,var(--track) 55%,transparent);border:1px solid var(--line);isolation:isolate;}
.source-drop{position:absolute;left:5px;top:5px;bottom:5px;width:calc((100% - 10px)/3);border-radius:19px;transition:transform 460ms var(--e-out);background:linear-gradient(145deg,color-mix(in srgb,var(--card) 95%,white),color-mix(in srgb,var(--card) 72%,transparent));border:1px solid var(--glass-brd);box-shadow:inset 0 1px 1px #ffffff80,inset 0 -1px 2px #78909c18,0 5px 15px #142f4710;z-index:-1;}
.src-card{min-width:0;border:0;background:none;padding:17px 8px;border-radius:19px;color:var(--ink2);}
.src-card strong{display:block;font-size:16px;margin-bottom:6px;font-weight:600;}
.src-card span{font-size:11px;letter-spacing:.015em;}
.src-card[aria-pressed="true"]{color:var(--accent);}
.compute-panel{margin:0 0 34px;padding:24px;border:1px solid var(--line);border-radius:29px;background:linear-gradient(135deg,var(--glass),transparent);box-shadow:inset 0 1px 0 var(--glass-brd),0 15px 40px #12344404;}
.compute-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;color:var(--ink2);margin:0 3px 16px;}
.backend-form{display:flex;align-items:center;gap:9px;margin:18px 4px 0;}
.backend-form label{font-size:12px;color:var(--ink2);white-space:nowrap;}
.backend-form input{flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:12px inherit;color:var(--ink);background:var(--glass);}
.backend-form button{border:1px solid var(--line);border-radius:12px;background:var(--glass);color:var(--ink);padding:10px 13px;white-space:nowrap;}
.compute-note{font-size:12px;color:var(--ink3);line-height:1.7;margin:13px 4px 0;}
.field-error{font-size:12px;color:#b24d39;}
.create-heading{text-align:center;margin-bottom:36px;}
.eyebrow{font-size:11px;letter-spacing:.25em;color:var(--ink3);margin:0 0 17px;}
.create-heading h1{font-size:clamp(32px,5vw,52px);font-weight:600;letter-spacing:-.03em;margin:0 0 14px;}
.create-heading>p:last-child{font-size:16px;color:var(--ink2);}
.video-option{display:flex;align-items:center;justify-content:center;gap:9px;color:var(--ink2);font-size:13px;margin-top:25px;}
.dz{background:linear-gradient(130deg,var(--bg2),var(--bg));}
.develop-stage{padding:40px 24px 24px;background:linear-gradient(130deg,var(--bg2),var(--bg));border:1px solid var(--line);border-radius:29px;}
.develop-painting{margin:0 auto 28px;max-width:100%;}
.develop-mat{padding:clamp(9px,2vw,17px);border-radius:4px;border:1px solid color-mix(in srgb,var(--line2) 50%,transparent);background:linear-gradient(140deg,#c4b79b,#6b6050 20%,#baad95 45%,#716652 82%,#c5b798);box-shadow:inset 0 0 0 3px #ffffff12,0 22px 45px -22px #0007;}
.develop-mat>div{box-shadow:0 0 0 4px #191b1850,inset 0 0 10px #0004;}
.develop-light{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,#ffffff14 50%,transparent 70%);transform:translateX(-100%);animation:painting-light 5s ease-in-out 2.4s 3;pointer-events:none;}
.develop-caption{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;font-size:14px;color:var(--ink);}
.develop-time{font-size:12px;color:var(--ink3);font-variant-numeric:tabular-nums;letter-spacing:.04em;}
.status-orb{width:7px;height:7px;background:var(--accent);border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent);}
.creation-error{margin-top:24px;padding:20px;border-radius:18px;border:1px solid #bd623433;background:#bd623408;color:#a34d2e;font-size:14px;text-align:center;}
.creation-error button{padding:10px 20px;border:0;background:var(--accent);color:white;border-radius:99px;}
@keyframes painting-light{to{transform:translateX(100%);}}
@keyframes page-appear{from{opacity:0;transform:translate3d(0,15px,0) scale(.995);}to{opacity:1;transform:none;}}
@keyframes page-open{from{opacity:0;transform:translate3d(15px,0,0);}to{opacity:1;transform:none;}}
@keyframes line-open{from{transform:scaleX(0);}to{transform:scaleX(1);}}
.page-enter{animation:page-appear 480ms var(--e-out) both;}
.page-enter[data-page="studio"]{animation-name:page-open;}
.page-enter[data-page="enhance"]{animation-duration:580ms;}
.gallery-grid>div{transition:opacity .5s var(--e-out),transform .5s var(--e-out),box-shadow .3s;}
.gallery-grid>div:hover{transform:translateY(-4px);box-shadow:0 14px 36px #172e4210;}
@media(max-width:640px){.compute-panel{padding:16px;}.backend-form{flex-wrap:wrap;}.backend-form label{width:100%;}.src-card span{font-size:9px;}.develop-stage{padding:24px 12px;}.nav-logo .brand-detail{display:none;}}
@media(prefers-reduced-motion:reduce){.page-enter,.img-pop,.liquid-thumb::after,.dock-thumb::after,.glass-reflect::after,.develop-light{animation:none!important;}.liquid-thumb,.dock-thumb,.source-drop{transition:opacity .16s!important;}.reveal,.reveal-stagger>*{opacity:1;transform:none;transition:opacity .2s;}.gallery-grid>*,.gallery-grid.in>*{opacity:1;transform:none;transition:opacity .2s;}.tw-caret{animation:none!important;}}

/* Layered clear glass: crisp edge caustics over a lightly transmitted surface. */
.ruhua-root{--surface-tint:rgba(255,255,255,.44);--surface-rim:rgba(255,255,255,.86);--surface-shadow:rgba(39,65,81,.065);}
[data-theme="dark"].ruhua-root{--surface-tint:rgba(43,47,51,.38);--surface-rim:rgba(255,255,255,.23);--surface-shadow:rgba(0,0,0,.26);}
.liquid-surface,.compute-panel{position:relative;isolation:isolate;background:linear-gradient(145deg,var(--surface-tint),color-mix(in srgb,var(--surface-tint) 35%,transparent));border:1px solid color-mix(in srgb,var(--line) 80%,transparent);box-shadow:inset 0 1px 1px var(--surface-rim),inset 0 -1px 1px #68879b14,0 8px 26px var(--surface-shadow);}
.liquid-surface::before,.compute-panel::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;background:radial-gradient(ellipse at var(--pointer-x,15%) var(--pointer-y,0%),#ffffff55,transparent 62%),linear-gradient(170deg,#ffffff14,transparent 50%,#90b8ce08);}
.liquid-surface::after,.compute-panel::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;background:linear-gradient(145deg,var(--surface-rim),transparent 26%,#c8e4f322 55%,var(--surface-rim));-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;}
@supports(backdrop-filter:blur(1px)){.liquid-surface,.compute-panel{backdrop-filter:blur(6px) saturate(135%);-webkit-backdrop-filter:blur(6px) saturate(135%);}}
.nav-bar{background:color-mix(in srgb,var(--glass) 78%,transparent)!important;backdrop-filter:blur(9px) saturate(165%)!important;-webkit-backdrop-filter:blur(9px) saturate(165%)!important;border-bottom-color:color-mix(in srgb,var(--line) 45%,transparent)!important;}
.source-track{grid-template-columns:repeat(2,minmax(0,1fr));background:color-mix(in srgb,var(--track) 50%,transparent);}
.source-drop{width:calc((100% - 10px)/2);background:linear-gradient(158deg,#ffffffb8,#ffffff18 48%,#d5eef32b 76%,#ffffff94);border-color:var(--surface-rim);box-shadow:inset 1px 1px 2px var(--surface-rim),inset -1px -1px 2px #abc2d73b,0 3px 10px #2e546212;backdrop-filter:blur(3px) saturate(180%);}
[data-theme="dark"] .source-drop{background:linear-gradient(158deg,#ffffff28,#ffffff09 48%,#96dbff12 76%,#ffffff23);}
.liquid-thumb{background:linear-gradient(160deg,#a5e0fadb,#439fe2e3 40%,#0874c7ea 76%,#86d6f3dd);box-shadow:inset 1px 1px 1px #f0fcffdf,inset -1px -1px 3px #0e6ba480,0 4px 10px #167bbc24;}
.seg-btn[aria-pressed="true"]{text-shadow:0 1px 2px #11568628;}
.home-hero{position:relative;}
.home-hero::before{content:"";position:absolute;pointer-events:none;top:0;left:10%;right:10%;height:450px;z-index:0;background:radial-gradient(ellipse at 60% 10%,#addde71a,transparent 63%);}
.home-hero>*{position:relative;}
.home-title .hero-letter{display:inline-block;}
.home-title.is-ready .hero-letter{animation:hero-letter 540ms var(--e-out) both;}
.hero-first-line{display:inline-block;}
@keyframes hero-letter{from{opacity:0;transform:translate3d(0,.32em,0) rotate(2deg);}to{opacity:1;transform:none;}}
.reveal,.reveal-stagger>*{transition-timing-function:var(--e-out);transition-duration:660ms;}
.reveal-unfold{transform:translate3d(0,22px,0) scale(.965);transform-origin:50% 80%;}
.reveal-stagger.reveal-unfold>*{transform:translate3d(0,30px,0) rotate(-1deg) scale(.97);transform-origin:50% 100%;}
.reveal-stagger.reveal-unfold>*:nth-child(2){transform:translate3d(0,42px,0) scale(.97);}
.reveal-stagger.reveal-unfold>*:nth-child(3){transform:translate3d(0,30px,0) rotate(1deg) scale(.97);}
.reveal-stagger.reveal-drift>*:first-child{transform:translate3d(-28px,0,0);}
.reveal-stagger.reveal-drift>*:nth-child(2){transform:translate3d(28px,0,0) scale(.98);}
.reveal-focus{transform:translate3d(0,8px,0) scale(.985);}
.reveal.in,.reveal-stagger.in>*,.reveal-stagger.reveal-unfold.in>*,.reveal-stagger.reveal-drift.in>*{transform:none;opacity:1;}
.step-card{overflow:hidden;}
.step-card::before{transition:opacity 240ms;opacity:.65;}
.step-card:hover::before{opacity:1;}
.step-number{display:inline-flex;align-items:center;height:32px;margin-bottom:19px;font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:.16em;color:var(--accent);}
.step-number::after{content:"";width:34px;height:1px;background:currentColor;opacity:.26;margin-left:13px;transform-origin:left;transition:transform 380ms var(--e-out);}
.step-card:hover .step-number::after{transform:scaleX(1.65);}
.step-card:hover{box-shadow:inset 0 1px 1px var(--surface-rim),0 13px 28px var(--surface-shadow);}
.motion-chips>button{opacity:0;transform:translateY(10px);box-shadow:inset 0 1px 0 #ffffff30,0 3px 7px #0002;}
.in .motion-chips>button{opacity:1;transform:none;transition:opacity 480ms var(--e-out),transform 480ms var(--e-out),background 180ms;}
.in .motion-chips>button:hover{transform:translateY(-3px);background:#ffffff22!important;}
.beam-section img{transition:transform 900ms var(--e-out);}
.beam-section:hover img{transform:scale(1.025);}
.closing-section{position:relative;overflow:hidden;}
.closing-section::before{content:"";position:absolute;pointer-events:none;width:480px;height:220px;left:calc(50% - 240px);top:20px;background:radial-gradient(ellipse,#a0d0db1b,transparent 68%);}
.doubao-settings{border-radius:22px;margin:0 0 26px;text-align:left;overflow:hidden;}
.doubao-summary{width:100%;display:flex;align-items:center;gap:12px;padding:17px 20px;border:0;background:none;color:var(--ink);text-align:left;}
.doubao-summary strong{display:block;font-size:14px;font-weight:600;margin-bottom:5px;}
.doubao-summary>span:nth-child(2)>span{display:block;font-size:12px;color:var(--ink3);}
.doubao-emblem{width:34px;height:34px;display:grid;place-items:center;border-radius:12px;font-size:19px;color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent);box-shadow:inset 0 1px 1px var(--surface-rim);}
.doubao-badge{margin-left:auto;font-size:11px;padding:5px 9px;border-radius:99px;color:var(--ink2);border:1px solid var(--line);}
.doubao-chevron{font-size:17px;line-height:1;transition:transform 220ms var(--e-out);}
.doubao-fields{padding:0 20px 20px;}
.doubao-fields fieldset{border:0;margin:0;padding:0;min-width:0;}
.doubao-options{display:flex;gap:22px;padding:4px 0 10px;font-size:13px;color:var(--ink2);flex-wrap:wrap;}
.doubao-options label{display:flex;align-items:center;gap:7px;cursor:pointer;}
.doubao-options input{accent-color:var(--accent);}
.doubao-credentials{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:10px;}
.doubao-credentials label{font-size:12px;color:var(--ink2);}
.doubao-credentials label>span{color:var(--ink3);margin-left:5px;}
.doubao-credentials input{display:block;width:100%;margin-top:7px;border:1px solid var(--line2);border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--card) 65%,transparent);color:var(--ink);font:12px inherit;}
.doubao-credentials p{grid-column:1/-1;margin:0;font-size:11px;color:var(--ink3);line-height:1.7;}
.doubao-clear{justify-self:start;border:0;background:none;color:var(--accent);font-size:12px;padding:2px 0;}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
.gallery-storage-note{font-size:12px;line-height:1.8;color:var(--ink3);margin:0 0 24px;}
.gallery-save-status{text-align:center;margin:24px auto 0;max-width:650px;font-size:13px;color:var(--ink2);}
.gallery-save-status.local,.gallery-cache-label.local{color:#329668;}
.gallery-save-status.partial,.gallery-cache-label.partial{color:#ac713b;}
.gallery-save-status p{font-size:11px;line-height:1.8;color:var(--ink3);margin:8px 0 0;}
.gallery-save-status button,.gallery-save-button{border:0;background:none;color:var(--accent);font-size:12px;padding:10px 0 0;}
.gallery-empty{text-align:center;padding:60px 24px;border:1px dashed var(--line2);border-radius:26px;color:var(--ink3);}
.gallery-empty p{font-size:17px;margin:0 0 24px;}
.gallery-empty button{border:0;border-radius:99px;background:var(--accent);color:white;padding:12px 26px;font-size:14px;}
.gallery-card{background:var(--card);border:1px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:0 12px 32px -20px #0003;}
.gallery-picture{aspect-ratio:4/3;position:relative;overflow:hidden;background:#101215;}
.gallery-preview-button{display:block;width:100%;height:100%;padding:0;border:0;background:none;}
.gallery-placeholder{width:100%;height:100%;display:grid;place-items:center;color:#90969d;font-size:13px;}
.gallery-favorite{position:absolute;top:10px;right:10px;border:0;border-radius:99px;width:32px;height:32px;background:#0006;backdrop-filter:blur(6px);font-size:15px;}
.gallery-meta{display:flex;justify-content:space-between;font-size:12px;color:var(--ink3);}
.gallery-cache-label{font-size:11px;line-height:1.6;color:var(--ink3);margin:12px 0 0;}
.gallery-cache-error{font-size:11px;line-height:1.7;color:var(--ink3);margin:6px 0 0;}
.gallery-actions{display:flex;gap:10px;margin-top:14px;}
.gallery-actions button{border:1px solid var(--line);border-radius:99px;background:var(--card);color:var(--ink3);padding:9px 14px;font-size:13px;}
.gallery-actions button:first-child{flex:1;border:0;background:var(--accent);color:white;}
@media(max-width:640px){.home-hero{padding-top:42px!important;}.doubao-credentials{grid-template-columns:1fr;}.doubao-summary{padding:16px;}.doubao-summary strong{font-size:13px;}.doubao-summary>span:nth-child(2)>span{font-size:11px;}.step-cards{gap:12px!important;}.beam-section{gap:24px!important;}.motion-section{padding:60px 20px!important;}}
@media(prefers-reduced-motion:reduce){.home-title.is-ready .hero-letter{animation:none;}.reveal-unfold,.reveal-focus,.reveal-stagger.reveal-unfold>*,.reveal-stagger.reveal-drift>*{transform:none!important;opacity:1;}.motion-chips>button{opacity:1;transform:none;transition:opacity .2s;}.beam-section:hover img{transform:none;}.step-number::after{transition:none;}}
`;

// —— 滚动渐显 Hook：返回 ref，元素进入视口时自动加 .in ——
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { el.classList.add("in"); return; }
    const io = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

// —— 打字机组件：把整句逐字打出，结束后保留闪烁光标 ——
function Typewriter({ text, speed = 90, startDelay = 200, style = undefined, showCaret = true, start = true }) {
  const [n, setN] = useState(0);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!start) return;
    if (prefersReduced()) { setN(text.length); return; } // 等 start 为真才开始计时（如等开屏加载结束）
    const t = setTimeout(() => setStarted(true), startDelay);
    return () => clearTimeout(t);
  }, [startDelay, start]);
  useEffect(() => {
    if (!started || n >= text.length) return;
    const t = setTimeout(() => setN((x) => x + 1), speed);
    return () => clearTimeout(t);
  }, [started, n, text, speed]);
  // 支持用 | 分隔的换行
  const shown = text.slice(0, n);
  const parts = shown.split("|");
  return (
    <span style={style}>
      {parts.map((p, i) => (<span key={i}>{p}{i < parts.length - 1 && <br />}</span>))}
      {showCaret && n < text.length && <span className="tw-caret" />}
    </span>
  );
}

// —— dock 白色液态滑块切换（深色背景悬浮，用于演示视频/3D 上方）——
function followGlassPointer(event: { currentTarget: HTMLElement; clientX: number; clientY: number }) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--pointer-x", `${Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * 100)}%`);
  event.currentTarget.style.setProperty("--pointer-y", `${Math.round((event.clientY - rect.top) / Math.max(1, rect.height) * 100)}%`);
}
function DockToggle({ options, value, onChange }) {
  const wrapRef = useRef(null);
  const [thumb, setThumb] = useState({ left: 5, width: 0, ready: false });
  const idx = Math.max(0, options.findIndex((o) => o.id === value));
  const measure = useCallback(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const btn = wrap.querySelectorAll(".seg-btn")[idx]; if (!btn) return;
    setThumb({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
  }, [idx]);
  useEffect(() => { measure(); }, [measure, value, options.length]);
  useEffect(() => { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }, [measure]);
  return (
    <div ref={wrapRef} className="liquid-toggle dock-toggle" data-tone="dark" onPointerMove={followGlassPointer} style={{
      position: "relative", display: "inline-flex", gap: 4, padding: 5, borderRadius: 980,
      background: "rgba(0,0,0,0.5)", WebkitBackdropFilter: "blur(8px)", backdropFilter: "blur(8px)",
      border: "1px solid rgba(255,255,255,0.12)",
    }}>
      {thumb.ready && thumb.width > 0 && <span className="dock-thumb" style={{ left: 0, width: 100, transform: `translate3d(${thumb.left}px,0,0) scaleX(${thumb.width / 100})`, transformOrigin: "left" }} />}
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} className="seg-btn" aria-pressed={active} onClick={() => onChange(o.id)} style={{
            borderRadius: 980, padding: "9px 22px", fontSize: 14,
            color: active ? "#1d1d1f" : "#d2d2d7", fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// —— 液态玻璃胶囊切换：滑块在选项间流动滑移，高光游动 ——
// options: [{id,label,sub?}]，value=当前id，onChange(id)
// tone: "light"(浅底，用于页面) | "dark"(深色玻璃，用于视频/3D 上方悬浮)
function LiquidToggle({ options, value, onChange, tone = "light", size = "md", reflect = false }) {
  const wrapRef = useRef(null);
  const [thumb, setThumb] = useState({ left: 3, width: 0, ready: false });
  const idx = Math.max(0, options.findIndex((o) => o.id === value));

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const btn = wrap.querySelectorAll(".seg-btn")[idx];
    if (!btn) return;
    setThumb({ left: btn.offsetLeft, width: btn.offsetWidth, ready: true });
  }, [idx]);

  useEffect(() => { measure(); }, [measure, options.length, value]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const pad = size === "sm" ? "7px 16px" : size === "lg" ? "11px 26px" : "9px 20px";
  const fontSize = size === "sm" ? 13 : 14;
  const trackBg = tone === "dark" ? "rgba(0,0,0,0.5)" : "var(--track)";
  const trackBrd = tone === "dark" ? "1px solid rgba(255,255,255,0.12)" : "1px solid var(--line)";
  const idleColor = tone === "dark" ? "#d2d2d7" : "var(--ink2)";

  return (
    <div ref={wrapRef} className={"liquid-toggle" + (reflect ? " glass-reflect" : "")} data-tone={tone} onPointerMove={followGlassPointer} style={{
      position: "relative", display: "inline-flex", padding: 3, gap: 3, borderRadius: 980,
      background: trackBg, border: trackBrd,
      WebkitBackdropFilter: tone === "dark" ? "blur(8px)" : undefined, backdropFilter: tone === "dark" ? "blur(8px)" : undefined,
    }}>
      {thumb.ready && thumb.width > 0 && (
        <span className="liquid-thumb" style={{ left: 0, width: 100, transform: `translate3d(${thumb.left}px,0,0) scaleX(${thumb.width / 100})`, transformOrigin: "left" }} />
      )}
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} className="seg-btn" aria-pressed={active} onClick={() => onChange(o.id)} style={{
            borderRadius: 980, padding: pad, fontSize, lineHeight: 1.15, textAlign: "center",
            color: active ? "#fff" : idleColor, fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
          }}>
            {o.label}
            {o.sub && <span style={{ display: "block", fontSize: fontSize - 2, fontWeight: 400, opacity: active ? 0.9 : 0.7, marginTop: 1 }}>{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Completion mark draws only once; reduced motion shows its final state.
// ============================================================
function OkMark({ size = 56 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle className="ok-ring" cx="32" cy="32" r="28"
        stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round"
        transform="rotate(-90 32 32)" />
      <path className="ok-check" d="M20 33.5 L28.5 42 L44 24"
        stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============================================================
// 片门（拖拽区）
// ------------------------------------------------------------
// 职责：确认"文件已经被接住了"。虚线边框改成 SVG 蚁行线，
// 箭头上浮、底色染上主色、文案换成"松手即可显影"。
// 只动 transform / opacity / stroke，不碰布局属性。
// ============================================================
function DropZone({ onFile }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);   // dragenter/leave 会在子元素上乱跳，用计数器压掉抖动

  const reset = () => { depth.current = 0; setOver(false); };

  return (
    <label
      className={"dz" + (over ? " dz-over" : "")}
      onDragEnter={(e) => { e.preventDefault(); depth.current += 1; setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={(e) => {
        e.preventDefault();
        depth.current -= 1;
        if (depth.current <= 0) reset();
      }}
      onDrop={(e) => {
        e.preventDefault();
        reset();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      style={{
        display: "grid", placeItems: "center", gap: 12, minHeight: 380, cursor: "pointer",
        borderRadius: 28, textAlign: "center", padding: 48,
      }}
    >
      <svg className="dz-frame" preserveAspectRatio="none">
        <rect className="dz-rect" width="100%" height="100%" rx="28" ry="28" />
      </svg>

      <input type="file" accept="image/*,.heic" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />

      <div className="dz-arrow" style={{
        width: 56, height: 56, borderRadius: 999, background: "var(--accent)", color: "#fff",
        display: "grid", placeItems: "center", fontSize: 26, marginBottom: 4,
      }}>↑</div>

      <div className="dz-swap" style={{ fontSize: 24, fontWeight: 600 }}>
        <span className="on-idle">拖拽照片到这里</span>
        <span className="on-drag" style={{ color: "var(--accent)" }}>松手即可显影</span>
      </div>

      <div className="dz-swap" style={{ color: "var(--ink3)", fontSize: 15 }}>
        <span className="on-idle">或轻点选择 · 支持 jpg / png / webp / heic · 单张 ≤ 20MB</span>
        <span className="on-drag">松开鼠标，上传并开始重建</span>
      </div>

      <span style={{ marginTop: 10, padding: "12px 28px", borderRadius: 980, background: "var(--accent)", color: "#fff", fontSize: 15 }}>选择照片</span>
    </label>
  );
}

// ============================================================
// 顶部导航
// ============================================================
// Windows 客户端安装包：随站点一起发布（见 desktop/README.md）。
const DESKTOP_DOWNLOAD = "/download/PixelReconstruction-Setup.exe";

function DesktopDownload() {
  // 在客户端里（__PIXEL_DESKTOP__ 由客户端注入）不再提示下载
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(!(window as Window & { __PIXEL_DESKTOP__?: unknown }).__PIXEL_DESKTOP__); }, []);
  if (!show) return null;
  return <a className="nav-download" href={DESKTOP_DOWNLOAD} download title="下载 Windows 客户端（Windows 10/11，64 位）">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10.5 M7.5 10.5 12 15l4.5-4.5 M5 19.5h14" /></svg>
    <span>Windows 客户端</span>
  </a>;
}

function Nav({ page, setPage, theme, toggleTheme, onShowcase, logoReady = true }) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabRect, setTabRect] = useState({ x: 0, width: 0 });
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>('[aria-current="page"]');
      if (active) setTabRect({ x: active.offsetLeft - 10, width: active.offsetWidth + 20 });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, [page]);
  const tabs = [
    ["home", "概览"], ["create", "创作"], ["studio", "工作室"],
    ["enhance", "修图"], ["gallery", "作品库"],
  ];
  return (
    <nav className="nav-bar" onPointerMove={followGlassPointer} style={{
      position: "sticky", top: 0, zIndex: 100, background: "var(--glass)",
      WebkitBackdropFilter: "saturate(145%) blur(9px)", backdropFilter: "saturate(145%) blur(9px)",
      borderBottom: "1px solid var(--nav-brd)", boxShadow: "inset 0 1px 0 var(--glass-brd)",
    }}>
      {/* id 给开屏 logo 当落点用；开屏飞行期间这里先空着，避免重影 */}
      <button id="ruhua-nav-logo" className="nav-logo" aria-label="Pixel Reconstruction，返回三维展示" onClick={onShowcase} style={{
        border: 0, background: "none", padding: 0, fontWeight: 600, color: "var(--ink)",
        opacity: logoReady ? 1 : 0,
      }}>
        <BrandMark size={27} /><span className="brand-name">Pixel Reconstruction</span>
      </button>
      <div className="nav-tabs" ref={tabsRef}>
        {tabRect.width > 0 && <span aria-hidden="true" className="nav-drop" style={{ transform: `translate3d(${tabRect.x}px,0,0) scaleX(${tabRect.width / 100})` }} />}
        {tabs.map(([id, label]) => (
          <button key={id} className="nav-tab" aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)} style={{
            border: 0, background: "none", padding: 0, letterSpacing: "0.02em",
            color: page === id ? "var(--ink)" : "var(--ink3)", transition: "color .2s",
          }}>{label}</button>
        ))}
      </div>
      <div className="nav-right">
        <DesktopDownload />
        <AuthorContact className="nav-contact" />
        <button className="nav-theme" onClick={toggleTheme} title="切换主题" aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} style={{
          border: "1px solid var(--line)", background: "var(--card)", borderRadius: 980,
          color: "var(--ink)", display: "grid", placeItems: "center",
        }}><MorphIcon icon={theme === "dark" ? ICON.sun : ICON.moon} size={16} strokeWidth={1.6} spring={SPRING} reducedMotion="user" /></button>
        <button className="nav-cta" onClick={() => setPage("create")} style={{
          border: 0, background: "var(--accent)", color: "#fff", fontWeight: 500, borderRadius: 980,
        }}>开始创作</button>
      </div>
    </nav>
  );
}

// ============================================================
// 算力来源切换条（创作/工作室共用）
// ============================================================
function SourceBar({ source, setSource, conn, device, onReconnect, backend, onApply, busy = false }) {
  const order: Source[] = ["beam", "local"];
  const [draft, setDraft] = useState(backend);
  const [error, setError] = useState("");
  const [developer, setDeveloper] = useState(false);
  useEffect(() => setDeveloper(isLocalPage()), []);
  useEffect(() => { setDraft(backend); setError(""); }, [backend, source]);
  const statusText = busy ? "照片正在云端重建" : conn === "ok" ? "云端服务已就绪" : conn === "checking" ? "正在连接云端服务" : conn === "fail" ? "云端暂未连接，请稍后重试" : "正在检查云端服务";
  const color = conn === "ok" ? "#299d66" : conn === "fail" ? "#b77738" : "var(--ink3)";
  return <>
    <section className={"service-status" + (conn === "ok" ? " is-ready" : conn === "checking" ? " is-checking" : "")} aria-label="云端服务状态" role="status"><i aria-hidden="true" /><span>{statusText}</span>{conn === "fail" ? <button disabled={busy} onClick={onReconnect}>重新连接 ↻</button> : <small>READY WHEN YOU ARE</small>}</section>
    {developer && <details className="developer-settings"><summary>本地开发 · 高级设置</summary><section className="compute-panel" aria-label="本地开发设置">
    <div className="compute-heading"><span>开发服务</span><span style={{ color }}>{device || "未连接"}</span></div>
    <div className="source-track">
      <span className="source-drop" style={{ transform: `translate3d(${order.indexOf(source) * 100}%,0,0)` }} />
      {order.map(key => <button key={key} className="src-card" aria-pressed={source === key} disabled={busy} onClick={() => setSource(key)}>
        <strong>{SOURCE_META[key].name}</strong><span>{SOURCE_META[key].sub}</span>
      </button>)}
    </div>
    <form className="backend-form" onSubmit={e => {
      e.preventDefault();
      try { const normalized = normalizeBase(draft); onApply(normalized); setError(""); }
      catch (e) { setError(e instanceof Error ? e.message : "地址格式不正确"); }
    }}>
      <label htmlFor="backend-url">服务地址</label>
      <input id="backend-url" value={draft} type="url" placeholder={source === "beam" ? "https://你的服务.beam.cloud" : "https://你的服务地址"} disabled={busy} onChange={e => setDraft(e.target.value)} autoComplete="url" spellCheck={false} />
      <button disabled={busy || conn === "checking"} type="submit">应用</button>
      <button disabled={busy || conn === "checking" || !backend} type="button" onClick={onReconnect} aria-label="重新连接服务">↻</button>
    </form>
    <p className="compute-note">{busy ? "当前显影期间已锁定服务。" : "这些设置只在本地开发页面显示。"}</p>
    {error && <p role="alert" className="field-error">{error}</p>}
  </section></details>}
  </>;
}

// ============================================================
// 创作页：选算力 → 上传 → 显影
// ============================================================
function CreatePage({ source, setSource, conn, device, onDone, onReconnect, backend, onApply, onBusy, incoming = null, onIncomingTaken }: { incoming?: { file: File; id: number } | null; onIncomingTaken?: () => void; [key: string]: any }) {
  const [phase, setPhase] = useState("idle");
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [stage, setStage] = useState("");
  const [renderVideo, setRenderVideo] = useState(false);
  const generation = useRef(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<{ id: string; base: string; started: number } | null>(null);
  const busyRef = useRef(false);
  const stopTimers = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    pollRef.current = clockRef.current = null;
  }, []);
  useEffect(() => () => { generation.current++; stopTimers(); }, [stopTimers]);
  const fail = (message: string) => { stopTimers(); busyRef.current = false; setErrMsg(message); setPhase("error"); };
  function beginPolling(task: { id: string; base: string; started: number }, token: number) {
    let failures = 0;
    clockRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - task.started) / 1000)), 1000);
    const poll = async () => {
      if (token !== generation.current) return;
      if (Date.now() - task.started > 25 * 60 * 1000) { fail("等待超过 25 分钟。任务可能仍在云端运行，可继续查询原任务。"); return; }
      try {
        const st = await checkStatus(task.id, task.base);
        if (token !== generation.current) return;
        failures = 0;
        if (st.status === "done") {
          stopTimers(); busyRef.current = false; pendingRef.current = null; setPhase("done");
          onDone?.({ ...st, backend_url: task.base }); return;
        }
        if (st.status === "error") { pendingRef.current = null; fail(st.message || "显影失败，请重试。"); return; }
        setStage(st.status === "queued" ? "已排队 · 等待 GPU 唤醒" : st.stage || "高斯泼溅 · 显影中");
      } catch (e) {
        if (token !== generation.current) return;
        failures++;
        if (failures >= 4) { fail("暂时无法获取进度。可继续查询原任务，不会重复提交。" ); return; }
        setStage("连接暂时中断 · 正在重新查询");
      }
      pollRef.current = setTimeout(poll, 3000);
    };
    pollRef.current = setTimeout(poll, 1500);
  }
  async function handleFile(file: File) {
    if (busyRef.current) return;
    if (!backend) { fail("云端服务暂不可用，请稍后重试。"); return; }
    if (!isDevelopablePhoto(file)) { fail("请选择 20MB 以内的 jpg、png、webp 或 heic 图片。"); return; }
    const token = ++generation.current, taskBase = backend;
    stopTimers(); pendingRef.current = null; busyRef.current = true;
    setErrMsg(""); setElapsed(0); setPickedFile(file); setStage("照片上传中"); setPhase("uploading");
    announceMoment({ kind: "upload", file });
    const started = Date.now();
    clockRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    try {
      const { call_id } = await submitPhoto(file, renderVideo, false, taskBase, ({ sent, total, bytesPerSecond }) => {
        if (token !== generation.current) return;
        const mb = (n: number) => (n / 1048576).toFixed(1);
        const speed = bytesPerSecond >= 1048576 ? `${mb(bytesPerSecond)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`;
        setStage(total && sent < total ? `照片上传中 · ${mb(sent)} / ${mb(total)} MB · ${speed}` : "照片已上传 · 等待服务确认");
      });
      if (token !== generation.current) return;
      stopTimers(); setPhase("processing"); setStage("已接收 · 等待 GPU 唤醒");
      const task = { id: call_id, base: taskBase, started };
      pendingRef.current = task; beginPolling(task, token);
    } catch (e) { if (token === generation.current) fail(e instanceof Error ? e.message : "上传失败，请重试。"); }
  }
  const busy = phase === "uploading" || phase === "processing";
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  // A photo dropped on the companion arrives here and takes the same path as the drop zone.
  const handleFileRef = useRef(handleFile);
  handleFileRef.current = handleFile;
  useEffect(() => {
    if (!incoming) return;
    onIncomingTaken?.();
    void handleFileRef.current(incoming.file);
  }, [incoming, onIncomingTaken]);
  return <main style={{ maxWidth: 1024, margin: "0 auto", padding: "64px 24px 64px" }}>
    <header className="create-heading"><h1>从这张照片开始。</h1><p>上传一张图片，云端将为它重建三维场景。</p></header>
    <SourceBar source={source} setSource={setSource} conn={conn} device={device} onReconnect={onReconnect} backend={backend} onApply={onApply} busy={busy} />
    {!busy && phase !== "done" && <>
      <DropZone onFile={handleFile} />
      <label className="video-option"><input type="checkbox" checked={renderVideo} onChange={e => setRenderVideo(e.target.checked)} />同时生成云端运镜视频（耗时和费用会增加）</label>
      <p className="compute-note" style={{ textAlign: "center" }}>也可以在 3D 工作室里直接导出视频。</p>
    </>}
    {busy && <section className="develop-stage" aria-busy="true">
      <DevelopPainting file={pickedFile} />
      <div className="develop-caption" role="status" aria-live="polite"><span className="status-orb" /><span key={stage.split(" · ")[0]} className="img-pop">{stage}</span><span className="develop-time">{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span></div>
      <p className="compute-note" style={{ textAlign: "center" }}>首次唤醒可能需要几分钟。画面展示显影过程，任务状态以云端返回为准。</p>
    </section>}
    {phase === "done" && <div style={{ textAlign: "center", padding: 40 }}><OkMark /><p>显影完成，已保存到作品库。</p></div>}
    {phase === "error" && <div className="creation-error" role="alert"><p>{errMsg}</p><button onClick={() => {
      const task = pendingRef.current;
      if (task) { task.started = Date.now(); busyRef.current = true; setPhase("processing"); setErrMsg(""); beginPolling(task, ++generation.current); }
      else setPhase("idle");
    }}>{pendingRef.current ? "继续查询原任务" : "重新选择照片"}</button></div>}
  </main>;
}

// ============================================================
// 工作室页：3D 场景 + 运镜（SplatViewer 自带运镜栏）+ 导出
// ============================================================
function StudioPage({ result, setPage, conn, device, onLoadFull }) {
  const [tab, setTab] = useState("splat"); // splat | video
  const poster = useScenePoster(result);

  if (!result) {
    return (
      <main style={{ maxWidth: 900, margin: "0 auto", padding: "76px 24px 64px", textAlign: "center" }}>
        <h1 style={{ fontSize: "clamp(28px,5vw,48px)", fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 16 }}>查看与编排场景。</h1>
        <p style={{ color: "var(--ink2)", fontSize: 17, marginBottom: 32 }}>还没有显影好的场景。先去创作页上传一张照片。</p>
        <button onClick={() => setPage("create")} style={{ border: 0, background: "var(--accent)", color: "#fff", padding: "12px 26px", borderRadius: 980, fontSize: 15 }}>去创作</button>
      </main>
    );
  }

  const plyHref = result.offline_ply_url || fileUrl(result.job_id, result.ply_file, result.backend_url);
  const isMobilePreview = result.viewer_quality === "mobile";
  const viewerHref = isMobilePreview
    ? result.offline_mobile_url || ""
    : result.offline_viewer_url || result.offline_ply_url || fileUrl(result.job_id, result.viewer_file || result.ply_file, result.backend_url);
  const sceneFormat = isMobilePreview || result.offline_viewer_url ? "splat" : result.offline_ply_url ? "ply" : result.viewer_file ? "splat" : "ply";
  const videoHref = result.offline_video_url || (result.mp4_file ? fileUrl(result.job_id, result.mp4_file, result.backend_url) : "");
  const dlBtn = { textDecoration: "none", border: "1px solid var(--line)", background: "var(--card)", color: "var(--ink)", padding: "13px 26px", borderRadius: 980, fontSize: 15 };
  return (
    <main style={{ maxWidth: 1140, margin: "0 auto", padding: "76px 24px 72px" }}>
      <CompanionPageImage src={poster} />
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 32 }}>
        <div>
          <div style={{ fontSize: 15, color: "var(--ink3)", letterSpacing: "0.04em", marginBottom: 10 }}>工作室</div>
          <h1 style={{ fontSize: "clamp(32px,5vw,52px)", fontWeight: 600, letterSpacing: "-0.025em" }}>查看与编排场景。</h1>
        </div>
        {result.mp4_file && (
          <LiquidToggle
            tone="light" size="md"
            value={tab} onChange={setTab}
            options={[{ id: "splat", label: "3D 实时" }, { id: "video", label: "运镜视频" }]}
          />
        )}
      </div>

      {/* 画面区：3D 模式由 SplatViewer 自己管布局；视频模式用深色圆角盒 */}
      {tab === "splat" ? (
        <SplatViewer key={result.job_id} plyUrl={viewerHref} posterUrl={poster} previewQuality={isMobilePreview ? "mobile" : "full"} onAssetLoaded={blob => { if (!viewerHref.startsWith('blob:')) void cacheGalleryItem(result, { quality: "full", sceneBlob: blob }); }} sceneFormat={sceneFormat} jobId={result.job_id} backendUrl={result.backend_url} />
      ) : (
        <div style={{ borderRadius: 28, overflow: "hidden", border: "1px solid var(--line)", boxShadow: "var(--shadow)", background: "#04060a" }}>
          <video src={videoHref} controls autoPlay loop playsInline style={{ width: "100%", display: "block", background: "#04060a" }} />
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 12, marginTop: 16, fontSize: 13, color: "var(--ink2)" }}>
        <span>{isMobilePreview ? "离线 · 历史轻量缓存（细节有减少）" : "完整场景 · 保留全部模型点"}</span>
        {isMobilePreview && <button onClick={() => onLoadFull(result)} style={{ ...dlBtn, padding: "9px 18px", fontSize: 13 }}>联网后恢复完整场景</button>}
      </div>
      {result.restore_error && <p role="status" style={{ textAlign: "center", fontSize: 13, color: "var(--ink2)", marginTop: 10 }}>{result.restore_error}</p>}

      <GallerySaveStatus id={result.gallery_id || galleryId(result)} />
      {(result.offline_mobile_url || result.offline_viewer_url || result.offline_ply_url) && <p className="gallery-storage-note" style={{ textAlign: "center" }}>正在查看此浏览器保存的场景。</p>}
      {/* 导出与下载 */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 32 }}>
        <a href={plyHref} download={result.ply_file} style={dlBtn}>下载 .ply</a>
        {result.mp4_file && (
          <a href={videoHref} download={result.mp4_file} style={dlBtn}>下载视频</a>
        )}
        <button onClick={() => setPage("enhance")} style={{ ...dlBtn, border: "1px solid var(--line)", cursor: "pointer" }}>✦ 编辑原图</button>
        <button onClick={() => setPage("create")} style={{ border: 0, background: "var(--accent)", color: "#fff", padding: "13px 30px", borderRadius: 980, fontSize: 15 }}>上传新照片</button>
      </div>
      <p style={{ textAlign: "center", color: "var(--ink3)", fontSize: 13.5, marginTop: 28, maxWidth: "36em", marginLeft: "auto", marginRight: "auto", lineHeight: 1.7 }}>
        SHARP 是单图生成，适合在原视角附近进行小幅环绕、缓推与变焦。运镜序列与导出 mp4 在画面下方的运镜栏里操作。
      </p>
    </main>
  );
}

// ---------- 豆包修图预设（迁移自现有 page.tsx）----------
const AI_PRESETS = [
  { label: "扩图 25%", pad: 0.25, prompt: "这张图片的中心是一张原始照片，四周边缘是模糊的待补全区域。请把四周模糊区域补全为清晰、真实的场景延伸：透视、光线、色调、季节必须与中心原图完全一致，衔接处无缝过渡；中心原图区域保持原样不要改动。照片级写实，不要出现任何文字或水印。" },
  { label: "增加细节", pad: 0, prompt: "在完全保持构图、内容、光线与色调不变的前提下，提升这张照片的清晰度与细节质感：纹理更锐利、噪点更少、层次更丰富。不要改变任何物体、人物与色彩风格，照片级写实。" },
  { label: "增强光影", pad: 0, prompt: "轻微增强这张照片的光影层次与立体感：阴影过渡更深邃、高光更通透、明暗对比更有质感，整体保持自然真实，不改变构图与内容。" },
  { label: "电影感调色", pad: 0, prompt: "对这张照片做轻度电影感调色：青橙色调倾向、柔和的对比度、淡淡的胶片颗粒质感，氛围高级克制。完全不改变画面内容与构图。" },
  { label: "移除杂物", pad: 0, prompt: "移除画面中分散注意力的无关路人、杂物与瑕疵，用与周围环境完全一致的内容自然填补，其余部分保持原样不变，照片级写实。" },
  { label: "黄金时刻", pad: 0, prompt: "把这张照片的光线改为日落黄金时刻：温暖的低角度阳光、拉长的柔和阴影、金色氛围感，保持构图与所有物体不变，照片级写实。" },
];

// ============================================================
// 修图页：豆包对话式改图 + 引用版本 + 重新渲染
// ============================================================
function EnhancePage({ result, setPage, onRerenderDone, doubao, onDoubaoChange }: { result: any; setPage: (page: string) => void; onRerenderDone: (result: any) => void; doubao: DoubaoPreferences; onDoubaoChange: (value: DoubaoPreferences) => void }) {
  const companionOriginal = useScenePoster(result);
  const [chat, setChat] = useState([]);
  const [baseImg, setBaseImg] = useState("");   // 引用的版本作为下次基础
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [strength, setStrength] = useState<"gentle" | "balanced">("gentle");
  const [padDraft, setPadDraft] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const alive = useRef(true);
  const editBusy = useRef(false);
  const renderBusy = useRef(false);
  const rerenderPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (rerenderPoll.current) clearTimeout(rerenderPoll.current); }; }, []);
  const needsKey = doubao.mode === "custom" && !doubao.apiKey.trim();

  if (!result) {
    return (
      <main style={{ maxWidth: 900, margin: "0 auto", padding: "76px 24px 64px", textAlign: "center" }}>
        <h1 style={{ fontSize: "clamp(28px,5vw,48px)", fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 16 }}>豆包修图。</h1>
        <p style={{ color: "var(--ink2)", fontSize: 17, marginBottom: 32 }}>还没有可修的场景。先去创作页显影一张。</p>
        <DoubaoSettings value={doubao} onChange={onDoubaoChange} />
        <button onClick={() => setPage("create")} style={{ border: 0, background: "var(--accent)", color: "#fff", padding: "12px 26px", borderRadius: 980, fontSize: 15 }}>去创作</button>
      </main>
    );
  }

  async function sendEdit(display, prompt, pad) {
    if (editBusy.current || renderBusy.current || needsKey) return;
    editBusy.current = true;
    const ref = baseImg;
    setChat((c) => [...c, { role: "user", text: display, ref: ref || undefined }]);
    setAiBusy(true);
    try {
      const credentials = doubao.mode === "custom" ? { apiKey: doubao.apiKey.trim(), model: doubao.model.trim() || undefined } : undefined;
      const r = await editImage(result.job_id, prompt, pad, ref, history, result.backend_url, credentials, strength);
      if (!alive.current) return;
      setChat((c) => [...c, { role: "ai", img: r.image }]);
      setHistory((h) => [...h, display]);
      setBaseImg("");
    } catch (e) {
      setChat((c) => [...c, { role: "ai", failed: true, text: "修图失败：" + (e?.message || e) }]);
    }
    editBusy.current = false;
    if (alive.current) setAiBusy(false);
  }

  async function doRerender(img) {
    if (renderBusy.current || editBusy.current) return;
    renderBusy.current = true; setRerendering(true);
    const apiBase = result.backend_url || getBase(), started = Date.now();
    setChat(c => [...c, { role: "ai", text: "正在用这张图重新显影 3D 场景…" }]);
    const fail = (message: string) => {
      renderBusy.current = false;
      if (!alive.current) return;
      setRerendering(false); setChat(c => [...c, { role: "ai", failed: true, text: "重新显影失败：" + message }]);
    };
    try {
      const { call_id } = await requestRerender(result.job_id, img, apiBase);
      let failures = 0;
      const poll = async () => {
        if (!alive.current) return;
        if (Date.now() - started > 25 * 60 * 1000) { fail("等待超时，请稍后重试。"); return; }
        try {
          const st = await checkStatus(call_id, apiBase);
          if (!alive.current) return;
          failures = 0;
          if (st.status === "done") { renderBusy.current = false; setRerendering(false); onRerenderDone?.({ ...st, job_token: st.job_token || result.job_token, backend_url: apiBase }); return; }
          if (st.status === "error") { fail(st.message); return; }
        } catch (e) { if (++failures >= 4) { fail("无法连接服务，请检查网络后重试。"); return; } }
        rerenderPoll.current = setTimeout(poll, 3000);
      };
      rerenderPoll.current = setTimeout(poll, 2000);
    } catch (e) { fail(e instanceof Error ? e.message : "请求失败"); }
  }

  const btn = { border: "1px solid var(--line)", background: "var(--card)", color: "var(--ink)", padding: "7px 15px", borderRadius: 980, fontSize: 13, textDecoration: "none", cursor: "pointer" };

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "76px 24px 72px" }}>
      <CompanionPageImage src={companionOriginal} />
      <div style={{ fontSize: 15, color: "var(--ink3)", letterSpacing: "0.04em", marginBottom: 12 }}>豆包修图</div>
      <h1 style={{ fontSize: "clamp(30px,5vw,52px)", fontWeight: 600, letterSpacing: "-0.025em", marginBottom: 16, lineHeight: 1.12, minHeight: "2.3em" }}>
        <Typewriter text="先把图改到满意，|再重新显影成 3D。" speed={120} startDelay={300} />
      </h1>
      <p style={{ color: "var(--ink2)", fontSize: 18, marginBottom: 40, lineHeight: 1.6, maxWidth: "32em" }}>
        用自然语言连续改图，扩边、加细节、调色；满意后重新显影。扩图可以延伸画面，单张图片不能恢复被遮挡的背面，也不能保证完整 360° 场景。
      </p>

      <DoubaoSettings value={doubao} onChange={onDoubaoChange} disabled={aiBusy || rerendering} />
      {needsKey && <p className="field-error">请先填写你的豆包 API Key，或切回站长提供的服务。</p>}
      <EditPromptPicker strength={strength} onStrengthChange={setStrength} disabled={aiBusy || rerendering} onSelect={(prompt, pad) => { setInput(prompt); setPadDraft(pad); }} />

      {/* 对话流（更大留白，图片醒目）*/}
      <div style={{ border: "1px solid var(--line)", borderRadius: 26, background: "var(--bg2)", padding: 26, minHeight: 280 }}>
        <button onClick={() => setBaseImg("original.jpg")} style={{ ...btn, marginBottom: 20 }}>引用原图</button>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {chat.map((m, i) =>
            m.role === "user" ? (
              <div key={i} style={{ alignSelf: "flex-end", maxWidth: "78%", background: "var(--accent)", color: "#fff", padding: "13px 20px", borderRadius: "20px 20px 5px 20px", fontSize: 15.5, lineHeight: 1.5, boxShadow: "0 6px 18px -8px rgba(0,113,227,0.5)" }}>
                {m.ref && <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 5 }}>↩ 基于 {m.ref === "original.jpg" ? "原图" : "上一版"}</div>}
                {m.text}
              </div>
            ) : m.img ? (
              <div key={i} className="img-pop" style={{ alignSelf: "flex-start", maxWidth: "82%" }}>
                <img src={fileUrl(result.job_id, m.img, result.backend_url)} alt={m.img} style={{ width: "100%", borderRadius: 18, display: "block", border: "1px solid var(--line)", boxShadow: "var(--shadow)" }} />
                <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <a href={fileUrl(result.job_id, m.img, result.backend_url)} download style={btn}>下载</a>
                  <button onClick={() => setBaseImg(m.img)} style={btn}>引用</button>
                  <button disabled={rerendering} onClick={() => doRerender(m.img)} style={{ ...btn, border: 0, background: "var(--accent)", color: "#fff", opacity: rerendering ? 0.5 : 1 }}>⟳ 重新渲染成 3D</button>
                </div>
              </div>
            ) : (
              <div key={i} role={m.failed ? "alert" : undefined} style={{ alignSelf: "flex-start", maxWidth: "78%", background: "var(--track)", color: "var(--ink2)", padding: "13px 20px", borderRadius: "20px 20px 20px 5px", fontSize: 15, lineHeight: 1.5 }}>{m.text}</div>
            )
          )}
          {aiBusy && (
            <div style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 9, color: "var(--ink3)", fontSize: 14.5, padding: "10px 4px" }}>
              <PixelLoader size={14} style={{ color: "var(--ink2)" }} />
              豆包正在改图…
            </div>
          )}
          {chat.length === 0 && !aiBusy && (
            <div style={{ color: "var(--ink3)", fontSize: 15, textAlign: "center", padding: "30px 0" }}>
              点上面的预设，或在下方直接描述你想怎么改 ——
            </div>
          )}
        </div>
      </div>

      {/* 引用提示 + 输入（更大）*/}
      {baseImg && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 9, marginTop: 18, padding: "8px 16px", borderRadius: 980, background: "rgba(0,113,227,0.1)", color: "var(--accent)", fontSize: 14 }}>
          引用 {baseImg === "original.jpg" ? "原图" : "上一版"} 作为下一次修改的基础
          <button onClick={() => setBaseImg("")} style={{ border: 0, background: "none", color: "var(--accent)", fontSize: 17, lineHeight: 1, cursor: "pointer" }}>×</button>
        </div>
      )}
      {padDraft > 0 && <p className="compute-note">这次将向四周扩展 {Math.round(padDraft * 100)}% 画布。<button onClick={() => setPadDraft(0)} style={{ border: 0, background: "none", color: "var(--accent)", fontSize: 12 }}>取消扩图</button></p>}
      <div style={{ display: "flex", gap: 12, marginTop: 18, alignItems: "flex-end" }}>
        <textarea rows={input.length > 80 ? 6 : 3} aria-label="修图提示词"
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.trim() && !needsKey && !aiBusy && !rerendering) { e.preventDefault(); sendEdit(input.trim(), input.trim(), padDraft); setInput(""); setPadDraft(0); } }}
          placeholder="把光线改成日落黄金时刻，暖一点"
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 20, padding: "15px 18px", font: "inherit", fontSize: 14, lineHeight: 1.8, resize: "vertical", background: "var(--card)", color: "var(--ink)" }}
        />
        <button disabled={aiBusy || rerendering || needsKey || !input.trim()} onClick={() => { if (input.trim()) { sendEdit(input.trim(), input.trim(), padDraft); setInput(""); setPadDraft(0); } }} style={{ border: 0, background: "var(--accent)", color: "#fff", padding: "13px 22px", borderRadius: 980, fontSize: 14, whiteSpace: "nowrap", fontWeight: 500, opacity: (aiBusy || !input.trim()) ? 0.5 : 1, cursor: (aiBusy || !input.trim()) ? "default" : "pointer" }}>发送</button>
      </div>
    </main>
  );
}

// ============================================================
// 首页演示播放器：四个运镜视频 + dock 切换 + 循环
// ============================================================
const DEMO_VIDEOS = [
  { id: "orbit", name: "环绕", src: "/demo/demo-orbit.mp4", poster: "/demo/demo-orbit.jpg" },
  { id: "dolly", name: "缓推", src: "/demo/demo-dolly.mp4", poster: "/demo/demo-dolly.jpg" },
  { id: "arc", name: "弧推", src: "/demo/demo-arc.mp4", poster: "/demo/demo-arc.jpg" },
  { id: "zoom", name: "变焦", src: "/demo/demo-zoom.mp4", poster: "/demo/demo-zoom.jpg" },
];

// ============================================================
// 封面先显示，靠近视口后按需加载当前视频。
// ============================================================
function DemoPlayer({ innerRef, active: pageActive = true }) {
  const [active, setActive] = useState("orbit");
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [prefetch, setPrefetch] = useState("");
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const sectionRef = useRef<HTMLElement>(null);
  const vidRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const loopRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;
    const nearObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setNear(true); }, { rootMargin: "350px" });
    const visibleObserver = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { threshold: .12 });
    nearObserver.observe(element); visibleObserver.observe(element);
    return () => { nearObserver.disconnect(); visibleObserver.disconnect(); };
  }, []);
  useEffect(() => {
    if (near && pageActive) setRequested(r => r[active] ? r : { ...r, [active]: true });
  }, [near, pageActive, active]);
  useEffect(() => {
    if (!pageActive || !near || !ready[active]) return;
    const timer = setTimeout(() => {
      const next = DEMO_VIDEOS[(DEMO_VIDEOS.findIndex(v => v.id === active) + 1) % DEMO_VIDEOS.length].id;
      setPrefetch(next); setRequested(r => ({ ...r, [next]: true }));
    }, 1200);
    return () => clearTimeout(timer);
  }, [active, ready, near, pageActive]);
  useEffect(() => {
    Object.entries(vidRefs.current).forEach(([id, video]) => {
      if (!video) return;
      if (id === active && pageActive && visible && ready[active] && !prefersReduced()) video.play().catch(() => {});
      else video.pause();
    });
  }, [active, pageActive, visible, ready]);
  const choose = (id: string) => { setRequested(r => ({ ...r, [id]: true })); setActive(id); };
  return <section ref={el => { sectionRef.current = el; if (innerRef) innerRef.current = el; }} style={{ maxWidth: 1024, margin: "0 auto", padding: "54px 24px 28px" }}>
    <div style={{ position: "relative", borderRadius: 28, overflow: "hidden", background: "#0a0a0c", boxShadow: "var(--shadow)", border: "1px solid var(--line)" }}>
      <div style={{ position: "absolute", top: 18, left: 18, zIndex: 3, padding: "7px 14px", borderRadius: 980, background: "rgba(0,0,0,.38)", backdropFilter: "blur(6px)", color: "#f5f5f7", fontSize: 12 }}>高斯泼溅 · 运镜演示</div>
      <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 10" }}>
        {DEMO_VIDEOS.map(v => <div key={v.id} style={{ position: "absolute", inset: 0, opacity: v.id === active ? 1 : 0, transition: "opacity 380ms var(--e-out)", pointerEvents: v.id === active ? "auto" : "none" }}>
          <img src={v.poster} alt={v.name + "运镜预览"} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", position: "absolute", inset: 0 }} />
          <video ref={el => { vidRefs.current[v.id] = el; }} src={requested[v.id] ? v.src : undefined} poster={v.poster} muted loop playsInline
            preload={!pageActive ? "none" : v.id === active ? "auto" : v.id === prefetch ? "metadata" : "none"}
            onCanPlay={() => setReady(r => r[v.id] ? r : { ...r, [v.id]: true })}
            onError={() => setFailed(r => ({ ...r, [v.id]: true }))}
            onTimeUpdate={e => { const video = e.currentTarget; if (v.id === active && loopRef.current && video.duration) loopRef.current.style.transform = `scaleX(${video.currentTime / video.duration})`; }}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: ready[v.id] && !failed[v.id] ? 1 : 0, transition: "opacity 380ms var(--e-out)" }} />
        </div>)}
        {failed[active] && <span style={{ position: "absolute", bottom: 16, left: 16, color: "#fff", background: "#0007", borderRadius: 99, padding: "7px 13px", fontSize: 12 }}>视频暂不可用，正在展示预览图</span>}
      </div>
    </div>
    <div className="loop-track" style={{ marginTop: 14 }}><span ref={loopRef} className="loop-fill" /></div>
    <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}><LiquidToggle tone="light" size="md" reflect options={DEMO_VIDEOS.map(v => ({ id: v.id, label: v.name }))} value={active} onChange={choose} /></div>
  </section>;
}

function galleryStatus(item: Partial<GalleryItem>) {
  if (item.cacheState === "saving") return "正在保存到此浏览器…";
  if (item.cacheState === "local") return item.mobileReady && !item.viewerReady && !item.plyReady ? "已保存历史轻量缓存（非完整模型）" : "已保存在此浏览器";
  if (item.cacheState === "partial") return "未完整离线保存";
  return "仅有云端记录 · 可保存到此浏览器";
}

function GallerySaveStatus({ id }) {
  const [item, setItem] = useState<GalleryItem | undefined>();
  useEffect(() => {
    let alive = true;
    const refresh = () => { listGallery().then(items => { if (alive) setItem(items.find(item => item.id === id)); }); };
    refresh(); const unsubscribe = subscribeGallery(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [id]);
  if (!item) return null;
  return <div className={"gallery-save-status " + item.cacheState} role="status">
    <span>{item.cacheState === "local" ? "✓ " : ""}{galleryStatus(item)}</span>
    {item.cacheError && <p>{item.cacheError}</p>}
    {item.cacheState === "local" && <p>{item.persistent ? "浏览器已授予持久存储，不设自动到期时间。" : "已请求持久存储，浏览器尚未授予；可下载文件另存备份。"}</p>}
    {(item.cacheState === "remote" || item.cacheState === "partial") && <button onClick={() => { void cacheGalleryItem(item); }}>继续保存</button>}
  </div>;
}

function GalleryThumbnail({ item }: { item: GalleryItem }) {
  const [lookup, setLookup] = useState({ id: item.id, checked: false, url: "" });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, createdUrl = "";
    const controller = new AbortController();
    setFailed(false); setLookup({ id: item.id, checked: false, url: "" });
    (async () => {
      try {
        const blob = await getGalleryAsset(item.id, "thumbnail") || await getGalleryAsset(item.id, "original");
        if (!alive) return;
        if (blob) createdUrl = URL.createObjectURL(blob);
        let remote = !isLocalPage() && isLoopbackAddress(item.thumb) ? "" : item.thumb;
        if (!blob && /^https:\/\/ruhua-api-aa5d4d3-v\d+\.app\.beam\.cloud/.test(item.backend_url || remote || '')) {
          registerJobAccess(item.job_id, item.job_token, item.file_urls);
          remote = fileUrl(item.job_id, 'original.jpg', item.backend_url || getBase());
          const expires = Number(new URL(remote).searchParams.get('expires'));
          if (item.job_token && (!expires || expires <= Date.now() / 1000)) {
            await refreshJobAccess(item.job_id, item.backend_url || getBase());
            if (!alive) return;
            remote = fileUrl(item.job_id, 'original.jpg', item.backend_url || getBase());
          }
          const downloaded = await downloadJobFile(item.job_id, 'original.jpg', item.backend_url || getBase(), { signal: controller.signal });
          if (!alive) return;
          createdUrl = URL.createObjectURL(downloaded);
        }
        if (alive) setLookup({ id: item.id, checked: true, url: createdUrl || remote });
      } catch { if (alive) setLookup({ id: item.id, checked: true, url: "" }); }
    })();
    return () => { alive = false; controller.abort(); if (createdUrl) URL.revokeObjectURL(createdUrl); };
  }, [item.id, item.originalReady, item.thumbnailReady, item.thumb, item.backend_url]);
  const source = lookup.id === item.id && lookup.checked ? lookup.url : "";
  return source && !failed ? <img src={source} loading="lazy" decoding="async" alt={item.title} onError={() => setFailed(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div className="gallery-placeholder">3D 场景</div>;
}

function GalleryPage({ setPage, onOpen, onDelete }) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isDesktopApp()), []);
  const [list, setList] = useState<GalleryItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const gridRef = useReveal();
  useEffect(() => {
    if (!navigator.onLine) return;
    // Keep viewer code available before the user takes this already-open page offline.
    void Promise.all([import("@/components/SplatViewer"), import("@mkkellogg/gaussian-splats-3d"), import("three")]).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => { listGallery().then(items => { if (alive) { setList(items); setLoading(false); } }).catch(() => { if (alive) { setError("暂时无法读取浏览器作品库，请刷新后重试。"); setLoading(false); } }); };
    refresh(); const unsubscribe = subscribeGallery(refresh);
    return () => { alive = false; unsubscribe(); };
  }, []);
  const toggleFav = async (item: GalleryItem) => { try { await setGalleryFavorite(item.id, !item.fav); } catch { setError("收藏设置未能保存，请检查浏览器可用空间。"); } };
  const remove = async (item: GalleryItem) => {
    try { await deleteGalleryItem(item.id); onDelete?.(item.id); setError(""); }
    catch { setError("删除未完成，请关闭其他占用作品库的页面后重试。"); }
  };
  const open = async (item: GalleryItem) => {
    if (opening) return;
    setOpening(item.id); setError("");
    try { await onOpen(item); } catch (e) { setError(e instanceof Error ? e.message : "打开失败，请重试。"); }
    finally { setOpening(""); }
  };
  const shown = filter === "fav" ? list.filter(item => item.fav) : filter === "recent" ? list.slice(0, 12) : list;
  return <main style={{ maxWidth: 1140, margin: "0 auto", padding: "76px 24px 72px" }}>
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
      <div><div className="eyebrow">作品库 · {list.length} 件作品</div><h1 style={{ fontSize: "clamp(32px,5vw,52px)", fontWeight: 600, letterSpacing: "-.025em" }}>你显影过的场景。</h1></div>
      <LiquidToggle tone="light" size="md" value={filter} onChange={setFilter} options={[{ id: "all", label: "全部" }, { id: "recent", label: "最近" }, { id: "fav", label: "收藏" }]} />
    </div>
    {desktop
      ? <p className="gallery-storage-note">原图、3D 场景和导出的视频会另存一份到本机的 D:\Pixel Reconstruction\作品（没有 D 盘时放在安装目录下），卸载客户端也会保留。<button type="button" className="gallery-folder" onClick={() => void openWorksFolder()}>打开作品文件夹</button></p>
      : <p className="gallery-storage-note">作品保存到当前浏览器，不设数量上限或自动到期时间。页面与查看器已加载后，已保存的场景可离线查看；修图仍需要云端服务。</p>}
    {error && <p className="creation-error" role="alert">{error}</p>}
    {loading ? <p role="status" className="gallery-storage-note">正在读取作品…</p> : shown.length === 0 ? <div className="gallery-empty">
      <p>{filter === "fav" ? "还没有收藏的场景。" : "这里还空着。显影一张照片，它就会出现在这里。"}</p><button onClick={() => setPage("create")}>开始创作</button>
    </div> : <div ref={gridRef} className="gallery-grid in" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 24 }}>
      {shown.map(item => <article key={item.id} className="gallery-card" data-work-id={item.id}>
        <div className="gallery-picture">
          <button className="gallery-preview-button" aria-label={"打开" + item.title} onClick={() => open(item)}><GalleryThumbnail item={item} /></button>
          <button className="gallery-favorite" onClick={() => toggleFav(item)} aria-pressed={item.fav} aria-label={item.fav ? "取消收藏" : "收藏"} style={{ color: item.fav ? "#ffd60a" : "#fff" }}>{item.fav ? "★" : "☆"}</button>
        </div>
        <div style={{ padding: "16px 18px" }}>
          <h2 style={{ fontSize: 15.5, fontWeight: 600, margin: "0 0 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.title}</h2>
          <div className="gallery-meta"><span>{item.date}</span><span>{item.meta}</span></div>
          <p className={"gallery-cache-label " + item.cacheState}>{item.cacheState === "local" ? "✓ " : ""}{galleryStatus(item)}</p>
          {item.cacheError && <p className="gallery-cache-error">{item.cacheError}</p>}
          <div className="gallery-actions"><button disabled={!!opening} onClick={() => open(item)}>{opening === item.id ? "正在打开…" : "打开"}</button><button onClick={() => remove(item)} aria-label={"删除" + item.title}>删除</button></div>
          {(item.cacheState === "remote" || item.cacheState === "partial") && <button className="gallery-save-button" onClick={() => { void cacheGalleryItem(item); }}>保存完整场景与原图到此浏览器</button>}
        </div>
      </article>)}
    </div>}
    <p className="gallery-storage-note" style={{ textAlign: "center", marginTop: 28 }}>删除作品只清除这一件的浏览器缓存。清除站点数据、卸载浏览器或换设备后，本机作品不会自动恢复，请保留下载备份。</p>
    {list.some(item => item.cacheState === "local") && <p className="gallery-storage-note" style={{ textAlign: "center" }}>{list.every(item => item.persistent) ? "已取得浏览器持久存储许可。" : "部分作品尚未获得浏览器持久存储许可；存储空间不足时浏览器仍可能回收站点数据。"}</p>}
  </main>;
}

// —— 渐显小节包装：进入视口时浮现，可选 stagger 让子元素错峰 ——
function Reveal({ children, stagger = false, style, as: Tag = "div", variant = "rise", className = "" }: { children: ReactNode; stagger?: boolean; style?: CSSProperties; as?: ElementType; variant?: "rise" | "unfold" | "drift" | "focus"; className?: string }) {
  const ref = useReveal();
  return <Tag ref={ref} className={`${stagger ? "reveal-stagger" : "reveal"} reveal-${variant} ${className}`} style={style}>{children}</Tag>;
}

// ============================================================
// 首页（概览）—— 完整还原设计稿 + 动效
// ============================================================
function HomePage({ setPage, active = true, ready = true }) {
  const demoRef = useRef(null);
  const [workflowStage, setWorkflowStage] = useState(0);
  const [workflowPlaying, setWorkflowPlaying] = useState(false);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    setWorkflowPlaying(!reduced.matches);
    const change = () => { if (reduced.matches) setWorkflowPlaying(false); };
    reduced.addEventListener("change", change);
    return () => reduced.removeEventListener("change", change);
  }, []);
  const selectWorkflow = (stage: number) => { setWorkflowStage(stage); setWorkflowPlaying(false); };
  const scrollDemo = () => demoRef.current?.scrollIntoView({ behavior: prefersReduced() ? "instant" : "smooth", block: "start" });
  const homeRef = useRef<HTMLElement>(null);
  // Parallax: the headline sits deepest, copy a little nearer; the GPU shot drifts inside its frame.
  useParallax(homeRef, active);
  return <main ref={homeRef} className="home-page">
    <section className="overview-intro">
      <div><h1 className={"home-title" + (ready ? " is-ready" : "")} data-parallax=".14">
        <span className="hero-first-line">从一张照片，</span><br />
        <span>{Array.from("重建可探索的空间。").map((char, i) => <span key={i} className="hero-letter" style={{ animationDelay: `${i * 30}ms` }}>{char}</span>)}</span>
      </h1></div>
      <div className="overview-context" data-parallax=".07"><p>基于 Apple SHARP，将单张图片转换为高斯泼溅场景。在浏览器内调整视角、编排运镜并导出视频。</p>
        <div className="overview-actions"><button className="editorial-primary" onClick={() => setPage("create")}>上传照片 <span aria-hidden="true">↗</span></button><button className="editorial-link" onClick={scrollDemo}>查看运镜示例 <span aria-hidden="true">↓</span></button></div>
      </div>
    </section>
    <DemoPlayer innerRef={demoRef} active={active} />
    <p className="demo-caption">同一场景，四种相机运动。选择上方运镜，查看视角与空间关系的变化。</p>
    <section className="workflow-flow">
      <Reveal variant="focus" className="workflow-intro"><h2>从输入到成片。</h2><p>先建立空间，再决定怎样观看。</p><WorkflowPreview stage={workflowStage} onStageChange={setWorkflowStage} playing={workflowPlaying} onPlayingChange={setWorkflowPlaying} active={active} /></Reveal>
      <Reveal as="ol" stagger variant="unfold" className="workflow-list">
        {[
          ["上传照片", "选择主体清晰、具有前后层次的图片。支持 JPG、PNG、WebP、HEIC，单张不超过 20MB。"],
          ["调整场景与视角", "云端完成重建后，在工作室查看场景。适合原视角附近的小幅环绕与推拉，遮挡区域不等同于真实背面。"],
          ["编排运镜，导出视频", "将镜头排列为序列，调整时长后导出。原始三维文件与照片也可保存在这台设备的作品库。"],
        ].map(([title, description], index) => <li key={title}><button className="workflow-step" aria-pressed={workflowStage === index} onPointerEnter={() => selectWorkflow(index)} onFocus={() => selectWorkflow(index)} onClick={() => selectWorkflow(index)}><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{title}</strong><span>{description}</span></span><i aria-hidden="true">↗</i></button></li>)}
      </Reveal>
    </section>
    <section className="compute-story">
      <Reveal stagger variant="drift" className="compute-story-layout">
        <div><h2>重建在云端完成。<br />创作留在浏览器。</h2><p>SHARP 推理由 Beam 按任务分配 RTX 4090。浏览器负责场景查看、运镜预览与视频导出；首次请求需要等待云端服务启动。</p><span className="compute-spec">RTX 4090 · 24GB <i /> 按任务分配</span></div>
        <figure><img src="/rtx4090.png" alt="用于云端场景重建的 RTX 4090 显卡" loading="lazy" data-parallax=".05" /><figcaption>COMPUTE / BEAM SERVERLESS</figcaption></figure>
      </Reveal>
    </section>
    <section className="overview-start"><div><h2 data-parallax=".06">开始重建你的照片。</h2><p>上传后自动连接云端，无需配置显卡或服务地址。</p></div><button className="editorial-primary" onClick={() => setPage("create")}>上传照片 <span aria-hidden="true">↗</span></button></section>
    <footer className="overview-footer"><BrandMark size={21} /><span>Pixel Reconstruction</span><span>单张图片 · 三维场景 · 自由运镜</span></footer>
  </main>;
}

// ============================================================
// 根组件：路由 + 主题
// ============================================================
export default function App() {
  const [page, setPage] = useState("home");
  const [routeTransitionId, setRouteTransitionId] = useState(0);
  const [theme, setTheme] = useState("light");
  const [splashDone, setSplashDone] = useState(false);
  const [showcaseMotion, setShowcaseMotion] = useState<"enter" | "return" | null>(null);
  const [source, setSourceState] = useState<Source>("beam");
  const [backend, setBackend] = useState(BEAM_URL);
  const [conn, setConn] = useState("unknown");
  const [device, setDevice] = useState("");
  // The companion appears only once the gateway says chat is configured.
  const [assist, setAssist] = useState(false);
  const [assistVision, setAssistVision] = useState(false);
  const [result, setResult] = useState(null);
  const [creating, setCreating] = useState(false);
  const [incoming, setIncoming] = useState<{ file: File; id: number } | null>(null);
  const takeIncoming = useCallback(() => setIncoming(null), []);
  const [doubao, setDoubao] = useState<DoubaoPreferences>({ mode: "site", apiKey: "", model: "" });
  const probeId = useRef(0);
  const openVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // Every button and link: a visible press and a spring return, even on a quick tap.
  useEffect(() => (rootRef.current ? installPressFeedback(rootRef.current) : undefined), []);
  useEffect(() => {
    if (showcaseMotion !== "return") return;
    const timer = setTimeout(() => setShowcaseMotion(null), prefersReduced() ? 180 : 980);
    return () => clearTimeout(timer);
  }, [showcaseMotion]);
  useEffect(() => () => { if (result?.offline_mobile_url) URL.revokeObjectURL(result.offline_mobile_url); }, [result?.offline_mobile_url]);
  useEffect(() => () => { if (result?.offline_original_url) URL.revokeObjectURL(result.offline_original_url); }, [result?.offline_original_url]);
  useEffect(() => () => { if (result?.offline_viewer_url) URL.revokeObjectURL(result.offline_viewer_url); }, [result?.offline_viewer_url]);
  useEffect(() => () => { if (result?.offline_ply_url) URL.revokeObjectURL(result.offline_ply_url); }, [result?.offline_ply_url]);
  useEffect(() => () => { if (result?.offline_video_url) URL.revokeObjectURL(result.offline_video_url); }, [result?.offline_video_url]);
  const probe = useCallback(async (base: string) => {
    const id = ++probeId.current;
    setDevice("");
    if (!base) { setConn("unknown"); return; }
    setConn("checking");
    const r = await ping(base);
    if (id !== probeId.current) return;
    setConn(r.ok ? "ok" : "fail"); setDevice(r.device || ""); setAssist(!!r.assist); setAssistVision(!!r.assist_vision);
  }, []);
  const applyBackend = (url: string) => {
    if (!isLocalPage()) return;
    const normalized = saveBase(url);
    try { localStorage.setItem("ruhua-source-url-" + source, normalized); } catch {}
    setBackend(normalized); void probe(normalized);
  };
  const setSource = (next: Source) => {
    if (!isLocalPage()) return;
    let base = SOURCE_URL[next];
    try { base = localStorage.getItem("ruhua-source-url-" + next) ?? base; localStorage.setItem("ruhua-source-v3", next); } catch {}
    setSourceState(next); setBackend(saveBase(base)); void probe(base);
  };
  useEffect(() => {
    let savedBase = getBase();
    let savedSource: Source = "beam";
    try { const stored = localStorage.getItem("ruhua-source-v3"); if (stored && stored in SOURCE_URL) savedSource = stored as Source; else if (stored) { savedBase = saveBase(BEAM_URL); localStorage.setItem("ruhua-source-v3", "beam"); } } catch {}
    if (!isLocalPage()) { savedSource = "beam"; savedBase = saveBase(getDefaultBase()); try { localStorage.setItem("ruhua-source-v3", "beam"); } catch {} }
    setSourceState(savedSource); setBackend(savedBase); void probe(savedBase);
    return () => { probeId.current++; };
  }, [probe]);
  useEffect(() => { try { const t = localStorage.getItem("ruhua-theme-v2"); if (t === "dark" || t === "light") setTheme(t); } catch {} }, []);
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("ruhua-theme-v2", theme); } catch {} }, [theme]);
  const navigate = (next: string) => { if (next === page) return; setPage(next); setRouteTransitionId(id => id + 1); window.scrollTo({ top: 0, behavior: "instant" }); };
  // A photo dropped on the companion: open the create page and develop it there.
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<UploadRequest>).detail;
      if (!request) return;
      if (creatingRef.current) { request.answer("busy"); return; }
      setIncoming({ file: request.file, id: Date.now() });
      navigateRef.current("create");
      request.answer("started");
    };
    window.addEventListener(UPLOAD_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(UPLOAD_REQUEST_EVENT, onRequest);
  }, []);
  const loadFull = async (item) => {
    if (!navigator.onLine) {
      setResult(current => isSameGalleryScene(current, item) ? { ...current, restore_error: "请先连接网络，再恢复完整场景。历史缓存会继续保留。" } : current);
      return;
    }
    try {
      registerJobAccess(item.job_id, item.job_token, item.file_urls);
      const files = await refreshJobAccess(item.job_id, item.backend_url || backend);
      const candidate = item.ply_file.replace(/\.ply$/i, ".splat");
      const restored = { ...item, viewer_file: item.viewer_file || (files?.[candidate] ? candidate : undefined), file_urls: files || item.file_urls, viewer_quality: "full", restore_error: "" };
      setResult(current => isSameGalleryScene(current, item) ? { ...current, ...restored } : current);
      void cacheGalleryItem(restored, { quality: "full" });
    } catch (error) {
      setResult(current => isSameGalleryScene(current, item) ? { ...current, restore_error: error instanceof Error ? error.message : "完整场景暂时无法载入，请检查网络后重试。" } : current);
    }
  };
  const keepResult = (st) => {
    const { id, gallery_id, viewer_quality, preview_error, offline_mobile_url, offline_original_url, offline_viewer_url, offline_ply_url, offline_video_url, ...remote } = st;
    const item = { ...remote, backend_url: remote.backend_url || backend, thumb: fileUrl(st.job_id, "original.jpg", st.backend_url || backend), title: "显影场景", date: new Date().toLocaleDateString("zh-CN"), meta: SOURCE_META[source]?.name || "", fav: false };
    setResult({ ...item, gallery_id: galleryId(item), viewer_quality: "full" });
    void cacheGalleryItem(item, { quality: "full" });
    navigate("studio");
    announceMoment({ kind: "developed" });
  };
  const openGallery = async (item: GalleryItem) => {
    const version = ++openVersion.current;
    registerJobAccess(item.job_id, item.job_token, item.file_urls);
    const [{ mobile, viewer, ply, quality }, original, video] = await Promise.all([getGalleryScene(item, navigator.onLine), getGalleryAsset(item.id, "original"), item.mp4_file ? getGalleryAsset(item.id, "video", item.mp4_file) : undefined]);
    if (version !== openVersion.current) return;
    if (!mobile && !viewer && !ply && !navigator.onLine) throw new Error("这件作品还没有完整保存到此浏览器，请联网后打开或继续保存。");
    if (!isLocalPage() && isLoopbackAddress(item.backend_url || "") && !mobile && !viewer && !ply) throw new Error("这是本地开发服务中的作品，请在原电脑的本地页面打开并保存。");
    const useMobile = quality === "mobile";
    const baseItem = { ...item, gallery_id: item.id, backend_url: item.backend_url || backend, viewer_quality: useMobile ? "mobile" : "full", offline_mobile_url: mobile ? URL.createObjectURL(mobile) : undefined, offline_original_url: original ? URL.createObjectURL(original) : undefined, offline_viewer_url: viewer ? URL.createObjectURL(viewer) : undefined, offline_ply_url: ply ? URL.createObjectURL(ply) : undefined, offline_video_url: video ? URL.createObjectURL(video) : undefined };
    if (useMobile) {
      setResult(baseItem); navigate("studio");
      return;
    }
    const files = !viewer && !ply && item.job_token ? await refreshJobAccess(item.job_id, item.backend_url || backend) : undefined;
    if (version !== openVersion.current) return;
    const candidate = item.ply_file.replace(/\.ply$/i, ".splat");
    const viewerFile = item.viewer_file || (files?.[candidate] ? candidate : undefined);
    setResult({ ...baseItem, viewer_file: viewerFile });
    if (!viewer && !ply) void cacheGalleryItem({ ...item, viewer_file: viewerFile, file_urls: files || item.file_urls, backend_url: item.backend_url || backend }, { quality: "full" });
    navigate("studio");
  };
  return <div ref={rootRef} className="ruhua-root" data-theme={theme} data-showcase-motion={showcaseMotion || undefined}>
    <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
    <InteriorStyles />
    <BrandIntro />
    {!splashDone && <LandingExperience exitDuration={960} onExitStart={() => setShowcaseMotion("enter")} onEnter={() => { setSplashDone(true); setShowcaseMotion(null); window.scrollTo(0, 0); }} />}
    <ShowcaseTransition direction={showcaseMotion} />
    <div className="showcase-workspace" inert={!splashDone} aria-hidden={!splashDone} style={{ visibility: splashDone || showcaseMotion ? "visible" : "hidden" }}>
      <Nav page={page} setPage={navigate} theme={theme} toggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")} onShowcase={() => { setShowcaseMotion("return"); setSplashDone(false); }} logoReady={splashDone || showcaseMotion === "enter"} />
      {routeTransitionId > 0 && <div key={`wipe-${routeTransitionId}`} className="route-wipe" aria-hidden="true" style={{ visibility: splashDone ? "visible" : "hidden" }} />}
      <div className={page === "home" ? "page-enter" : ""} style={{ display: page === "home" ? "block" : "none" }}><HomePage setPage={navigate} active={page === "home" && (splashDone || showcaseMotion === "enter")} ready={splashDone || showcaseMotion === "enter"} /></div>
      {(page === "create" || creating || incoming) && <div className="page-enter" style={{ display: page === "create" ? "block" : "none" }}><CreatePage source={source} setSource={setSource} conn={conn} device={device} backend={backend} onApply={applyBackend} onReconnect={() => probe(backend)} onBusy={setCreating} onDone={keepResult} incoming={incoming} onIncomingTaken={takeIncoming} /></div>}
      <div key={`page-${page}`} className="page-enter" data-page={page}>
        {page === "studio" && <StudioPage result={result} setPage={navigate} conn={conn} device={device} onLoadFull={loadFull} />}
        {page === "enhance" && <EnhancePage result={result} setPage={navigate} doubao={doubao} onDoubaoChange={setDoubao} onRerenderDone={keepResult} />}
        {page === "gallery" && <GalleryPage setPage={navigate} onOpen={openGallery} onDelete={id => { if (result?.gallery_id === id) setResult(null); }} />}
      </div>
    </div>
    {assist && <WhaleCompanion page={page} active={splashDone} visionEnabled={assistVision} onNavigate={navigate} />}
  </div>;
}

