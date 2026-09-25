// Liquid-glass logo pixels for the opening title (BrandIntro).
//
// The four pixels of the mark are drawn in WebGL as small slabs of tinted glass, following the
// optics used by open-source Liquid Glass reproductions (kube.io "Liquid Glass in the Browser",
// liquid-glass-studio): a convex-squircle bezel y = ⁴√(1-(1-x)⁴), light refracted through it by
// Snell's law at n ≈ 1.5 with a slightly different index per colour channel (dispersion), a Fresnel
// reflection toward the rim, and a rim light whose strength follows the angle between the edge
// normal and the light. The tint obeys Beer–Lambert: thicker glass is deeper blue, the thin bezel is
// lighter, which is what makes a tinted slab read as glass on a white page.
//
// The canvas lies over the lockup and only draws the pixels and their soft shadows. The pixels'
// motion (fly-in, zoom, slide aside) follows the same timeline as the CSS keyframes, computed from
// the shared clock. It renders in a worker via OffscreenCanvas where available, so the scene
// loading on the main thread cannot stall it. Optional throughout: without WebGL the flat HTML
// pixels simply stay.

const VERTEX = `
attribute vec2 a;
void main(){gl_Position=vec4(a,0.,1.);}
`;

const FRAGMENT = `
precision highp float;
uniform vec2 R;          // canvas size, device px
uniform float D;         // device px per CSS px
uniform vec4 B[4];       // per pixel: centre x, y (CSS px, y down), half size (CSS px), rotation (rad)
uniform float O[4];      // per pixel: tint strength x visibility
uniform float T;         // seconds since the title started
uniform vec2 P;          // pointer, -1..1

const vec3 BLUE=vec3(.031,.482,.941);   // #087bf0, the brand blue

// Rounded box: signed distance and outward normal direction.
vec3 rbox(vec2 x,float b,float r){
  vec2 q=abs(x)-vec2(b-r);
  vec2 m=max(q,0.);
  float o=length(m);
  float d=o+min(max(q.x,q.y),0.)-r;
  vec2 g=o>0.?m/o:(q.x>q.y?vec2(1,0):vec2(0,1));
  return vec3(d,g*sign(x+1e-6));
}
// Convex squircle profile over the bezel (0 at the rim, 1 where the flat top begins).
float profile(float x){x=clamp(x,0.,1.);return pow(1.-pow(1.-x,4.),.25);}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}

// Glass thickness at a local point (in half-size units): the squircle bezel onto a flat top.
float thick(vec2 q,float r){
  float s=-rbox(q,1.,r).x;
  return s<=0.?0.:profile(s/.55);
}

vec4 shadow(vec2 q,float o){
  // Soft contact shadow below the slab, with light focused through the glass at its heart.
  float d=rbox(q-vec2(0.,.34),1.,.4).x;
  float a=(1.-smoothstep(-.35,.95,d))*.2*o;
  float caustic=(1.-smoothstep(0.,.7,length((q-vec2(.05,.62))*vec2(1.,1.6))))*.16*o;
  vec3 c=vec3(.05,.2,.42);
  return vec4(c*a,a)+vec4(mix(BLUE,vec3(1),.55)*caustic,0.)*step(0.,rbox(q,1.,.33).x);
}

vec4 glass(vec2 q,float h,float o,float ang){
  float r=.3333;
  vec3 bx=rbox(q,1.,r);
  float aa=1.2/(D*h);
  float cover=smoothstep(aa,-aa,bx.x);
  if(cover<=0.)return vec4(0);
  float s=max(-bx.x,0.), bw=.55;
  float x=s/bw;
  // Surface normal from the profile's slope along the outward edge direction.
  float e=.02;
  float dh=(profile(x+e)-profile(x-e))/(2.*e)*(.9/bw)*.5;
  vec2 g=bx.yz;
  vec3 n=normalize(vec3(g*dh,1.));
  // Snell refraction of a ray looking straight down, per channel: the displacement lands on a
  // different thickness for each colour at the bezel, which gives the faint spectral edge.
  vec3 I=vec3(0,0,-1);
  float t0=thick(q,r);
  vec2 dr=refract(I,n,1./1.49).xy, dg=refract(I,n,1./1.51).xy, db=refract(I,n,1./1.54).xy;
  float k=.55;
  vec3 path=vec3(thick(q+dr*k,r),thick(q+dg*k,r),thick(q+db*k,r));
  path=mix(vec3(t0),path,.85)+.08;
  // Beer–Lambert tint through the slab over a white page.
  vec3 absorb=-log(BLUE+.004)*(.22+.8*o);
  vec3 col=exp(-absorb*path*.9);
  // Light: key from the upper left, drifting with time and the pointer.
  float la=2.35+.35*sin(T*.5)+P.x*.4;
  vec2 L=vec2(cos(la),-sin(la));            // y down: upper-left
  vec3 L3=normalize(vec3(L,.9-P.y*.2));
  // Rim light: strongest where the edge faces the light, a weaker counter-rim opposite.
  // A hairline of light right on the edge, then a softer band inside it.
  float line=1.-smoothstep(.015,.06,s), band=1.-smoothstep(0.,.18,s);
  float facing=max(dot(g,L),0.), counter=max(dot(g,-L),0.);
  float rim=line*(.35+pow(facing,1.2)*.65+pow(counter,2.)*.45)+band*(pow(facing,1.5)*.5+pow(counter,2.)*.22);
  // Fresnel: the steeper bezel mirrors the bright surroundings.
  float fres=pow(1.-n.z,2.5)*.9;
  // Specular hot spot from the key light, and a soft glint travelling over the top.
  float spec=pow(max(dot(reflect(-L3,n),vec3(0,0,1)),0.),60.)*.9;
  vec2 qr=rot(-ang)*q;
  float sweep=exp(-pow((qr.x+qr.y)*.9-(fract(T*.16)*6.-3.),2.)*5.)*.22*smoothstep(.3,.6,x);
  // Light gathered inside the far edge, as a lens would focus it.
  float inner=(1.-smoothstep(0.,.5,s))*pow(counter,1.5)*.35;
  col=mix(col,vec3(1),clamp(fres+rim+spec+sweep,0.,1.));
  col+=mix(BLUE,vec3(1),.7)*inner;
  float alpha=cover*mix(.72,.94,o);
  return vec4(min(col,1.)*alpha,alpha);
}

void main(){
  vec2 f=vec2(gl_FragCoord.x,R.y-gl_FragCoord.y)/D;
  vec4 acc=vec4(0);
  // Shadows first, then the glass on top.
  for(int i=0;i<4;i++){
    vec4 b=B[i];
    if(O[i]<=0.||b.z<=0.)continue;
    vec2 q=rot(-b.w)*(f-b.xy)/b.z;
    if(abs(q.x)>2.2||abs(q.y)>2.6)continue;
    vec4 s=shadow(q,O[i]);
    acc=s+acc*(1.-s.a);
  }
  for(int i=0;i<4;i++){
    vec4 b=B[i];
    if(O[i]<=0.||b.z<=0.)continue;
    vec2 q=rot(-b.w)*(f-b.xy)/b.z;
    if(abs(q.x)>1.1||abs(q.y)>1.1)continue;
    vec4 g=glass(q,b.z,clamp(O[i],0.,1.),b.w);
    acc=g+acc*(1.-g.a);
  }
  gl_FragColor=acc;
}
`;

export type GlassPixel = {
  /** Top-left in mark units (64 per mark), tint 0..1, delay/duration (ms) of the fly-in and fade. */
  x: number; y: number; o: number; delay: number; duration: number; fade: number;
  /** Fly-in start transform, in mark-box CSS px / degrees / scale. */
  tx: number; ty: number; rot: number; scale: number;
};
export type GlassTimeline = {
  pixels: GlassPixel[];
  /** Stage zoom-in, and the mark sliding aside (ms). */
  zoom: { duration: number; from: number };
  slide: { delay: number; duration: number };
};
/** Where the mark sits, measured on the page (BrandIntro). */
export type GlassGeometry = {
  cx: number; cy: number;      // stage origin (screen centre), CSS px
  scale: number;               // stage scale for this breakpoint
  lx: number; ly: number;      // mark box top-left relative to the slide origin, stage px
  box: number;                 // mark box size, stage px
  slideX: number;              // slide-aside distance, stage px
};

type Message = Record<string, any>;
/**
 * The renderer. Self-contained on purpose: the worker is built from this function's source, so it
 * must not reference anything outside itself. On the main thread it is called directly.
 */
function renderer(post: (message: Message) => void) {
  let gl: WebGLRenderingContext | null = null, canvas: HTMLCanvasElement | OffscreenCanvas;
  const loc: Record<string, WebGLUniformLocation | null> = {};
  let raf = 0, start = 0, leaveAt = -1, px = 0, py = 0, cssW = 1, cssH = 1, dpr = 1, sent = false;
  let timeline: any = null, geo: any = null;
  const g = globalThis as any;
  const tick: (f: () => void) => number = typeof g.requestAnimationFrame === "function" ? f => g.requestAnimationFrame(f) : f => g.setTimeout(f, 16);
  const untick = (id: number) => { if (typeof g.cancelAnimationFrame === "function") g.cancelAnimationFrame(id); else g.clearTimeout(id); };
  const now = () => performance.timeOrigin + performance.now();
  // CSS cubic-bezier timing, solved by bisection.
  const bezier = (x1: number, y1: number, x2: number, y2: number) => {
    const at = (a: number, b: number, u: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
    return (t: number) => {
      if (t <= 0) return 0; if (t >= 1) return 1;
      let lo = 0, hi = 1, u = t;
      for (let i = 0; i < 22; i++) { u = (lo + hi) / 2; if (at(x1, x2, u) < t) lo = u; else hi = u; }
      return at(y1, y2, u);
    };
  };
  const easeFly = bezier(.22, 1, .36, 1), easeZoom = bezier(.16, 1, .3, 1), easeSlide = bezier(.5, 0, .15, 1);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const size = () => {
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    gl?.viewport(0, 0, canvas.width, canvas.height);
  };
  const compile = (type: number, source: string) => {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, source); gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(String(gl!.getShaderInfoLog(shader)));
    return shader;
  };
  const boxes = new Float32Array(16), tints = new Float32Array(4);
  const place = (t: number) => {
    tints.fill(0);
    if (!timeline || !geo) return;
    const z = timeline.zoom.from + (1 - timeline.zoom.from) * easeZoom(t / timeline.zoom.duration);
    const slide = geo.slideX * easeSlide((t - timeline.slide.delay) / timeline.slide.duration);
    const k = geo.scale * z, unit = geo.box / 64;
    const leave = leaveAt < 0 ? 1 : 1 - clamp01((now() - leaveAt) / 260);
    timeline.pixels.forEach((p: any, i: number) => {
      const rest = 1 - easeFly((t - p.delay) / p.duration);
      const fade = clamp01((t - p.delay) / p.fade);
      const scale = 1 + (p.scale - 1) * rest;
      const cx = geo.cx + k * (slide + geo.lx + (p.x + 4.5) * unit + p.tx * rest);
      const cy = geo.cy + k * (geo.ly + (p.y + 4.5) * unit + p.ty * rest);
      boxes.set([cx, cy, k * 4.5 * unit * scale, p.rot * rest * Math.PI / 180], i * 4);
      tints[i] = p.o * fade * leave;
    });
  };
  const frame = () => {
    if (!gl) return;
    raf = tick(frame);
    const t = now();
    place(t - start);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(loc.R, canvas.width, canvas.height);
    gl.uniform1f(loc.D, dpr);
    gl.uniform4fv(loc.B, boxes);
    gl.uniform1fv(loc.O, tints);
    gl.uniform1f(loc.T, (t - start) / 1000);
    gl.uniform2f(loc.P, px, py);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!sent) { sent = true; post({ ready: true }); }
    if (leaveAt >= 0 && t - leaveAt > 400) untick(raf);
  };
  const init = (m: Message) => {
    canvas = m.canvas; start = m.start; cssW = m.w; cssH = m.h; dpr = m.dpr; timeline = m.timeline; geo = m.geo;
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" }) as WebGLRenderingContext | null;
    if (!gl) throw new Error("no webgl");
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, m.vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, m.fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(program)));
    gl.useProgram(program);
    gl.clearColor(0, 0, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const k of ["R", "D", "B", "O", "T", "P"]) loc[k] = gl.getUniformLocation(program, k);
    size(); raf = tick(frame);
  };
  return (m: Message) => {
    try {
      if (m.init) init(m);
      else if (m.resize) { cssW = m.w; cssH = m.h; dpr = m.dpr; if (m.geo) geo = m.geo; size(); }
      else if (m.pointer) { px = m.x; py = m.y; }
      else if (m.leave) { if (leaveAt < 0) leaveAt = now(); }
      else if (m.stop) { untick(raf); gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
    } catch (error) { untick(raf); gl = null; post({ failed: String((error as Error)?.message || error) }); }
  };
}

export type GlassHandle = { leave(): void; pointer(x: number, y: number): void; stop(): void };

/**
 * Starts the glass pixels on `canvas`. `startedAt` is the title's start on this page's performance
 * clock; `measure` returns the mark's current geometry (called again on resize). `onReady` fires
 * after the first frame, `onFail` if WebGL is unavailable or breaks (show the flat pixels then).
 */
export function startGlass(canvas: HTMLCanvasElement, startedAt: number, timeline: GlassTimeline, measure: () => GlassGeometry | null, onReady: () => void, onFail: () => void): GlassHandle | null {
  const geo = measure();
  if (!geo) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const init = { init: true, vs: VERTEX, fs: FRAGMENT, start: performance.timeOrigin + startedAt, w: window.innerWidth, h: window.innerHeight, dpr, timeline, geo };
  let send: (message: object, transfer?: Transferable[]) => void;
  let dispose: () => void;
  let done = false;
  const fail = () => { if (done) return; done = true; dispose(); onFail(); };
  const receive = (data: Message) => {
    if (done) return;
    if (data.ready) onReady();
    if (data.failed) fail();
  };
  try {
    if (typeof Worker === "function" && typeof canvas.transferControlToOffscreen === "function" && typeof OffscreenCanvas === "function") {
      const source = `var handle=(${renderer.toString()})(function(m){postMessage(m)});onmessage=function(e){handle(e.data)};`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = event => receive(event.data);
      worker.onerror = () => fail();
      const offscreen = canvas.transferControlToOffscreen();
      send = (message, transfer) => worker.postMessage(message, transfer || []);
      dispose = () => { try { worker.postMessage({ stop: true }); } catch {} setTimeout(() => worker.terminate(), 50); };
      send({ ...init, canvas: offscreen }, [offscreen]);
    } else {
      // Main-thread fallback: the same renderer, fed messages directly.
      const handle = renderer(message => receive(message));
      send = message => handle(message);
      dispose = () => handle({ stop: true });
      send({ ...init, canvas });
    }
  } catch { onFail(); return null; }

  let resizeFrame = 0;
  const resize = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (!done) send({ resize: true, w: window.innerWidth, h: window.innerHeight, dpr, geo: measure() }); });
  };
  window.addEventListener("resize", resize);
  return {
    leave: () => { if (!done) send({ leave: true }); },
    pointer: (x, y) => { if (!done) send({ pointer: true, x, y }); },
    stop: () => {
      window.removeEventListener("resize", resize);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (!done) { done = true; dispose(); }
    },
  };
}
