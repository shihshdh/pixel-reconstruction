'use client';

/** The gallery and the entrance share paper, warm light and charcoal. */
export default function InteriorStyles() {
  return <style>{`
  :root{--bg:#f7f9fc;--bg2:#eef3f9;--card:#ffffff;--track:#e7edf5;--ink:#202428;--ink2:#586069;--ink3:#656d77;--line:#d2d8df;--line2:#bcc4ce;--accent:#0071e3;--glass:rgba(250,252,255,.7);--glass-brd:rgba(255,255,255,.88);--nav-brd:#3f516514;--shadow:0 24px 64px -32px #1b222959;}
  [data-theme="dark"]{--bg:#0a111d;--bg2:#0f1828;--card:#142034;--track:#1b2a41;--ink:#e2e7ec;--ink2:#a1a9b2;--ink3:#8e9aa7;--line:#98a5b423;--line2:#a0b1c434;--accent:#4da3ff;--glass:rgba(16,26,42,.74);--glass-brd:#d9e5f224;--nav-brd:#c1d2e514;--shadow:0 24px 64px -32px #000a;}
  .ruhua-root{--surface-tint:#f9fcff4f;--surface-rim:#fcfdffcc;--surface-shadow:#27384c10;--blue:var(--accent);--violet:#6b7f95;--pink:#7c92ab;background:radial-gradient(ellipse at 75% 0%,#8ba1ba15,transparent 50%),var(--bg);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  [data-theme="dark"].ruhua-root{--surface-tint:#b7c6d70b;--surface-rim:#d8e3ef27;--surface-shadow:#0003;}
  .ruhua-root ::selection{background:#899fb855;}
  .ruhua-root{overflow-x:clip;}
  .landing-fallback{position:fixed;inset:0;z-index:10000;overflow:hidden;background:#141619;color:#f1f5fa;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  .landing-fallback>img,.landing-fallback-shade{position:absolute;inset:0;width:100%;height:100%;}
  .landing-fallback>img{object-fit:cover;object-position:50% 42%;}
  .landing-fallback-shade{background:linear-gradient(180deg,#090e0b3d,transparent 130px,transparent calc(100% - 110px),#090e0b47);}
  .landing-fallback-brand{position:absolute;top:34px;left:5.2vw;display:flex;align-items:center;gap:11px;}
  .landing-fallback-brand>span{font:500 15px/1.16 SFMono-Regular,Consolas,"Liberation Mono",monospace;letter-spacing:-.025em;}
  .landing-fallback-brand small{display:block;font:8px/1.2 SFMono-Regular,Consolas,monospace;letter-spacing:.15em;opacity:.6;margin-top:6px;}
  .landing-fallback>p{position:absolute;left:5.2vw;bottom:36px;font-size:10px;letter-spacing:.08em;margin:0;color:#e6ebf0ae;}
  html[data-intro] .landing-fallback-brand{opacity:0;}html[data-intro="play"] .landing-fallback>p{opacity:0;}.landing-fallback>img{transition:transform 1.6s cubic-bezier(.16,1,.3,1);}html[data-intro="play"] .landing-fallback>img{transform:scale(1.06);}
  @media(max-width:767px){.landing-fallback>img{object-position:50% 45%;}.landing-fallback-brand{top:24px;left:6vw;}.landing-fallback-brand svg{width:32px;height:32px;}.landing-fallback-brand>span{font-size:12px;}.landing-fallback-brand small{font-size:6px;letter-spacing:.14em;}.landing-fallback>p{left:6vw;bottom:28px;font-size:9px;}}
  .showcase-transition{position:fixed;inset:0;z-index:10020;pointer-events:none;overflow:hidden;}
  .showcase-shutter{position:absolute;left:-4%;width:108%;height:20.2%;background:var(--bg);border-bottom:1px solid var(--line2);box-shadow:0 -4px 28px #1f273117;transform:translate3d(105%,0,0);animation:showcase-shutter-enter 780ms cubic-bezier(.65,0,.25,1) both;}
  .showcase-shutter:nth-child(even){background:var(--bg2);}
  .showcase-shutter span{display:block;height:100%;background:linear-gradient(108deg,transparent 45%,#f4f9fe5c 70%,transparent);}
  .showcase-transition.is-return .showcase-shutter{animation-name:showcase-shutter-return;}
  [data-external-transition="true"]{transition:none!important;}
  [data-showcase-motion="enter"] [data-external-transition="true"]{animation:showcase-scene-out 960ms cubic-bezier(.16,1,.3,1) both!important;pointer-events:none;transform-origin:22% 55%;}
  [data-showcase-motion="return"] [data-external-transition="true"]{animation:showcase-scene-in 960ms cubic-bezier(.16,1,.3,1) both!important;transform-origin:78% 45%;}
  [data-showcase-motion="enter"] .showcase-workspace{animation:showcase-workspace-in 960ms cubic-bezier(.16,1,.3,1) both;transform-origin:50% 20%;}
  [data-showcase-motion="enter"] .overview-intro{animation:showcase-title-in 960ms cubic-bezier(.16,1,.3,1) both;}
  [data-showcase-motion="enter"] .home-page>section:nth-child(2){animation:showcase-image-in 960ms cubic-bezier(.16,1,.3,1) both;}
  [data-showcase-motion="return"] .showcase-workspace{animation:showcase-workspace-out 780ms cubic-bezier(.65,0,.25,1) both;pointer-events:none;}
  @keyframes showcase-shutter-enter{0%{transform:translate3d(105%,0,0) skewX(-8deg);}42%{transform:translate3d(0,0,0) skewX(-4deg);}100%{transform:translate3d(-105%,0,0) skewX(0);}}
  @keyframes showcase-shutter-return{0%{transform:translate3d(-105%,0,0) skewX(8deg);}42%{transform:translate3d(0,0,0) skewX(4deg);}100%{transform:translate3d(105%,0,0) skewX(0);}}
  @keyframes showcase-scene-out{0%{opacity:1;transform:none;}48%{opacity:.9;transform:translate3d(-6%,0,0) scale(1.08) rotate(-1.5deg);}65%,100%{opacity:0;transform:translate3d(-10%,0,0) scale(1.12) rotate(-2deg);}}
  @keyframes showcase-scene-in{0%,18%{opacity:0;transform:translate3d(6%,0,0) scale(1.1) rotate(1.5deg);}52%{opacity:1;}100%{opacity:1;transform:none;}}
  @keyframes showcase-workspace-in{0%,25%{opacity:0;transform:translate3d(0,60px,0) scale(.95);}60%{opacity:1;}100%{opacity:1;transform:none;}}
  @keyframes showcase-workspace-out{0%{opacity:1;transform:none;}70%,100%{opacity:0;transform:translate3d(0,-40px,0) scale(.97);}}
  @keyframes showcase-title-in{0%,36%{opacity:0;transform:translate3d(0,24px,0);}100%{opacity:1;transform:none;}}
  @keyframes showcase-image-in{0%,48%{opacity:0;transform:translate3d(0,40px,0) scale(.97);}100%{opacity:1;transform:none;}}
  @media(prefers-reduced-motion:reduce){.showcase-transition{display:none;}[data-showcase-motion] [data-external-transition="true"],[data-showcase-motion] .showcase-workspace,[data-showcase-motion] .overview-intro,[data-showcase-motion] .home-page>section:nth-child(2){transform:none!important;animation:interior-fade 100ms linear both!important;}[data-showcase-motion="enter"] [data-external-transition="true"]{animation:showcase-reduced-out 100ms linear both!important;}@keyframes showcase-reduced-out{to{opacity:0;}}}
  .ruhua-root main h1,.ruhua-root .home-title,.home-page h2{font-family:"STSong","Songti SC","Noto Serif SC",serif;font-weight:400!important;letter-spacing:.025em!important;line-height:1.32!important;}
  .ruhua-root main{padding-top:70px!important;}
  .ruhua-root main.home-page{padding-top:0!important;}
  .home-hero::before{background:radial-gradient(ellipse at 60% 10%,#a2b4c828,transparent 68%);}
  .eyebrow{font-family:SFMono-Regular,Consolas,monospace;font-size:10px!important;letter-spacing:.17em!important;color:var(--ink3);}
  .nav-bar{height:66px;padding:0 4.3vw!important;background:var(--glass)!important;box-shadow:inset 0 -1px 0 var(--nav-brd)!important;backdrop-filter:blur(12px) saturate(115%)!important;-webkit-backdrop-filter:blur(12px) saturate(115%)!important;}
  .nav-logo{gap:9px;margin-right:38px;font-family:SFMono-Regular,Consolas,monospace;font-weight:500!important;font-size:12px;letter-spacing:-.045em;}
  .nav-logo svg{color:var(--ink);}
  .nav-tabs{gap:26px;}
  .nav-tab{padding:23px 0!important;font-size:12px;letter-spacing:.06em!important;}
  .nav-tab[aria-current="page"]::after{bottom:13px;left:12%;right:12%;height:1px;background:var(--accent);}
  .nav-tab:hover{color:var(--ink)!important;}
  .nav-bar{isolation:isolate;background:linear-gradient(100deg,color-mix(in srgb,var(--bg) 76%,transparent),color-mix(in srgb,var(--bg) 56%,transparent),color-mix(in srgb,var(--bg) 83%,transparent))!important;backdrop-filter:blur(8px) saturate(135%)!important;-webkit-backdrop-filter:blur(8px) saturate(135%)!important;}
  .nav-bar::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:-1;background:radial-gradient(ellipse 280px 90px at var(--pointer-x,14%) var(--pointer-y,0%),#ffffff70,transparent 80%);opacity:.52;}
  [data-theme="dark"] .nav-bar::before{opacity:.1;}
  .nav-tabs{position:relative;padding:0 10px;isolation:isolate;}
  .nav-tab{position:relative;z-index:1;}
  .nav-tab[aria-current="page"]::after{display:none;}
  .nav-drop{position:absolute;left:0;top:15px;width:100px;height:35px;border-radius:99px;transform-origin:left;pointer-events:none;transition:transform 420ms cubic-bezier(.16,1,.3,1);background:linear-gradient(160deg,#ffffffa8,#ffffff12 45%,#7791ae33 77%,#ffffff87);box-shadow:inset 1px 1px 1px #ffffffe0,inset -1px -1px 1px #7a93af6b,inset 0 0 8px #9cb4d024,0 3px 8px #273f5b13;border:1px solid #7791ae27;backdrop-filter:blur(2px) saturate(150%);-webkit-backdrop-filter:blur(2px) saturate(150%);}
  .nav-drop::after{content:"";position:absolute;inset:2px 7px 45%;border-radius:99px;background:radial-gradient(ellipse at var(--pointer-x,20%) 0%,#fff9,transparent 72%);}
  [data-theme="dark"] .nav-drop{background:linear-gradient(160deg,#d6e1ee26,#d6e1ee05 50%,#96acc61a);box-shadow:inset 1px 1px 1px #dae6f35c,inset -1px -1px 1px #7f9dc01e,0 3px 8px #0002;border-color:#b7cce323;}
  .nav-theme{position:relative;overflow:hidden;background:linear-gradient(140deg,#ffffff80,#ffffff08 55%,#a6b8cd2e)!important;box-shadow:inset 1px 1px 1px #ffffffe0,inset -1px -1px 1px #6888ad42!important;}
  .nav-theme::after{content:"";position:absolute;inset:1px;border-radius:inherit;pointer-events:none;background:radial-gradient(circle at var(--pointer-x,25%) var(--pointer-y,10%),#ffffffa1,transparent 65%);opacity:.5;transition:opacity 160ms,transform 160ms;}
  .nav-theme:active::after{opacity:1;transform:scale(1.4);}
  .nav-cta{background:var(--ink)!important;color:var(--bg)!important;font-size:12px;padding:10px 18px;}
  .nav-theme{background:transparent!important;border-color:var(--line2)!important;}
  .ruhua-root button:not(:disabled){transition:transform 230ms cubic-bezier(.16,1,.3,1),box-shadow 240ms,background 240ms,color 240ms,opacity 200ms!important;}
  @media(hover:hover){.ruhua-root button:not(:disabled):not(.nav-logo):not(.nav-tab):hover{transform:translateY(-3px);box-shadow:0 7px 18px -10px #212d3a8c;}.ruhua-root .nav-tab:hover{transform:translateY(-1px);}.ruhua-root .seg-btn:hover{transform:translateY(-1px)!important;box-shadow:none!important;}}
  .ruhua-root button:active:not(:disabled){transform:translateY(1px) scale(.95)!important;box-shadow:inset 0 2px 4px #0000000a!important;transition-duration:90ms!important;}
  /* Press: with script, the dip and its spring return run on the scale property (lib/motion installPressFeedback), so the :active rule keeps only the 1px sink. */
  .ruhua-root[data-press] button:active:not(:disabled){transform:translateY(1px)!important;}
  /* Theme icon: sun and moon morph (Morphicons) while the glyph swings a quarter turn. */
  .nav-theme svg{transition:rotate 560ms cubic-bezier(.16,1,.3,1);}
  [data-theme="dark"] .nav-theme svg{rotate:90deg;}
  /* Nav mark: on hover the four pixels step toward the volume, one after another, and the top face catches light. */
  @media(hover:hover) and (prefers-reduced-motion:no-preference){.nav-logo:hover [data-part="px"]{animation:mark-px 760ms cubic-bezier(.16,1,.3,1) both;}.nav-logo:hover rect:nth-of-type(2){animation-delay:45ms;}.nav-logo:hover rect:nth-of-type(3){animation-delay:90ms;}.nav-logo:hover rect:nth-of-type(4){animation-delay:135ms;}.nav-logo:hover [data-part="top"]{animation:mark-top 760ms cubic-bezier(.16,1,.3,1) 120ms both;}}
  @keyframes mark-px{0%{transform:none;}38%{transform:translate(5px,0);}100%{transform:none;}}
  @keyframes mark-top{0%{fill-opacity:.18;}40%{fill-opacity:.42;}100%{fill-opacity:.18;}}
  @media(prefers-reduced-motion:reduce){.nav-theme svg{transition:none;}}
  [data-parallax-on] .compute-story figure img{scale:1.08;}
  .ruhua-root a:hover{color:var(--accent);}
  .ruhua-root input,.ruhua-root textarea,.ruhua-root select{accent-color:var(--accent);}
  .ruhua-root :focus-visible{outline:2px solid #687f9a;outline-offset:5px;}
  .liquid-surface,.compute-panel{background:linear-gradient(155deg,var(--surface-tint),transparent 60%);border-color:var(--line);box-shadow:inset 0 1px 1px var(--surface-rim),0 10px 30px var(--surface-shadow);backdrop-filter:blur(5px) saturate(112%);}
  .liquid-surface::before,.compute-panel::before{background:radial-gradient(ellipse at var(--pointer-x,15%) var(--pointer-y,0%),#ffffff48,transparent 62%),linear-gradient(170deg,#ecf4fe0b,transparent 50%,#6a7f9808);}
  .liquid-surface::after,.compute-panel::after{background:linear-gradient(145deg,var(--surface-rim),transparent 30%,#9badc218 60%,var(--surface-rim));}
  .liquid-thumb{background:linear-gradient(155deg,#90a5be99,#62778fe8 42%,#4f647ceb 70%,#859ab2aa);border-color:#d6e2ef8f;box-shadow:inset 1px 1px 1px #ddeaf89c,inset -1px -1px 2px #33455a63,0 3px 10px #263a5126;}
  .liquid-toggle{isolation:isolate;background:linear-gradient(150deg,#ffffff24,#99a8b914 60%,#ffffff40)!important;box-shadow:inset 0 1px 0 #ffffff8c,inset 0 -1px 0 #42658d21,0 7px 18px -12px #28364652;backdrop-filter:blur(4px) saturate(145%)!important;-webkit-backdrop-filter:blur(4px) saturate(145%)!important;}
  .liquid-toggle[data-tone="dark"]{background:linear-gradient(155deg,#242a3170,#141d1545)!important;box-shadow:inset 0 1px 1px #ffffff36,inset 0 -1px 0 #ffffff10,0 7px 18px -12px #0008;}
  .liquid-toggle .liquid-thumb,.liquid-toggle .dock-thumb{overflow:hidden;background:linear-gradient(158deg,#ffffffc7,#d4dfeb80 44%,#95afcd7d 72%,#f0f7feab);border:1px solid #ffffff70;box-shadow:inset 1px 1px 1px #fffffff5,inset -1px -1px 2px #53698277,inset 0 0 5px #eef5fe66,0 5px 10px -5px #1f324747;backdrop-filter:blur(3px) saturate(165%);-webkit-backdrop-filter:blur(3px) saturate(165%);}
  .liquid-toggle .liquid-thumb::after,.liquid-toggle .dock-thumb::after{mix-blend-mode:normal;background:radial-gradient(ellipse at var(--pointer-x,18%) var(--pointer-y,0%),#ffffffc9,transparent 65%),linear-gradient(176deg,#ffffff66,transparent 40%,#89a4c220 80%,#f0f7fe80);transition:opacity 180ms;opacity:.76;}
  .liquid-toggle:active .liquid-thumb::after,.liquid-toggle:active .dock-thumb::after{opacity:1;}
  .liquid-toggle[data-tone="light"] .seg-btn[aria-pressed="true"]{color:var(--ink)!important;text-shadow:0 1px 0 #ffffff66;}
  .liquid-toggle[data-tone="dark"] .seg-btn[aria-pressed="true"]{color:#1f262d!important;text-shadow:0 1px 0 #ffffff66;}
  [data-theme="dark"] .liquid-toggle[data-tone="light"] .seg-btn[aria-pressed="true"]{color:#1f262d!important;}
  .source-drop{background:linear-gradient(150deg,#f0f7febf,#f6fafe12 50%,#8499b214);border-color:var(--surface-rim);}
  .create-heading{margin:0 auto 32px;max-width:620px;}
  .create-heading h1{font-size:clamp(36px,5.2vw,60px);}
  .create-heading>p:last-child{font-size:14px;letter-spacing:.07em;line-height:1.9;}
  .service-status{max-width:610px;margin:0 auto 30px;padding:14px 0;display:flex;align-items:center;gap:11px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:12px;color:var(--ink2);}
  .service-status i{display:block;flex:none;width:5px;height:5px;border-radius:50%;background:var(--ink3);}
  .service-status.is-ready i{background:#697c92;box-shadow:0 0 0 4px #74879d12;}
  .service-status.is-checking i{animation:service-breathe 1.5s ease-in-out infinite;}
  .service-status button{margin-left:auto;border:0;background:none;color:var(--ink2);font-size:11px;padding:5px 8px;}
  .service-status small{margin-left:auto;font-family:Consolas,monospace;letter-spacing:.05em;font-size:9px;color:var(--ink3);}
  .developer-settings{margin:0 auto 24px;max-width:610px;font-size:11px;color:var(--ink3);}
  .developer-settings summary{cursor:pointer;padding:7px 0;}
  .developer-settings .compute-panel{margin-top:12px;}
  .dz{min-height:330px!important;border-radius:13px!important;background:linear-gradient(140deg,#a4b3c514,var(--card))!important;padding:42px!important;}
  .dz-rect{stroke:var(--line2);stroke-dasharray:5 6;stroke-width:1;}
  .dz-arrow{background:var(--ink)!important;color:var(--bg)!important;width:48px!important;height:48px!important;font-size:22px!important;}
  .dz>span:last-child{background:var(--ink)!important;color:var(--bg)!important;padding:11px 26px!important;font-size:13px!important;}
  .dz-over{background:color-mix(in srgb,var(--accent) 10%,var(--card))!important;}
  .dz-over .dz-arrow{box-shadow:0 14px 30px -14px #3a557480;}
  .dz-swap{font-size:20px!important;font-weight:400;letter-spacing:.055em;}
  .dz-swap:nth-of-type(3){font-size:12px!important;letter-spacing:0;}
  .video-option{font-size:12px;gap:8px;line-height:1.7;}
  .compute-note{color:var(--ink3);font-size:11px;}
  .develop-stage{background:linear-gradient(145deg,#ccd3dc0c,var(--bg2));border-radius:15px;border-color:var(--line);padding:28px 22px;}
  .develop-mat{padding:13px;background:linear-gradient(140deg,#a4b2c3,#626d79 25%,#a6b4c4 60%,#596675);border-radius:2px;box-shadow:inset 0 0 0 2px #dce8f520,0 20px 40px -25px #22272d99;}
  .develop-light{animation:none;display:none;}
  .develop-caption{font-size:12px;letter-spacing:.05em;}
  .develop-painting figcaption{font-family:SFMono-Regular,Consolas,monospace;font-size:9px!important;letter-spacing:.12em!important;}
  .status-orb{width:5px;height:5px;box-shadow:0 0 0 4px #74879d12;}
  .gallery-card{border-radius:14px;box-shadow:0 12px 26px -22px #272d3469;}
  .gallery-actions button:first-child{background:var(--ink);color:var(--bg);}
  .gallery-cache-label.local,.gallery-save-status.local{color:#576f8b;}
  .gallery-empty{border-radius:15px;padding:64px 24px;background:#a1b0c20a;}
  .gallery-empty button{background:var(--ink);color:var(--bg);}
  .doubao-settings{border-radius:15px;}
  .doubao-emblem{border-radius:11px;background:#7591b014;}
  .prompt-picker{border-radius:15px!important;}
  .prompt-tile{border-radius:10px!important;background:var(--glass)!important;}
  .prompt-tile[aria-pressed=true]{background:#7791af20!important;}
  .prompt-preview summary{color:var(--accent);}
  .loop-fill{background:linear-gradient(90deg,#4d637d,#9fb2c7);}
  .home-title{font-size:clamp(39px,6.8vw,72px)!important;}
  .home-hero{padding-top:72px!important;}
  .home-hero>div:first-child{font-family:SFMono-Regular,Consolas,monospace;font-size:15px!important;letter-spacing:-.035em!important;font-weight:400!important;}
  .home-page .step-card{border-radius:15px!important;}
  .step-number{color:var(--accent);font-family:Consolas,monospace;}
  .motion-section{background:#191d21!important;}
  .motion-section>div{filter:sepia(.15);}
  .closing-section::before{background:radial-gradient(ellipse,#93a8c01b,transparent 68%);}
  .page-enter{animation:interior-arrive 480ms cubic-bezier(.16,1,.3,1) both!important;}
  .page-enter[data-page="gallery"]{animation-name:interior-gallery!important;}
  .page-enter[data-page="enhance"]{animation-name:interior-slide!important;}
  .route-wipe{position:fixed;inset:66px 0 0;z-index:95;pointer-events:none;background:linear-gradient(160deg,var(--bg),color-mix(in srgb,var(--bg) 90%,transparent));transform-origin:top;animation:route-wipe 440ms cubic-bezier(.16,1,.3,1) both;}
  .route-wipe::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--line2);}
  @keyframes route-wipe{0%{transform:scaleY(1);opacity:.86;}100%{transform:scaleY(0);opacity:0;}}
  @keyframes interior-arrive{from{opacity:0;transform:translate3d(0,34px,0);}to{opacity:1;transform:none;}}
  @keyframes interior-slide{from{opacity:0;transform:translate3d(28px,0,0);}to{opacity:1;transform:none;}}
  @keyframes interior-gallery{from{opacity:0;transform:translate3d(0,24px,0) scale(.97);}to{opacity:1;transform:none;}}
  @keyframes service-breathe{50%{opacity:.3;}}
  .overview-intro{max-width:1100px;margin:0 auto;padding:64px 24px 28px;display:grid;grid-template-columns:1.25fr 1fr;align-items:end;gap:60px;}
  .overview-intro .home-title{font-size:clamp(34px,4.3vw,58px)!important;margin:0;line-height:1.45!important;}
  .overview-context{padding-bottom:7px;}
  .overview-context p{font-size:14px;line-height:1.95;color:var(--ink2);margin:0 0 25px;max-width:29em;}
  .overview-actions{display:flex;align-items:center;gap:22px;}
  .editorial-primary{display:inline-flex;align-items:center;justify-content:space-between;gap:28px;background:var(--ink);color:var(--bg);border:1px solid transparent;border-radius:99px;font-size:13px;padding:13px 23px;white-space:nowrap;box-shadow:inset 0 1px 0 #ffffff1a;}
  .editorial-primary span{font-size:18px;transition:transform 220ms;}
  .editorial-primary:hover span{transform:translate(3px,-3px);}
  .editorial-link{border:0;background:none;color:var(--ink2);padding:10px 0;font-size:12px;border-bottom:1px solid var(--line2);}
  .home-page>section:nth-child(2){max-width:1100px!important;padding:28px 24px 12px!important;}
  .home-page>section:nth-child(2)>div:first-child{border-radius:15px!important;box-shadow:0 24px 40px -30px #1d263266!important;}
  .demo-caption{max-width:1052px;margin:9px auto 0;padding:0 24px;text-align:center;font-size:11px;color:var(--ink3);line-height:1.8;}
  .workflow-flow{max-width:1052px;display:grid;grid-template-columns:.9fr 1.4fr;gap:64px;margin:58px auto 0;padding:38px 0 0;border-top:1px solid var(--line2);}
  .workflow-intro h2,.compute-story h2,.overview-start h2{font-size:clamp(27px,3.5vw,39px);line-height:1.5!important;margin:0 0 13px;}
  .workflow-intro>p{font-size:13px;line-height:1.8;color:var(--ink3);}
  .workflow-list{list-style:none;margin:0;padding:0;display:grid;gap:0;}
  .workflow-list li{display:grid;grid-template-columns:32px 1fr;gap:16px;padding:0 0 22px;margin-bottom:22px;border-bottom:1px solid var(--line);}
  .workflow-list li:last-child{border:0;margin-bottom:0;padding-bottom:0;}
  .workflow-list li>span{font:11px/2 SFMono-Regular,Consolas,monospace;color:var(--accent);padding-top:2px;}
  .workflow-list h3{font-size:16px;font-weight:500;margin:0 0 8px;}
  .workflow-list p{font-size:12px;line-height:1.9;color:var(--ink2);margin:0;max-width:36em;}
  .workflow-flow{gap:54px;align-items:start;}
  .workflow-list{padding-top:7px;}
  .workflow-list li{display:block;padding-bottom:12px;margin-bottom:12px;}
  .workflow-step{display:grid;grid-template-columns:32px 1fr 14px;gap:14px;align-items:start;width:100%;padding:13px 12px 14px 8px;text-align:left;color:var(--ink);background:none;border:0;border-radius:10px;cursor:pointer;}
  .ruhua-root .workflow-step:hover{transform:none!important;box-shadow:none!important;}
  .workflow-step>span:first-child{font:11px/2 SFMono-Regular,Consolas,monospace;color:var(--accent);padding-top:2px;}
  .workflow-step strong{display:block;font-size:16px;font-weight:500;margin:0 0 8px;}
  .workflow-step>span>span{display:block;font-size:12px;line-height:1.9;color:var(--ink2);}
  .workflow-step>i{font-size:15px;font-style:normal;color:var(--accent);padding-top:2px;opacity:0;transform:translate(-4px,4px);transition:opacity 180ms,transform 250ms;}
  .workflow-step[aria-pressed="true"]{background:linear-gradient(100deg,#819ab612,#819ab603);}
  .workflow-step[aria-pressed="true"]>i{opacity:1;transform:none;}
  .workflow-preview{margin:24px 0 0;max-width:370px;}
  .workflow-preview-scene{position:relative;aspect-ratio:360/220;overflow:hidden;border:1px solid var(--line2);border-radius:10px;background:linear-gradient(140deg,#8799ae22,#b6c6d81c 50%,#a6b6c838);perspective:650px;isolation:isolate;}
  .workflow-preview-grid{position:absolute;inset:-25%;opacity:0;background-image:linear-gradient(#506b8a20 1px,transparent 1px),linear-gradient(90deg,#506b8a20 1px,transparent 1px);background-size:24px 24px;transform:rotateX(50deg) rotateZ(-12deg) translateY(40px);transition:opacity 400ms;}
  .workflow-preview-plane{position:absolute;inset:17px 49px 29px;border:1px solid #e8eff76e;box-shadow:0 16px 26px -17px #232f3d9e;transform:translate3d(0,0,0);transition:transform 550ms cubic-bezier(.16,1,.3,1),box-shadow 450ms;}
  .workflow-preview-plane img{display:block;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 48%;transition:opacity 450ms;}
  .workflow-point-photo{opacity:0;mask-image:radial-gradient(circle,#000 47%,transparent 57%);-webkit-mask-image:radial-gradient(circle,#000 47%,transparent 57%);mask-size:5px 5px;-webkit-mask-size:5px 5px;}
  .workflow-preview[data-stage="1"] .workflow-preview-plane{transform:translate3d(-8px,-3px,0) rotateY(-18deg) rotateX(7deg);box-shadow:14px 17px 0 -3px #58718d21,0 18px 28px -14px #232f3d55;}
  .workflow-preview[data-stage="1"] .workflow-photo{opacity:.12;}
  .workflow-preview[data-stage="1"] .workflow-point-photo{opacity:1;}
  .workflow-preview[data-stage="1"] .workflow-preview-grid,.workflow-preview[data-stage="2"] .workflow-preview-grid{opacity:1;}
  .workflow-preview[data-stage="2"] .workflow-preview-plane{transform:translate3d(0,-13px,0) rotateY(12deg) scale(.92);}
  .workflow-preview[data-stage="2"] .workflow-photo{opacity:.85;}
  .workflow-camera-path{position:absolute;inset:0;width:100%;height:100%;color:#b1c8e3;opacity:0;transition:opacity 300ms;filter:drop-shadow(0 1px 2px #1d242d66);}
  .workflow-preview[data-stage="2"] .workflow-camera-path{opacity:1;}
  .workflow-path-shadow{stroke:#2936448c;stroke-width:5;}
  .workflow-path-line{stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;}
  .workflow-preview[data-stage="2"] .workflow-path-line{animation:workflow-path 900ms cubic-bezier(.16,1,.3,1) both;}
  .workflow-preview-index{position:absolute;left:12px;bottom:10px;font:8px SFMono-Regular,Consolas,monospace;letter-spacing:.12em;color:var(--ink2);}
  .workflow-preview figcaption{display:flex;justify-content:space-between;gap:12px;font-size:10px;line-height:1.65;color:var(--ink2);padding-top:10px;}
  .workflow-preview figcaption small{flex:none;font-size:9px;color:var(--ink3);}
  .workflow-preview-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;}
  .workflow-preview-controls>div{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:99px;background:linear-gradient(145deg,var(--glass),transparent);box-shadow:inset 0 1px 0 var(--surface-rim);}
  .workflow-preview-controls button{border:0;border-radius:99px;color:var(--ink2);background:transparent;padding:7px 14px;font-size:10px;cursor:pointer;}
  .workflow-preview-controls button[aria-pressed="true"]{color:var(--ink);background:#7590af21;box-shadow:inset 0 1px 1px var(--surface-rim);}
  .workflow-preview-controls .workflow-preview-play{display:flex;align-items:center;gap:5px;background:none;box-shadow:none;font-size:10px;padding:9px 5px;}
  .workflow-preview-play>span{font:12px/1 Consolas,monospace;color:var(--accent);}
  .workflow-preview-play>svg{flex:none;color:var(--accent);}
  @media(pointer:coarse){.workflow-preview-controls button{min-height:36px;}.workflow-preview-controls .workflow-preview-play{min-width:56px;}}
  @keyframes workflow-path{to{stroke-dashoffset:0;}}
  @media(max-width:740px){.workflow-flow{gap:15px;}.workflow-preview{max-width:none;margin-top:18px;}.workflow-preview-scene{aspect-ratio:360/205;}.workflow-list{padding-top:0;}.workflow-step{padding-left:0;grid-template-columns:27px 1fr 12px;gap:12px;}.workflow-preview figcaption{font-size:9px;}.workflow-preview figcaption small{font-size:8px;}}
  @media(prefers-reduced-motion:reduce){.workflow-preview-plane,.workflow-preview-plane img,.workflow-preview-grid,.workflow-camera-path,.workflow-step>i{transition:none;}.workflow-preview[data-stage] .workflow-preview-plane{transform:none;}.workflow-preview[data-stage="2"] .workflow-path-line{animation:none;stroke-dashoffset:0;}.ruhua-root .workflow-step:active{transform:none!important;}}
  .compute-story{max-width:1052px;margin:42px auto 0;padding:36px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
  .compute-story-layout{display:grid;grid-template-columns:1.5fr 1fr;gap:64px;align-items:center;}
  .compute-story p{font-size:13px;line-height:1.9;color:var(--ink2);max-width:37em;margin:15px 0 18px;}
  .compute-spec{display:flex;align-items:center;gap:14px;font-size:10px;color:var(--ink3);letter-spacing:.02em;}
  .compute-spec i{width:22px;height:1px;background:var(--line2);}
  .compute-story figure{margin:0;position:relative;overflow:hidden;border-radius:12px;background:#161a1e;}
  .compute-story img{width:100%;height:195px;object-fit:contain;display:block;filter:saturate(.65);}
  .compute-story figcaption{position:absolute;left:14px;bottom:12px;font-size:8px;letter-spacing:.1em;color:#bccad98c;}
  .overview-start{max-width:1052px;margin:0 auto;padding:42px 0;display:flex;align-items:center;justify-content:space-between;gap:32px;}
  .overview-start h2{font-size:30px;margin-bottom:10px;}
  .overview-start p{font-size:12px;color:var(--ink3);line-height:1.7;margin:0;}
  .overview-footer{display:flex;align-items:center;gap:10px;max-width:1052px;margin:0 auto;padding:22px 0 28px;border-top:1px solid var(--line);color:var(--ink3);font-size:10px;}
  .overview-footer span:last-child{margin-left:auto;font-size:9px;letter-spacing:.03em;}
  @media(max-width:1120px){.workflow-flow,.compute-story,.overview-start,.overview-footer{margin-left:24px;margin-right:24px;}}
  @media(max-width:740px){.overview-intro{grid-template-columns:1fr;gap:22px;padding:37px 24px 12px;}.overview-intro .home-title{font-size:38px!important;}.overview-context p{font-size:13px;margin-bottom:20px;}.workflow-flow{grid-template-columns:1fr;gap:22px;margin-top:36px;padding-top:28px;}.workflow-intro h2{font-size:30px;}.workflow-intro>p{margin:0;}.compute-story-layout{grid-template-columns:1fr;gap:22px;}.compute-story h2{font-size:30px;}.compute-story img{height:160px;}.overview-start{display:block;padding:32px 0;}.overview-start .editorial-primary{margin-top:22px;}.overview-start h2{font-size:29px;}.overview-footer span:last-child{display:none;}}
  @media(max-width:740px){.nav-bar{height:60px;padding:0 18px!important;}.nav-logo{margin-right:20px;}.nav-logo .brand-name{display:none;}.nav-tabs{gap:19px;}.nav-cta{padding:9px 13px;font-size:11px;}.nav-right{gap:9px;}.nav-theme{width:30px;height:30px;}.route-wipe{top:60px;}.ruhua-root main{padding-top:44px!important;}.home-hero{padding-top:46px!important;}.dz{padding:30px 17px!important;min-height:290px!important;}.dz-swap{font-size:18px!important;}.create-heading{margin-bottom:24px;}.service-status{font-size:11px;}.develop-stage{padding:22px 12px;}}
  @media(prefers-reduced-motion:reduce){.page-enter{animation:interior-fade 180ms linear both!important;}.route-wipe{display:none;}.ruhua-root button:not(:disabled){transition:background 160ms,color 160ms,opacity 160ms!important;}.ruhua-root button:hover,.ruhua-root button:active{transform:none!important;}.service-status.is-checking i{animation:none;}}
  @media(max-width:740px){.nav-drop{top:13px;height:33px;}.nav-tabs{padding:0 10px;}}
  @media(prefers-reduced-motion:reduce){.nav-drop{transition:none;}.editorial-primary:hover span{transform:none;}}
  @keyframes interior-fade{from{opacity:0;}to{opacity:1;}}
  `}</style>;
}
