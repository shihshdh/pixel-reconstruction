"use client";
// 界面背景：液态玻璃（画质“极致”档，独立显卡）。参考 macOS Tahoe 的液态玻璃壁纸：
// 一整片从左下卷向右上的弯曲玻璃浪面，边缘是一条极细的高光线；透过玻璃看到的是柔焦的天空、
// 颜色不停变化的流光与沙丘状色块。
//
// 每个像素沿视线与玻璃曲面求交（屏幕空间光线追踪）：由厚度场求表面法线，按斯涅尔定律折射，
// 三个颜色通道折射率略不同（色散）；玻璃内部的褶皱像柱面透镜，把视线弯向上方的天空，
// 形成蓝色玻璃里浅色的流纹；菲涅尔反射映出天空，Beer–Lambert 吸收让厚处更深。
// 玻璃浪面随时间起伏、流纹沿浪势流动，指针移动时玻璃与后景有视差。
//
// 画质：按屏幕实际像素比渲染，每像素 4 次旋转网格超采样抗锯齿。
// 性能与体验：帧率跟随屏幕刷新率（最高 120fps）；持续掉帧依次关超采样、降到 30fps、降分辨率，仍不够就停在静帧。
// 页面隐藏、进入 3D 工作室（active=false）时停止，让显卡专心渲染场景；减少动态效果时只画一帧。
import { useEffect, useRef } from "react";
import { measureRefreshRate } from "@/lib/perf";

const VERTEX = `
attribute vec2 a;
void main(){gl_Position=vec4(a,0.,1.);}
`;

const FRAGMENT = `
precision highp float;
uniform vec2 R;      // canvas size (px)
uniform float SS;    // samples per pixel: 4 = rotated-grid supersampling, 1 = off
uniform float T;     // seconds
uniform vec2 P;      // smoothed pointer, -1..1
uniform vec3 BG;     // page background colour
uniform float DARK;  // 1 in dark theme

const float IOR = 1.5;
float A;             // aspect ratio; scene coordinates: x in [0, A], y in [0, 1] (up)

// 颜色随时间不停轮转的光谱（余弦调色板）
vec3 spectrum(float t){ return .5 + .5*cos(6.2832*(t + vec3(0., .33, .67))); }

// ---- 后景：柔焦的天空、流动的光带与沙丘状色块（透过玻璃会被折射） ----
vec3 backdrop(vec2 p){
  // 视差：后景移动得比玻璃少，形成纵深
  p += P * vec2(.006, -.004);
  float t = T;
  vec3 skyTop = mix(vec3(.40,.62,.93), vec3(.07,.05,.40), DARK);
  vec3 skyLow = mix(vec3(.95,.965,.985), vec3(.43,.33,.84), DARK);
  vec3 c = mix(skyLow, skyTop, smoothstep(.38, 1.05, p.y));
  // 流光：天空里两条颜色不停变化的光带，缓慢流动
  float w1 = p.y - .74 - .05*sin(p.x*1.6 + t*.11) - .025*sin(p.x*4.1 - t*.07);
  float w2 = p.y - .9 - .04*sin(p.x*2.3 - t*.09 + 1.3);
  vec3 h1 = spectrum(t*.03 + p.x*.07), h2 = spectrum(t*.03 + .4 - p.x*.05);
  c += ((h1 - .35) * exp(-w1*w1*38.) * .32 + (h2 - .35) * exp(-w2*w2*60.) * .22) * mix(.35, 1.2, DARK);
  // 左侧远处的青蓝色小丘
  float hill = p.y - (.4 + .13*exp(-pow((p.x - .22 - .03*sin(t*.07)) * 3.2, 2.)));
  c = mix(c, mix(vec3(.05,.66,.86), vec3(.14,.22,.72), DARK), smoothstep(.07, -.07, hill) * .92);
  // 右侧大块钴蓝，内部一团天蓝色辉光
  vec2 q = p - vec2(A*.64 + .04*sin(t*.05), .2 + .02*sin(t*.06 + 1.));
  float mass = length(q * vec2(.78, 1.2)) - .46;
  c = mix(c, mix(vec3(.0,.27,.86), vec3(.02,.09,.62), DARK), smoothstep(.28, -.22, mass));
  vec2 g = q - vec2(.02, .13);
  c += mix(vec3(.26,.48,.62), vec3(.14,.2,.5), DARK) * exp(-dot(g, g) * 8.) * .7;
  // 前景两块浅色柔影（左下、右下）
  float s1 = length((p - vec2(A*.2, -.2)) * vec2(.85, 1.35)) - .42;
  c = mix(c, mix(vec3(.80,.87,.94), vec3(.44,.49,.82), DARK), smoothstep(.13, -.13, s1));
  float s2 = length((p - vec2(A*1.03, -.08)) * vec2(1.1, .78)) - .46;
  c = mix(c, mix(vec3(.84,.9,.95), vec3(.5,.55,.84), DARK), smoothstep(.1, -.1, s2) * .95);
  return c;
}

// ---- 玻璃浪面：一道从左下卷向右上的弯曲玻璃 ----
// 浪峰线 y = crest(x)；浪面在线的下方。厚度场 h(p) 决定表面法线，从而决定折射偏移。
float crest(float x){
  float u = x / A;
  return .52 + .56*sin((u - .52) * 2.7) + .035*sin(x*2.1 + T*.21) + .018*sin(x*5.3 - T*.33);
}
float thickness(vec2 p){
  p -= P * vec2(.018, -.012);                       // 玻璃视差更大：离得更近
  float y = crest(p.x);
  float slope = (crest(p.x + .01) - crest(p.x - .01)) / .02;
  float d = (y - p.y) / sqrt(1. + slope*slope);     // 到浪峰线的距离，浪面内为正
  if (d < 0.) return d;                              // 负值：浪面之外
  // 浪峰处一道卷起的厚唇，往里渐薄；右上方有顺浪势流动的细纹
  float h = smoothstep(0., .1, d) * (1. - .35*smoothstep(.12, .7, d)) + .25*exp(-d*28.);
  float along = p.x;
  h += .07 * sin(d*42. - T*.55 + along*1.8) * smoothstep(.02, .09, d) * smoothstep(.55, .1, d) * smoothstep(A*.3, A*.9, along);
  h += .012 * sin(d*110. + T*.4 - along*3.) * smoothstep(.01, .05, d) * smoothstep(.3, .05, d);
  return h;
}

vec3 shade(vec2 frag){
  vec2 p = vec2(frag.x / R.y, frag.y / R.y);
  float h = thickness(p);
  vec3 bg = backdrop(p);
  float px = 1. / R.y;
  // 浪面外：后景 + 浪峰上方一圈淡淡的光晕
  if (h < 0.) {
    float d = -h;
    return bg + mix(vec3(.9,.95,1.), vec3(.55,.62,1.), DARK) * exp(-d * 90.) * .12;
  }
  // 表面法线：厚度场的梯度
  float e = 1.5 * px;
  float hx = thickness(p + vec2(e, 0.)) - thickness(p - vec2(e, 0.));
  float hy = thickness(p + vec2(0., e)) - thickness(p - vec2(0., e));
  vec3 n = normalize(vec3(-hx / (2.*e) * .045, -hy / (2.*e) * .045, 1.));
  // 斯涅尔折射：视线垂直入射，按法线弯折；三个颜色通道折射率略不同（色散）
  vec3 v = vec3(0., 0., -1.);
  float depth = .22 + .18*h;
  // 玻璃内部的褶皱像柱面透镜：把视线向上弯，采到上方浅色的天空，于是蓝色玻璃里出现一道道浅色流纹。
  // 浪峰下方的厚唇同理，折射进来的是天空而不是发光。
  float yc = crest(p.x - P.x*.018);
  float dd = yc - (p.y + P.y*.012);
  float fold = pow(.5 + .5*sin(dd*34. - T*.5 + p.x*1.7), 4.) * smoothstep(.03, .1, dd) * smoothstep(.6, .12, dd) * smoothstep(A*.25, A*.85, p.x);
  float fold2 = pow(.5 + .5*sin(dd*21. + T*.32 - p.x*2.4 + 1.), 6.) * smoothstep(.1, .25, dd) * smoothstep(.8, .3, dd) * .7;
  float lip = smoothstep(.07, .0, dd);
  vec2 lift = vec2(-.04, 1.) * (fold * .42 + fold2 * .3 + lip * .34);
  vec3 rr = refract(v, n, 1./(IOR - .012)), rg = refract(v, n, 1./IOR), rb = refract(v, n, 1./(IOR + .014));
  // 磨砂感：每个通道再取两处轻微偏开的样本（浅景深）
  vec2 j = vec2(.004, .003);
  vec3 col;
  col.r = (backdrop(p + rr.xy*depth + lift*1.03 + j).r + backdrop(p + rr.xy*depth + lift*1.03 - j).r) * .5;
  col.g = (backdrop(p + rg.xy*depth + lift + j.yx).g + backdrop(p + rg.xy*depth + lift - j.yx).g) * .5;
  col.b = (backdrop(p + rb.xy*depth + lift*.97 - j).b + backdrop(p + rb.xy*depth + lift*.97 + j).b) * .5;
  // 玻璃本身的淡蓝色吸收（Beer–Lambert）
  col *= exp(-vec3(.75, .38, .06) * h * (1. - .6*max(fold, lip)) * mix(.85, .7, DARK));
  // 菲涅尔反射：映出天空与柔光（光从左上方来）
  float cosT = max(0., n.z);
  float fr = .04 + .96 * pow(1. - cosT, 5.);
  vec3 L = normalize(vec3(-.55, .65, .52));
  vec3 refl = backdrop(vec2(p.x - n.x*.3, .82 + .15*(1. - cosT))) * (.8 + .35*max(0., dot(reflect(v, n), L)));
  col = mix(col, refl, clamp(fr * .9, 0., .38));
  // 高光：表面朝向光源处的镜面反射
  vec3 hv = normalize(L - v);
  col += pow(max(0., dot(n, hv)), 120.) * mix(.3, .28, DARK);
  // 浪峰边缘：一条极细极亮的高光线，内侧再有一条更淡的次级线
  float y = crest(p.x - P.x*.018);
  float slope = (crest(p.x + .01) - crest(p.x - .01)) / .02;
  float d = (y - (p.y + P.y*.012)) / sqrt(1. + slope*slope);
  float edge = exp(-pow(d / (1.1*px), 2.)) * .95 + exp(-pow((d - .006) / (1.6*px), 2.)) * .22;
  // 边线亮度沿浪峰流动变化，颜色带一点青色
  edge *= .75 + .25*sin(p.x*3. - T*.5);
  col += mix(vec3(.85,.97,1.), vec3(.7,.8,1.), DARK) * edge;
  return col;
}

void main(){
  A = R.x / R.y;
  vec3 c = vec3(0.);
  for (int i = 0; i < 4; i++){
    if (float(i) >= SS) break;
    vec2 o = SS > 1.5 ? (i == 0 ? vec2(.125,.375) : i == 1 ? vec2(-.375,.125) : i == 2 ? vec2(-.125,-.375) : vec2(.375,-.125)) : vec2(0.);
    c += shade(gl_FragCoord.xy + o);
  }
  c /= SS;
  // 正文区域向页面底色收一些，保证可读；四周保持壁纸的饱和度
  vec2 uv = gl_FragCoord.xy / R;
  float calm = smoothstep(.36, .12, abs(uv.x - .5)) * mix(.3, .3, DARK);
  c = mix(c, BG, calm);
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453) - .5) / 255.; // 抖动去色带
  gl_FragColor = vec4(c, 1.);
}
`;

function parseColor(value: string): [number, number, number] {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  const rgb = value.match(/(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/);
  if (rgb) return [+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255];
  return [1, 1, 1];
}

export default function RayTracedBackdrop({ theme, active }: { theme: string; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => { if (active) wakeRef.current(); }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    if (!gl) { canvas.style.display = "none"; return; }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader");
      return shader;
    };
    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link");
    } catch (error) {
      console.warn("[光追背景] 着色器不可用，已关闭：", error);
      canvas.style.display = "none"; return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const uR = u("R"), uT = u("T"), uP = u("P"), uBG = u("BG"), uDark = u("DARK"), uSS = u("SS");

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 帧率跟随屏幕：取刷新率的整数分频、不超过 120fps（300Hz → 100fps，144Hz → 72fps，60Hz → 60fps），
    // 帧间隔均匀不抖。画质阶梯：满像素比 4× 超采样 → 1× → 降到 30fps → 0.6 倍像素比 → 静帧。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let divisor = 2, fastFps = 30;
    const ladder = [{ scale: dpr, ss: 4, fast: true }, { scale: dpr, ss: 1, fast: true }, { scale: dpr, ss: 1, fast: false }, { scale: dpr * .6, ss: 1, fast: false }];
    let level = 0, scale = ladder[0].scale, ticks = 0;
    const fps = () => ladder[level].fast ? fastFps : 30;
    let raf = 0, last = 0, slowSince = 0, frozen = false, disposed = false;
    void measureRefreshRate().then(hz => { divisor = Math.max(1, Math.ceil(hz / 120)); fastFps = hz / divisor; canvas.dataset.fps = String(Math.round(fastFps)); });
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const started = performance.now();
    const frameTimes: number[] = [];

    const resize = () => {
      const w = Math.max(1, Math.round(innerWidth * scale)), h = Math.max(1, Math.round(innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    };
    const draw = (now: number) => {
      resize();
      pointer.x += (pointer.tx - pointer.x) * .04;
      pointer.y += (pointer.ty - pointer.y) * .04;
      const bg = parseColor(getComputedStyle(canvas.parentElement || document.body).getPropertyValue("--bg") || "#ffffff");
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uSS, ladder[level].ss);
      gl.uniform1f(uT, reduced ? 4 : (now - started) / 1000);
      gl.uniform2f(uP, pointer.x, pointer.y);
      gl.uniform3f(uBG, bg[0], bg[1], bg[2]);
      gl.uniform1f(uDark, document.documentElement.getAttribute("data-theme") === "dark" ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      raf = 0;
      if (disposed || frozen || !activeRef.current || document.hidden) return;
      // 高帧率档按刷新率整数分频；30fps 档按时间间隔
      const due = ladder[level].fast ? ++ticks % divisor === 0 : now - last >= 1000 / 30 - 2;
      if (due) {
        const delta = last ? now - last : 1000 / fps();
        last = now;
        draw(now);
        // 掉帧保护：连续 2 秒平均帧间隔超过目标的 1.5 倍，就往下退一级
        frameTimes.push(delta); if (frameTimes.length > 30) frameTimes.shift();
        const average = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        if (frameTimes.length >= 20 && average > 1500 / fps()) {
          slowSince ||= now;
          if (now - slowSince > 2000) {
            slowSince = 0; frameTimes.length = 0;
            if (level < ladder.length - 1) { level++; scale = ladder[level].scale; canvas.dataset.level = String(level); } else { frozen = true; canvas.dataset.level = "frozen"; return; }
          }
        } else slowSince = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (disposed) return;
      if (reduced || frozen) { draw(performance.now()); return; }
      last = 0;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;
    const onMove = (event: PointerEvent) => { pointer.tx = event.clientX / innerWidth * 2 - 1; pointer.ty = event.clientY / innerHeight * 2 - 1; };
    const onVisible = () => { if (!document.hidden) wake(); };
    const onResize = () => { if (reduced || frozen) draw(performance.now()); };
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);
    const themeObserver = new MutationObserver(() => { if (reduced || frozen) draw(performance.now()); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const onLost = (event: Event) => { event.preventDefault(); frozen = true; canvas.style.display = "none"; };
    canvas.addEventListener("webglcontextlost", onLost);
    wake();
    return () => {
      disposed = true; cancelAnimationFrame(raf);
      removeEventListener("pointermove", onMove); removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      themeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  // 主题切换时静帧也要重画
  useEffect(() => { wakeRef.current(); }, [theme]);

  return <canvas ref={canvasRef} className="ray-backdrop" aria-hidden="true"
    style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 0, pointerEvents: "none", opacity: active ? 1 : 0, transition: "opacity 600ms ease" }} />;
}
