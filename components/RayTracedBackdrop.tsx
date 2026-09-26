"use client";
// 界面背景的实时光线追踪（画质“极致”档，独立显卡）。
//
// 每个像素发出一条光线，与五颗球和一块白色台面求解析交点，最多弹射 6 次：
// - 蓝玻璃球：薄膜干涉的彩虹反射 + 斯涅尔折射穿过球体，Beer–Lambert 染成品牌蓝，并在台面投下焦散光斑；
// - 白瓷球（清漆反射）、铬镜球（多次反射）、磨砂蓝球；
// - 一颗绕场飞行的发光光球作为第二光源，照亮台面与球体，带辉光；
// - 台面：解析软阴影 + 接触遮蔽 + 清晰倒影；天空有缓慢流动的蓝白极光光带。
// 主光方向跟随指针，地平线溶进页面底色，球都放在两侧，不压住正文。
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

const vec3 BLUE = vec3(.0,.443,.890);   // #0071e3 brand blue
const vec3 SKY = vec3(.36,.66,1.);
const float IOR = 1.47;

vec4 S0, S1, S2, S3, S4;  // glass, pearl, chrome, frosted blue, glowing orb
vec3 L;                   // key light direction (towards light)

float sphere(vec3 ro, vec3 rd, vec4 s){
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w*s.w;
  float h = b*b - c;
  if (h < 0.) return -1.;
  float t = -b - sqrt(h);
  return t > 1e-3 ? t : -1.;
}
void test(vec3 ro, vec3 rd, vec4 s, float k, inout float t, inout float id, inout vec3 n){
  float d = sphere(ro, rd, s);
  if (d > 0. && d < t){ t = d; id = k; n = normalize(ro + rd*d - s.xyz); }
}
// 0 none, 1 floor, 2 glass, 3 pearl, 4 chrome, 5 frosted, 6 orb
float hitScene(vec3 ro, vec3 rd, out float t, out vec3 n){
  float id = 0.; t = 1e9; n = vec3(0,1,0);
  float f = rd.y < 0. ? (-1.15 - ro.y) / rd.y : -1.;
  if (f > 1e-3){ t = f; id = 1.; }
  test(ro, rd, S0, 2., t, id, n);
  test(ro, rd, S1, 3., t, id, n);
  test(ro, rd, S2, 4., t, id, n);
  test(ro, rd, S3, 5., t, id, n);
  test(ro, rd, S4, 6., t, id, n);
  return id;
}

float softShadow(vec3 ro, vec3 rd, vec4 s, float k){
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w*s.w;
  float h = b*b - c;
  float d = sqrt(max(0., s.w*s.w - h)) - s.w;
  float t = -b - sqrt(max(h, 0.));
  return (t < 0. || b > 0.) ? 1. : smoothstep(0., 1., k*d/t);
}
float shadow(vec3 p){
  return mix(1., softShadow(p, L, S0, 2.4), .5) * softShadow(p, L, S1, 2.4)
       * softShadow(p, L, S2, 2.4) * softShadow(p, L, S3, 2.4);
}
float occlusion(vec3 p, vec3 n, vec4 s){
  vec3 d = s.xyz - p;
  float l = length(d);
  return 1. - max(0., dot(n, d/l)) * (s.w*s.w) / (l*l);
}
float occlusionAll(vec3 p, vec3 n){
  return occlusion(p, n, S0) * occlusion(p, n, S1) * occlusion(p, n, S2) * occlusion(p, n, S3);
}
// 发光光球作为第二光源：蓝白色，按距离平方衰减
vec3 orbLight(vec3 p, vec3 n){
  vec3 d = S4.xyz - p;
  float l2 = dot(d, d);
  return vec3(.5,.76,1.) * max(0., dot(n, d*inversesqrt(l2))) * 1.1 / (1. + l2*1.6);
}

vec3 env(vec3 rd){
  float up = clamp(rd.y*.5 + .5, 0., 1.);
  vec3 top = mix(vec3(.9,.95,1.02), vec3(.03,.07,.16), DARK);
  vec3 c = mix(BG, top, smoothstep(.5, 1., up));
  c = mix(c, BG * mix(.95, 1., DARK), smoothstep(.5, .2, up));
  // 蓝白极光：两条缓慢流动的光带
  float a1 = sin(rd.x*2.2 + T*.07 + sin(rd.z*1.7 - T*.05)*1.4);
  float band = exp(-pow((rd.y - .32 - .08*a1) * 7., 2.));
  float band2 = exp(-pow((rd.y - .55 + .06*sin(rd.x*3.1 - T*.06)) * 9., 2.));
  c += (SKY * band * .22 + vec3(.75,.88,1.) * band2 * .12) * mix(1., 1.9, DARK) * smoothstep(.45, .6, up);
  // 柔光箱主光 + 冷色轮廓光
  vec3 x = normalize(cross(L, vec3(0,1,0)));
  float box = smoothstep(.72, .96, dot(rd, L)) * smoothstep(.55, .2, abs(dot(rd, x)));
  c += box * mix(1.05, .8, DARK);
  vec3 rim = normalize(vec3(-L.x, .35, -.6));
  c += SKY * smoothstep(.9, .99, dot(rd, rim)) * .5;
  return c;
}

float fresnel(vec3 rd, vec3 n, float f0){ return f0 + (1. - f0) * pow(1. - max(0., dot(-rd, n)), 5.); }
// 薄膜干涉：玻璃表面随视角变化的彩虹色反射
vec3 iridescence(float cosT){
  return .6 + .4*cos(6.2832*(vec3(.0,.33,.67) + 1.6*cosT + .12*sin(T*.2)));
}

vec3 trace(vec3 ro, vec3 rd){
  vec3 acc = vec3(0.), thr = vec3(1.);
  for (int bounce = 0; bounce < 6; bounce++){
    float t; vec3 n;
    float id = hitScene(ro, rd, t, n);
    if (id < .5){ acc += thr * env(rd); break; }
    vec3 p = ro + rd*t;
    if (id < 1.5){
      // 白色亮面台面：阴影、接触遮蔽、光球照明、玻璃球焦散，外加清晰倒影
      float fog = smoothstep(2.5, 9., t);
      vec3 base = mix(vec3(.985,.99,1.), vec3(.05,.08,.14), DARK);
      float ao = occlusionAll(p, n);
      float lit = .5 + .5 * shadow(p + n*1e-3);
      vec3 diffuse = base * lit * ao + orbLight(p, n) * ao;
      // 焦散：玻璃球把主光聚成一团蓝色光斑，落在它的影子里
      vec3 axis = S0.xyz - p;
      float along = dot(axis, L);
      float off = length(axis - L*along);
      float caustic = along > 0. ? exp(-pow(off / (S0.w*.42), 2.)) * (1.2 + .25*sin(T*1.3 + off*20.)) : 0.;
      diffuse += BLUE * caustic * mix(.55, .9, DARK) + vec3(.8,.9,1.) * caustic * .25;
      float fr = fresnel(rd, n, .03) * .7 * (1. - fog);
      acc += thr * mix(diffuse * (1. - fr), BG, fog);
      thr *= fr;
      ro = p + n*1e-3; rd = reflect(rd, n);
    } else if (id < 2.5){
      // 蓝玻璃：彩虹薄膜反射 + 折射穿过球体（Beer–Lambert 染色）
      float cosT = max(0., dot(-rd, n));
      float fr = fresnel(rd, n, .05);
      acc += thr * fr * env(reflect(rd, n)) * iridescence(cosT);
      vec3 r = refract(rd, n, 1./IOR);
      float len = -2. * dot(p - S0.xyz, r);
      vec3 q = p + r*len;
      vec3 nq = normalize(S0.xyz - q);
      vec3 o = refract(r, nq, IOR);
      if (dot(o, o) < 1e-4) o = reflect(r, nq);
      thr *= (1. - fr) * exp(-(1. - BLUE) * len * .5);
      ro = q - nq*1e-3; rd = o;
    } else if (id < 3.5){
      // 白瓷：漫反射底 + 清漆反射
      float dif = max(0., dot(n, L)) * shadow(p + n*1e-3);
      float fr = fresnel(rd, n, .045);
      vec3 body = vec3(.96,.975,1.) * (.42 + .6*dif) + orbLight(p, n) + SKY * .06 * (1. - n.y);
      acc += thr * body * (1. - fr);
      thr *= fr;
      ro = p + n*1e-3; rd = reflect(rd, n);
    } else if (id < 4.5){
      // 铬镜：冷色金属，边缘更亮
      thr *= vec3(.88,.92,.98) * fresnel(rd, n, .7);
      ro = p + n*1e-3; rd = reflect(rd, n);
    } else if (id < 5.5){
      // 磨砂品牌蓝
      float dif = max(0., dot(n, L)) * shadow(p + n*1e-3);
      vec3 h = normalize(L - rd);
      float spec = pow(max(0., dot(n, h)), 60.) * .4;
      float fr = fresnel(rd, n, .04);
      acc += thr * (BLUE * (.3 + .25*n.y + .95*dif) + orbLight(p, n)*.5 + spec) * (1. - fr);
      thr *= fr;
      ro = p + n*1e-3; rd = reflect(rd, n);
    } else {
      // 发光光球：中心近白，边缘天蓝
      float core = pow(max(0., dot(-rd, n)), 2.);
      acc += thr * mix(SKY * 1.1, vec3(1.2,1.25,1.3), core);
      break;
    }
    if (max(thr.r, max(thr.g, thr.b)) < .01) break;
  }
  return acc;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - .5*R) / R.y;
  float aspect = R.x / R.y;
  // 球都放在画面两侧的留白里（视口半宽约 1.31×宽高比），中间留给正文
  float hw = 1.31 * aspect;
  S0 = vec4(-hw*.92, -.48 + .06*sin(T*.55), -.35, .52);
  S1 = vec4(-hw*.66, -.93 + .03*sin(T*.7 + 2.), .9, .22);
  S2 = vec4(hw*.92, .38 + .05*sin(T*.47 + 1.7), -1.5, .46);
  S3 = vec4(hw*.74, -.8 + .03*sin(T*.63 + .6), .6, .3);
  // 光球沿椭圆轨道在右侧缓缓绕行，时而飞到镜面球后面
  float w = T*.23;
  S4 = vec4(hw*.8 + cos(w)*.55, -.25 + .22*sin(w*1.3), -.5 + sin(w)*.9, .09);
  float a = .9 + P.x*.35 + .15*sin(T*.09);
  L = normalize(vec3(cos(a)*1.4, 1.6 + P.y*.25, sin(a)*.8 + .9));
  vec3 ro = vec3(P.x*.12, .28 - P.y*.06, 4.6);
  vec3 ta = vec3(0., -.18, 0.);
  vec3 f = normalize(ta - ro), r = normalize(cross(f, vec3(0,1,0))), u = cross(r, f);
  // 抗锯齿：旋转网格 4 次超采样（RGSS），球的轮廓与倒影边缘不再有锯齿
  vec3 c = vec3(0.);
  for (int i = 0; i < 4; i++){
    if (float(i) >= SS) break;
    vec2 o = SS > 1.5 ? (i == 0 ? vec2(.125,.375) : i == 1 ? vec2(-.375,.125) : i == 2 ? vec2(-.125,-.375) : vec2(.375,-.125)) : vec2(0.);
    vec2 q = (gl_FragCoord.xy + o - .5*R) / R.y;
    vec3 rd = normalize(q.x*r + q.y*u + 1.75*f);
    vec3 sc = trace(ro, rd);
    // 光球辉光：主光线离光球最近的距离决定光晕强度，被挡住时减弱
    vec3 oc = S4.xyz - ro;
    float along = max(0., dot(oc, rd));
    float dist = length(oc - rd*along);
    float th; vec3 hn;
    float blocker = hitScene(ro, rd, th, hn);
    float visible = (blocker < .5 || th > along - S4.w || blocker > 5.5) ? 1. : .25;
    sc += SKY * (exp(-dist*9.) * .55 + exp(-dist*2.6) * .12) * visible * mix(.8, 1.3, DARK);
    c += sc;
  }
  c /= SS;
  // 中间区域再向页面底色收一些，保证正文可读
  float calm = smoothstep(.8, .2, abs(uv.x) / (.5*aspect)) * .55;
  c = mix(c, BG, calm);
  // 暗角：深色主题四角压暗，浅色主题四角轻微偏蓝，画面更有景深
  float vig = smoothstep(.45, 1.25, length(uv / vec2(aspect*.5, .5)) * .75);
  c = mix(c, mix(c*.97 + SKY*.02, c*.7, DARK), vig);
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
