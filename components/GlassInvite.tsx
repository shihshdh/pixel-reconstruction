'use client';

// 首页结尾的“玻璃邀请”：标题画在一块底板上，前面盖着八块厚玻璃碎片。色调跟随明暗主题。
// 玻璃是真的折射：MeshPhysicalMaterial 的 transmission + thickness + ior + dispersion，
// 字跨过倒角边时会被错开、边缘带一点色散彩边。鼠标移动时玻璃朝鼠标倾斜（底板和按钮不动），
// 一盏跟随鼠标的点光让高光在倒角上游走，鼠标下的那块微微浮起。
// 只在进入视口、且有东西在动时渲染；低档画质、减少动态效果或触屏用静态版本。
import { useEffect, useRef, useState } from "react";
import { prefersReduced } from "@/lib/motion";
import { perfProfile } from "@/lib/perf";
import styles from "./GlassInvite.module.css";

const TITLE = ["现在，", "轮到你的照片。"];
const LEAD = "有 NVIDIA 显卡就在本机重建，没有就交给云端。无需任何配置。";

// 碎片顶点（u, v ∈ [-1, 1]），相邻碎片共用顶点，再各自向内收一圈留出缝
const P = {
  TL: [-1, 1], T1: [-.42, 1], T2: [.36, 1], TR: [1, 1], L1: [-1, -.1], R1: [1, .12],
  BL: [-1, -1], B1: [-.2, -1], B2: [.42, -1], BR: [1, -1],
  A: [-.5, .35], B: [.12, .08], C: [.58, .42], D: [-.12, -.45], E: [.66, -.3],
} as const;
type Key = keyof typeof P;
const SHARDS: Key[][] = [
  ["TL", "T1", "A", "L1"], ["T1", "T2", "C", "B", "A"], ["T2", "TR", "R1", "C"], ["L1", "A", "D", "B1", "BL"],
  ["A", "B", "D"], ["D", "B", "E", "B2", "B1"], ["B", "C", "R1", "E"], ["E", "R1", "BR", "B2"],
];
const BEVEL = .022, GAP = BEVEL + .007, DEPTH = .05;

/** 多边形向内平移 inset：每个顶点沿两条邻边内法线的角平分线移动 */
function insetPolygon(points: [number, number][], inset: number): [number, number][] {
  let area = 0;
  points.forEach(([x1, y1], i) => { const [x2, y2] = points[(i + 1) % points.length]; area += x1 * y2 - x2 * y1; });
  const pts = area < 0 ? [...points].reverse() : points; // 统一成逆时针，内法线在边的左侧
  return pts.map(([x, y], i) => {
    const [px, py] = pts[(i + pts.length - 1) % pts.length], [nx, ny] = pts[(i + 1) % pts.length];
    const e1 = [x - px, y - py], e2 = [nx - x, ny - y];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    const n1 = [-e1[1] / l1, e1[0] / l1], n2 = [-e2[1] / l2, e2[0] / l2];
    const k = inset / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [x + (n1[0] + n2[0]) * k, y + (n1[1] + n2[1]) * k];
  });
}

function canUseGlass() {
  if (prefersReduced() || matchMedia("(pointer: coarse)").matches) return false;
  if (perfProfile().tier === "low") return false;
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

export default function GlassInvite({ onStart, active = true }: { onStart: () => void; active?: boolean }) {
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const [mode, setMode] = useState<"pending" | "glass" | "static">("pending");
  useEffect(() => { setMode(canUseGlass() ? "glass" : "static"); }, []);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (mode !== "glass") return;
    const root = rootRef.current, canvas = canvasRef.current;
    if (!root || !canvas) return;
    let disposed = false, cleanup = () => {};
    (async () => {
      const THREE = await import("three");
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" }); }
      catch { setMode("static"); return; }
      const tier = perfProfile().tier, dpr = devicePixelRatio || 1;
      // 极致档超采样，与工作室一致；均衡档封顶 1.5
      renderer.setPixelRatio(tier === "ultra" ? Math.min(dpr * 1.25, 2.5) : tier === "high" ? Math.min(dpr, 2) : Math.min(dpr, 1.5));
      // Neutral 色调映射不会把浅色主题的白底压灰
      renderer.toneMapping = THREE.NeutralToneMapping;

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), .04).texture;
      scene.environment = env;
      const camera = new THREE.PerspectiveCamera(28, 1, .1, 20);
      const dist = .5 / Math.tan(THREE.MathUtils.degToRad(14)); // z=0 处视野高度正好为 1
      camera.position.set(0, 0, dist);

      // 底板：标题、说明和几团柔光画进 CanvasTexture。底板比视野大 30%，倾斜时不露边
      const PAD = 1.3, PLANE_Z = -.22;
      const paper = document.createElement("canvas");
      const texture = new THREE.CanvasTexture(paper);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
      plane.position.z = PLANE_Z;

      const glass = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, metalness: 0, roughness: .045, transmission: 1, thickness: .55, ior: 1.46,
        // 基础层很光滑，字透过玻璃仍清楚；高光交给粗糙一点的清漆层，才是 Prism 那种大片柔光而不是小光斑
        dispersion: 1.6, specularIntensity: .12, clearcoat: 1, clearcoatRoughness: .34, envMapIntensity: .38,
        attenuationColor: new THREE.Color("#a3a8b0"), attenuationDistance: 1.6,
      });
      // 底板不跟着倾斜：字和真按钮始终对齐、按钮不会从鼠标下滑走；只有玻璃倾斜，折射随之变化
      scene.add(plane);
      const group = new THREE.Group();
      scene.add(group);
      let shards: InstanceType<typeof THREE.Mesh>[] = [];
      const lift: number[] = [];

      // 跟随鼠标的光放得高、离得远：在清漆层上拉出一片柔光，而不是贴脸的点状反光
      const key = new THREE.PointLight(0xfff4e6, 2.4, 0, 2);
      scene.add(key);

      // 两套色调。深色：Prism 式近黑底 + 烟灰玻璃 + 主题金色柔光；
      // 浅色：比页面底色（#f7f9fc）略深一档的雾蓝灰底，玻璃几乎无色，靠更亮的环境反射勾出倒角，
      // 柔光取页面同系的灰蓝与暖米，字用页面墨色，和周围的浅色版块不打架
      const PALETTES = {
        dark: { paper: "#0b0b0d", ink: "#ececef", ink3: "#8b8d94", glows: [["#d4af6a26", .34], ["#4f6f9622", .32], ["#ffffff0a", .22]],
          glass: { attenuationColor: "#a3a8b0", attenuationDistance: 1.6, envMapIntensity: .38, specularIntensity: .12, dispersion: 1.6 }, key: 2.4, exposure: 1.05 },
        light: { paper: "#e9eef4", ink: "#202428", ink3: "#5d6570", glows: [["#8eaed266", .36], ["#d8c4a04d", .32], ["#ffffffb0", .24]],
          glass: { attenuationColor: "#ffffff", attenuationDistance: 8, envMapIntensity: .62, specularIntensity: .3, dispersion: 1.1 }, key: 1.2, exposure: 1.16 },
      } as const;
      const palette = () => PALETTES[document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"];
      const applyGlass = () => {
        const p = palette();
        glass.attenuationColor.set(p.glass.attenuationColor); glass.attenuationDistance = p.glass.attenuationDistance;
        glass.envMapIntensity = p.glass.envMapIntensity; glass.specularIntensity = p.glass.specularIntensity; glass.dispersion = p.glass.dispersion;
        key.intensity = p.key; renderer.toneMappingExposure = p.exposure;
      };

      let W = 1, H = 1;
          const paint = () => {
        const ratio = renderer.getPixelRatio();
        const cw = Math.round(W * PAD * ratio), ch = Math.round(H * PAD * ratio);
        paper.width = cw; paper.height = ch;
        const g = paper.getContext("2d")!;
        const { paper: base, ink, ink3, glows } = palette();
        g.fillStyle = base; g.fillRect(0, 0, cw, ch);
        // 柔光：让玻璃有东西可折射，倒角处才看得出偏折
        const glow = (x: number, y: number, r: number, color: string) => {
          const grd = g.createRadialGradient(x * cw, y * ch, 0, x * cw, y * ch, r * cw);
          grd.addColorStop(0, color); grd.addColorStop(1, "transparent");
          g.fillStyle = grd; g.fillRect(0, 0, cw, ch);
        };
        glow(.8, .28, glows[0][1], glows[0][0]);
        glow(.18, .9, glows[1][1], glows[1][0]);
        glow(.56, .5, glows[2][1], glows[2][0]);
        // 文字的位置按 CSS 像素算，再加上 PAD 留出的边，和按钮对齐
        const s = ratio, ox = (PAD - 1) / 2 * W * s, oy = (PAD - 1) / 2 * H * s;
        const family = getComputedStyle(document.body).fontFamily;
        const size = Math.min(64, Math.max(34, W * .058));
        root.style.setProperty("--title-size", size + "px");
        const left = ox + W * .085 * s;
        g.fillStyle = ink; g.textBaseline = "alphabetic";
        g.font = `600 ${size * s}px ${family}`;
        if ("letterSpacing" in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${-size * .02 * s}px`;
        const top = oy + H * .3 * s;
        TITLE.forEach((line, i) => g.fillText(line, left, top + size * s * (1 + i * 1.12)));
        g.fillStyle = ink3; g.font = `400 ${13.5 * s}px ${family}`;
        if ("letterSpacing" in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
        g.fillText(LEAD, left, top + size * s * 2.12 + 30 * s);
        // 右下角的小字，像 Prism 角落里的材质名
        g.font = `400 ${9.5 * s}px SFMono-Regular,Consolas,monospace`; g.fillStyle = ink3; g.globalAlpha = .7;
        g.fillText("TRANSMISSION · IOR 1.46 · DISPERSION", ox + W * .7 * s, oy + H * .93 * s); g.globalAlpha = 1;
        texture.needsUpdate = true;
      };

      const build = () => {
        shards.forEach(m => { group.remove(m); m.geometry.dispose(); });
        shards = [];
        const aspect = W / H, sx = aspect / 2 * .955, sy = .5 * .9;
        SHARDS.forEach((keys, i) => {
          const pts = insetPolygon(keys.map(k => [P[k][0] * sx, P[k][1] * sy] as [number, number]), GAP);
          const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: true, bevelThickness: .026, bevelSize: BEVEL, bevelSegments: 5, curveSegments: 1 });
          geo.translate(0, 0, -DEPTH / 2);
          const mesh = new THREE.Mesh(geo, glass);
          group.add(mesh); shards.push(mesh); lift[i] = lift[i] || 0;
        });
        plane.scale.set(aspect * PAD * (dist - PLANE_Z) / dist, PAD * (dist - PLANE_Z) / dist, 1);
      };

      // 鼠标状态：target 是鼠标给的目标，cur 是缓动后的当前值
      const state = { tx: 0, ty: 0, x: 0, y: 0, rx: .1, ry: -.06, inside: false, hover: -1, visible: false };
      const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
      let raf = 0, last = 0;
      const loop = (now: number) => {
        raf = 0;
        const dt = Math.min(.05, last ? (now - last) / 1000 : .016); last = now;
        const ease = 1 - Math.exp(-dt * 7);
        state.x += (state.tx - state.x) * ease; state.y += (state.ty - state.y) * ease;
        const goalX = state.inside ? -state.y * .13 : 0, goalY = state.inside ? state.x * .19 : 0;
        state.rx += (goalX - state.rx) * ease; state.ry += (goalY - state.ry) * ease;
        group.rotation.set(state.rx, state.ry, 0);
        key.position.set(state.x * W / H * .5, state.y * .45, 1.25);
        let moving = Math.abs(goalX - state.rx) + Math.abs(goalY - state.ry) + Math.abs(state.tx - state.x) + Math.abs(state.ty - state.y) > .0006;
        if (state.inside) {
          ndc.set(state.tx, state.ty); ray.setFromCamera(ndc, camera);
          const hit = ray.intersectObjects(shards, false)[0];
          state.hover = hit ? shards.indexOf(hit.object as InstanceType<typeof THREE.Mesh>) : -1;
        } else state.hover = -1;
        shards.forEach((mesh, i) => {
          const goal = i === state.hover ? .045 : 0;
          lift[i] += (goal - lift[i]) * ease; mesh.position.z = lift[i];
          if (Math.abs(goal - lift[i]) > .0004) moving = true;
        });
        renderer.render(scene, camera);
        if (moving && state.visible && activeRef.current) raf = requestAnimationFrame(loop);
        else last = 0;
      };
      const kick = () => { if (!raf && state.visible && activeRef.current) raf = requestAnimationFrame(loop); };

      const resize = () => {
        W = Math.max(1, root.clientWidth); H = Math.max(1, root.clientHeight);
        renderer.setSize(W, H, false);
        camera.aspect = W / H; camera.updateProjectionMatrix();
        build(); paint(); kick();
      };
      const move = (event: PointerEvent) => {
        const r = root.getBoundingClientRect();
        state.tx = (event.clientX - r.left) / r.width * 2 - 1; state.ty = -((event.clientY - r.top) / r.height * 2 - 1);
        state.inside = true; kick();
      };
      const leave = () => { state.inside = false; kick(); };
      const ro = new ResizeObserver(resize); ro.observe(root);
      const io = new IntersectionObserver(([entry]) => { state.visible = entry.isIntersecting; kick(); }, { rootMargin: "120px" });
      io.observe(root);
      const themeWatch = new MutationObserver(() => { applyGlass(); paint(); kick(); });
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      root.addEventListener("pointermove", move); root.addEventListener("pointerleave", leave);
      // 字体加载完再画一遍，避免第一次落在后备字体上
      void document.fonts?.ready.then(() => { if (!disposed) { paint(); kick(); } });
      applyGlass();
      resize();
      setTimeout(() => root.setAttribute("data-ready", ""), 60);

      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); themeWatch.disconnect();
        root.removeEventListener("pointermove", move); root.removeEventListener("pointerleave", leave);
        shards.forEach(m => m.geometry.dispose()); glass.dispose();
        plane.geometry.dispose(); (plane.material as InstanceType<typeof THREE.MeshBasicMaterial>).dispose(); texture.dispose();
        env.dispose(); pmrem.dispose(); renderer.dispose();
      };
    })();
    return () => { disposed = true; cleanup(); };
  }, [mode]);

  // 回到首页时补一帧（离开期间暂停了渲染）
  useEffect(() => { if (active) rootRef.current?.dispatchEvent(new PointerEvent("pointerleave")); }, [active]);

  if (mode !== "glass") return <section className="overview-start"><div><h2 data-parallax=".06">{TITLE.join("")}</h2><p>{LEAD}</p></div><button className="editorial-primary" onClick={onStart}>上传照片 <span aria-hidden="true">↗</span></button></section>;
  return <section ref={rootRef} className={styles.invite}>
    <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    <div className={styles.copy}><h2>{TITLE.join("")}</h2><p>{LEAD}</p></div>
    <button className={`editorial-primary ${styles.cta}`} onClick={onStart}>上传照片 <span aria-hidden="true">↗</span></button>
  </section>;
}
