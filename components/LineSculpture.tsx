'use client';

// 首页「线的雕塑」：一团看似杂乱的彩色短线，转到三个特定角度，各自拼回同一张照片在那个视角下的样子。
// 数据由 Desktop\line-sculpture 的流程离线生成（渲染三视角 → 顺着纹理铺笔触 → 给每一笔挑一个
// 在其他视角里几乎看不见的深度），放在 public/sculpture/<scene>.{json,bin}。
// 二进制布局：uint32 offsets[S+1] | uint8 view[S]（补齐到 4 字节）| int16 xyz[3P]（乘 posScale）| uint8 rgb[3P]（sRGB）。
// 只在进入视口附近才加载；只在看得见且画面在变时渲染；流畅档、减少动态效果或没有 WebGL2 时显示对齐后的静态图。
import { useEffect, useRef, useState } from "react";
import LiquidSegmented from "@/components/LiquidSegmented";
import { prefersReduced } from "@/lib/motion";
import { perfProfile } from "@/lib/perf";
import styles from "./LineSculpture.module.css";

const SCENES = [{ value: "louvre", label: "卢浮宫" }, { value: "yozakura", label: "夜樱" }] as const;
type SceneId = typeof SCENES[number]["value"];
type ViewChoice = "0" | "1" | "2" | "free";

export type Meta = { lineWidth: number; width: number; height: number; strokes: number; points: number; posScale: number; bin: string;
  views: { position: [number, number, number]; fov: number }[] };

type Api = { fly: (i: number, ms?: number) => void; scatter: () => void; load: (scene: SceneId) => Promise<void> };

function canAnimate() {
  if (prefersReduced() || perfProfile().tier === "low") return false;
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

/** custom：工作室里用户自己的作品现场生成的数据（不读 public/sculpture），配合 variant="overlay" 全屏显示 */
export default function LineSculpture({ active = true, custom, variant = "home", title }: { active?: boolean; custom?: { meta: Meta; bin: ArrayBuffer }; variant?: "home" | "overlay"; title?: string }) {
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const activeRef = useRef(active);
  const [mode, setMode] = useState<"pending" | "live" | "static">("pending");
  const [scene, setScene] = useState<SceneId>("louvre");
  const [view, setView] = useState<ViewChoice>("free");
  const [loading, setLoading] = useState(true);
  // 用户自己生成的线雕没有预先渲染的静态图：只要有 WebGL2 就实时显示
  useEffect(() => {
    let gl2 = false; try { gl2 = !!document.createElement("canvas").getContext("webgl2"); } catch {}
    setMode(custom ? (gl2 ? "live" : "static") : canAnimate() ? "live" : "static");
  }, [custom]);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (mode !== "live") return;
    const root = rootRef.current, stage = stageRef.current;
    if (!root || !stage) return;
    let disposed = false, cleanup = () => {};
    // 离视口还有一屏时才开始加载 three 和数据
    const near = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { near.disconnect(); void start(); } }, { rootMargin: custom ? "0px" : "600px 0px" });
    near.observe(root);

    async function start() {
      const THREE = await import("three");
      const [{ OrbitControls }, { LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }] = await Promise.all([
        import("three/examples/jsm/controls/OrbitControls.js"), import("three/examples/jsm/lines/LineSegments2.js"),
        import("three/examples/jsm/lines/LineSegmentsGeometry.js"), import("three/examples/jsm/lines/LineMaterial.js"),
      ]);
      if (disposed || !stage) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" }); }
      catch { setMode("static"); return; }
      const tier = perfProfile().tier, dpr = devicePixelRatio || 1;
      renderer.setPixelRatio(tier === "ultra" ? Math.min(dpr * 1.25, 2.5) : tier === "high" ? Math.min(dpr, 2) : Math.min(dpr, 1.25));
      renderer.setClearColor(0x000000, 0);   // 底色交给 CSS，跟随明暗主题
      renderer.domElement.className = styles.canvas;
      stage.appendChild(renderer.domElement);
      const world = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, .05, 100);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true; controls.dampingFactor = .07; controls.rotateSpeed = .5;
      controls.enablePan = false; controls.enableZoom = false;   // 滚轮留给页面滚动
      const mat = new LineMaterial({ vertexColors: true, linewidth: 2, worldUnits: false });
      let lines: InstanceType<typeof LineSegments2> | null = null;
      let meta: Meta | null = null, views: InstanceType<typeof THREE.Vector3>[] = [], dist = 5.2;
      const LUT = Float32Array.from({ length: 256 }, (_, i) => new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r);

      let visible = false, dirty = true, raf = 0;
      type Flight = { t0: number; ms: number; qa: InstanceType<typeof THREE.Quaternion>; qb: InstanceType<typeof THREE.Quaternion>; r0: number; r1: number };
      let flight: Flight | null = null;
      const Z = new THREE.Vector3(0, 0, 1);
      const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const kick = () => { dirty = true; if (!raf && visible && activeRef.current) raf = requestAnimationFrame(tick); };

      const fit = () => {
        const w = stage.clientWidth, h = stage.clientHeight;
        if (!w || !h || !meta) return;
        renderer.setSize(w, h, false);
        const a = w / h, va = meta.width / meta.height, t = Math.tan(THREE.MathUtils.degToRad(meta.views[0].fov / 2));
        camera.aspect = a;
        // 舞台比原画更“竖”时放宽竖直视角，整幅画始终完整
        camera.fov = a >= va ? meta.views[0].fov : THREE.MathUtils.radToDeg(2 * Math.atan(t * va / a));
        camera.updateProjectionMatrix();
        const pr = renderer.getPixelRatio();
        mat.resolution.set(w * pr, h * pr);
        // 原型按 900px 高的整屏调的线宽，按画面实际高度等比缩放
        const frameH = h * t / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        mat.linewidth = meta.lineWidth * pr * Math.max(.55, frameH / 900);
        kick();
      };

      // 散开时退远一些：整团线浮在画框中间，四周留白
      const scatterPos = () => new THREE.Vector3().setFromSphericalCoords(dist * 1.55, THREE.MathUtils.degToRad(50 + Math.random() * 70), Math.PI * (.65 + Math.random() * .7));
      const fly = (i: number, ms = 2400) => {
        const to = views[i];
        if (!to) return;
        const from = camera.position.clone();
        flight = { t0: performance.now(), ms, qa: new THREE.Quaternion().setFromUnitVectors(Z, from.clone().normalize()), qb: new THREE.Quaternion().setFromUnitVectors(Z, to.clone().normalize()), r0: from.length(), r1: to.length() };
        controls.enabled = false; kick();
      };
      const scatter = () => {
        const to = scatterPos();
        const from = camera.position.clone();
        flight = { t0: performance.now(), ms: 2000, qa: new THREE.Quaternion().setFromUnitVectors(Z, from.clone().normalize()), qb: new THREE.Quaternion().setFromUnitVectors(Z, to.clone().normalize()), r0: from.length(), r1: to.length() };
        controls.enabled = false; kick();
      };
      const nearest = () => {
        const d = camera.position.clone().normalize();
        let best = { i: 0, deg: 180 };
        views.forEach((v, i) => { const deg = THREE.MathUtils.radToDeg(d.angleTo(v.clone().normalize())); if (deg < best.deg) best = { i, deg }; });
        return best;
      };
      // 松手时离某个视角不到 16°，就缓缓转过去对齐
      controls.addEventListener("end", () => { const { i, deg } = nearest(); if (deg < 16) fly(i, 700 + deg * 90); });
      controls.addEventListener("change", kick);

      let lastView: ViewChoice = "free";
      function tick(now: number) {
        raf = 0;
        let moving = false;
        if (flight) {
          const t = Math.min(1, (now - flight.t0) / flight.ms), k = ease(t);
          camera.position.copy(Z).applyQuaternion(flight.qa.clone().slerp(flight.qb, k)).multiplyScalar(flight.r0 + (flight.r1 - flight.r0) * k);
          camera.lookAt(0, 0, 0);
          moving = true;
          if (t >= 1) { flight = null; controls.enabled = true; controls.update(); }
        } else if (controls.update()) moving = true;
        if (dirty || moving) { renderer.render(world, camera); dirty = false; }
        const { i, deg } = nearest();
        const now_: ViewChoice = deg < .8 && !flight ? (String(i) as ViewChoice) : "free";
        if (now_ !== lastView) { lastView = now_; setView(now_); }
        if ((moving || flight) && visible && activeRef.current) raf = requestAnimationFrame(tick);
      }

      let firstShow = true, seenRatio = 0;
      // 第一次看到（且数据已就绪）时，停顿一下再慢慢拼出照片
      const maybeIntro = () => { if (firstShow && meta && visible && seenRatio > .45) { firstShow = false; setTimeout(() => fly(0), 900); } };
      const load = async (id: SceneId) => {
        setLoading(true);
        const m: Meta = custom ? custom.meta : await (await fetch(`/sculpture/${id}.json`)).json();
        const buf = custom ? custom.bin : await (await fetch(`/sculpture/${m.bin}`)).arrayBuffer();
        if (disposed) return;
        const S = m.strokes, P = m.points;
        const offsets = new Uint32Array(buf, 0, S + 1);
        const xyzAt = (S + 1) * 4 + S + ((4 - S % 4) % 4);
        const xyz = new Int16Array(buf, xyzAt, P * 3), rgb = new Uint8Array(buf, xyzAt + P * 6, P * 3);
        const segs = P - S, pos = new Float32Array(segs * 6), col = new Float32Array(segs * 6);
        let o = 0;
        for (let s = 0; s < S; s++) for (let j = offsets[s]; j + 1 < offsets[s + 1]; j++, o += 6) {
          for (let c = 0; c < 6; c++) { pos[o + c] = xyz[j * 3 + c] * m.posScale; col[o + c] = LUT[rgb[j * 3 + c]]; }
        }
        const geo = new LineSegmentsGeometry().setPositions(pos.subarray(0, o)).setColors(col.subarray(0, o));
        if (lines) { world.remove(lines); lines.geometry.dispose(); }
        lines = new LineSegments2(geo, mat); world.add(lines);
        meta = m; views = m.views.map(v => new THREE.Vector3(...v.position)); dist = views[0].length();
        // 换场景：先停在散乱的角度，进入视口后再慢慢转到视角 1
        flight = null; controls.enabled = true;
        camera.position.copy(scatterPos()); camera.lookAt(0, 0, 0); controls.update();
        fit(); setLoading(false); maybeIntro();
        if (!firstShow && visible) setTimeout(() => fly(0), 500);
      };

      const io = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting; seenRatio = entry.intersectionRatio;
        if (visible) kick();
        maybeIntro();
      }, { threshold: [0, .45] });
      io.observe(stage);
      const ro = new ResizeObserver(fit); ro.observe(stage);
      apiRef.current = { fly, scatter, load };
      await load("louvre");

      cleanup = () => {
        cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); controls.dispose();
        if (lines) lines.geometry.dispose(); mat.dispose(); renderer.dispose(); renderer.domElement.remove();
        apiRef.current = null;
      };
    }
    return () => { disposed = true; near.disconnect(); cleanup(); };
  }, [mode, custom]);

  // 回到首页时补画一帧（离开期间暂停了渲染）
  useEffect(() => { if (active) stageRef.current?.dispatchEvent(new Event("pointerup")); }, [active]);

  const chooseScene = (id: SceneId) => { setScene(id); setView("free"); void apiRef.current?.load(id); };
  const chooseView = (v: ViewChoice) => { if (v === "free") apiRef.current?.scatter(); else apiRef.current?.fly(+v, 1600); };

  const overlay = variant === "overlay";
  return <section ref={rootRef} className={overlay ? styles.overlaySection : styles.section} aria-labelledby="line-sculpture-title">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>线的雕塑 · 3 个视角</p>
        <h2 id="line-sculpture-title" lang="en">{overlay ? title || "Your scene, in lines." : "Every line remembers where it came from."}</h2>
        {!overlay && <p className={styles.lead}>十几万根线，只在三个角度拼回照片。拖动旋转，转到对的位置，它会自己对齐。</p>}
      </div>
      <div className={styles.controls}>
        {!overlay && <LiquidSegmented<SceneId> ariaLabel="场景" value={scene} onChange={chooseScene} options={SCENES.map(s => ({ value: s.value, label: s.label }))} />}
        {mode === "live" && <LiquidSegmented<ViewChoice> ariaLabel="视角" value={view} onChange={chooseView} disabled={loading}
          options={[{ value: "0", label: "视角 1" }, { value: "1", label: "视角 2" }, { value: "2", label: "视角 3" }, { value: "free", label: "散开" }]} />}
      </div>
    </header>
    <div ref={stageRef} className={styles.stage} data-loading={mode === "live" && loading ? "" : undefined}>
      {mode === "static" && <img className={styles.still} src={`/sculpture/${scene}-still.webp`} alt={scene === "louvre" ? "由彩色短线拼成的卢浮宫金字塔夜景" : "由彩色短线拼成的寺前夜樱"} />}
      {mode === "live" && loading && <span className={styles.status} role="status">正在铺线…</span>}
    </div>
  </section>;
}
