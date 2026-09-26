"use client";
// 界面背景：液态玻璃（画质“极致”档，独立显卡）。参考 iOS 26 的液态玻璃壁纸：
// 两片互相错开的磨砂玻璃圆片（浅色：雾蓝与薄荷；深色：香槟金与烟熏茶色，黑金配色），
// 一片几乎透明的大玻璃横扫画面，只看得见它细亮的边——“丝带”；弧线内侧的圆片被它折射错位，带一点色散。
// 窗外的光透过百叶窗落下斜向光带，在玻璃里更明显；玻璃有细颗粒、斜面边缘、落在身后的柔影。
// 颜色整体克制，正文区域再向页面底色收一些。圆片、光带缓慢移动，指针移动时有视差。
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
uniform float DARK;  // 1 in dark theme (black & gold)

float A;             // aspect ratio; scene coordinates: x in [0, A], y in [0, 1] (up)
float PX;            // one pixel in scene units

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// 窗外的光透过百叶窗落下的斜向光带，缓慢移动
float blinds(vec2 p){
  float u = dot(p, normalize(vec2(1., -.58))) * 4.2 + T*.03;
  float bars = smoothstep(.05, .95, .5 + .5*sin(u*6.2832));
  return bars * (.55 + .45*sin(u*1.3 + 1.3)) * smoothstep(-.1, .6, p.y + p.x*.25);
}

vec3 background(vec2 p){
  vec3 a = mix(vec3(.955,.952,.94), vec3(.035,.032,.028), DARK);
  vec3 b = mix(vec3(.87,.90,.94), vec3(.085,.07,.05), DARK);
  vec3 c = mix(a, b, smoothstep(-.2, 1.2, (p.x / A)*.8 + (1. - p.y)*.5));
  c *= 1. - .035*blinds(p)*(1. - DARK*.4);
  // 深色：右下方一团很淡的暖光，黑底不至于死黑
  c += DARK * vec3(.09,.065,.03) * exp(-dot(p - vec2(A*.62, .35), p - vec2(A*.62, .35)) * 3.);
  return c;
}

// 一片磨砂玻璃圆片：着色、边缘斜面、细颗粒、落在后面的柔影
vec3 disc(vec3 under, vec2 p, vec2 c, float r, vec3 tint, float frost){
  float d = length(p - c);
  // 投影：落向右下方，只在圆片外
  float sd = length(p - c - vec2(.025, -.035)) - r;
  under *= 1. - .16 * exp(-max(sd, 0.) * 18.) * step(r, d);
  if (d > r + PX) return under;
  float edge = r - d;
  vec3 g = mix(under, tint, frost);                         // 磨砂：后面的颜色被打散、染色
  g *= .92 + .12 * blinds(p);                                // 光带在玻璃里更明显
  // 纵深：玻璃朝右下方逐渐变深，左上方迎光更亮（参考壁纸的体积感）
  float t = clamp(dot(p - c, normalize(vec2(.55, -.84))) / r * .5 + .5, 0., 1.);
  g *= mix(1.08, .8, t);
  g += (hash(floor(p / PX)) - .5) * .03;                     // 玻璃表面的细颗粒
  g = mix(g, g * .82, smoothstep(.03, .0, edge) * .6);       // 斜面：边缘一圈更厚更深
  g += smoothstep(1.6*PX, 0., abs(edge - 1.2*PX)) * mix(.55, .45, DARK) * (.55 + .45*dot(normalize(p - c), normalize(vec2(-.6, .8))));
  float aa = smoothstep(-PX, PX, edge);                      // 抗锯齿的圆边
  return mix(under, g, aa);
}

// 背景 + 两片圆片（不含最前面那片透明大玻璃）
vec3 layers(vec2 p){
  vec3 c = background(p);
  vec2 q = p + P * vec2(-.01, .006);                         // 圆片随指针轻微视差
  vec3 tintA = mix(vec3(.42,.52,.76), vec3(.72,.58,.34), DARK);   // 浅色：雾蓝；深色：香槟金
  vec3 tintB = mix(vec3(.64,.80,.76), vec3(.16,.135,.10), DARK);  // 浅色：薄荷；深色：烟熏茶色玻璃
  c = disc(c, q, vec2(A*.80 + .015*sin(T*.06), .88 + .012*sin(T*.05)), .5, tintA, .72);
  c = disc(c, q, vec2(A*.16 + .012*sin(T*.05 + 1.), .1 + .015*sin(T*.07)), .62, tintB, mix(.62, .7, DARK));
  return c;
}

vec3 shade(vec2 frag){
  vec2 p = frag / R.y;
  // 最前面：一片很薄的透明大玻璃，只看得见它的边——一道扫过画面的细亮弧线（“丝带”）。
  // 弧线内侧的东西被它折射，整体错开一点，这就是参考壁纸里圆片被“切断错位”的效果。
  vec2 cc = vec2(A*1.18 + .03*sin(T*.04), -.52) + P * vec2(-.018, .01);
  float rr = 1.42 + .02*sin(T*.05);
  float d = length(p - cc) - rr;
  vec3 col;
  if (d < 0.) {
    vec2 n = normalize(p - cc);
    float lens = exp(d * 9.);                                // 越靠近边缘弯折越强
    vec2 off = -n * (.022 + .05*lens);
    // 三个通道偏移略不同：边缘带一点色散
    col = vec3(layers(p + off*1.04).r, layers(p + off).g, layers(p + off*.96).b);
    col = col * mix(1.03, 1.08, DARK) + mix(.015, .01, DARK);
  } else {
    col = layers(p);
  }
  // 弧线本身：一条极细的高光，深色主题里是金色
  vec3 lineCol = mix(vec3(.96,.98,1.), vec3(.93,.80,.52), DARK);
  col += lineCol * (exp(-pow(d / (1.1*PX), 2.)) * .75 + exp(-abs(d) * 90.) * .06);
  return col;
}

void main(){
  A = R.x / R.y;
  PX = 1. / R.y;
  vec3 c = vec3(0.);
  for (int i = 0; i < 4; i++){
    if (float(i) >= SS) break;
    vec2 o = SS > 1.5 ? (i == 0 ? vec2(.125,.375) : i == 1 ? vec2(-.375,.125) : i == 2 ? vec2(-.125,-.375) : vec2(.375,-.125)) : vec2(0.);
    c += shade(gl_FragCoord.xy + o);
  }
  c /= SS;
  // 正文区域再向页面底色收一些，颜色整体克制
  vec2 uv = gl_FragCoord.xy / R;
  float calm = smoothstep(.34, .1, abs(uv.x - .5)) * .3;
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
