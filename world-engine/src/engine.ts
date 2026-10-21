// 「走进世界」漫游引擎。单独打包成 public/world/engine.js（见 ../build.mjs），自带 three 0.180 + Spark 2.4，
// 和站点里的 three 0.168 互不影响。接口约定在 lib/world-engine-types.ts；界面（摇杆、按钮、提示）都由页面画。
//
// 坐标：World Labs 的高斯点是 OpenCV 约定（+y 下、+z 前，见其文档 FAQ）。按官方说明先换算到米、
// 把地面移到 y=0，再绕 X 轴转 180°：world = R·(s·p − (0,g,0)) = R·s·p + (0,g,0)。所以模型上直接设 scale = s、
// 绕 X 转 180°、position = (0,g,0)。碰撞网格按数据对齐：在几种轴向约定里挑高斯点最贴合其表面的那一种（见 loadCollider）。
//
// 移动：眼睛位置 + 一根浮起的胶囊（底端离脚 stepHeight，这样 35cm 以内的台阶不会挡住水平移动），
// 脚下用射线找地面：行走模式有重力、贴地、上台阶；飞行模式没有重力但同样不穿墙。速度与转头都用指数平滑，
// 起步约 0.25 秒、停下约 0.3 秒，不做匀速硬启停。没有碰撞网格时（演示模式）在出生点周围的圆里活动，边缘柔性回弹。
import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshBVH } from "three-mesh-bvh";
import type { WalkMode, WorldAssets, WorldEngine, WorldEngineOptions, WorldQuality } from "../../lib/world-engine-types";

export const version = "1.0.0";

const ORDER: WorldQuality[] = ["100k", "500k", "full_res"];
const RADIUS = .38, STEP = .35, GRAVITY = 9.8;
// 能走上去的最陡坡面：法线与竖直方向夹角 53° 以内（cos ≈ .6）。Marble 的碰撞网格很粗，柜台边缘常被简化成斜面，
// 不加这个限制就能一路“爬”上柜台、钻进墙里
const WALKABLE = .6;
const LOOK_SPEED = .0034; // 弧度 / 像素（60° 视角时）

/** 有这一档就用这一档，否则按 100k → 500k → full_res 找最接近的 */
function pickSplat(assets: WorldAssets, quality: WorldQuality): { url: string; quality: WorldQuality } | null {
  const want = ORDER.indexOf(quality);
  const ranked = [...ORDER].sort((a, b) => Math.abs(ORDER.indexOf(a) - want) - Math.abs(ORDER.indexOf(b) - want) || ORDER.indexOf(a) - ORDER.indexOf(b));
  for (const q of ranked) { const url = assets.splats[q]; if (url) return { url, quality: q }; }
  return null;
}
function fileType(assets: WorldAssets, url: string): string {
  if (assets.format) return assets.format;
  const ext = url.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase();
  return ext === "ksplat" || ext === "ply" || ext === "splat" || ext === "spz" ? ext : "spz";
}

/** 带进度的下载；blob: 地址同样适用 */
async function download(url: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载世界文件失败（${response.status}）`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) { const buffer = await response.arrayBuffer(); onProgress(1); return buffer; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out.buffer;
}

export function createWorldEngine(options: WorldEngineOptions): WorldEngine {
  const { container, assets } = options;
  const eyeHeight = options.eyeHeight ?? 1.6;
  const reduced = !!options.reducedMotion;
  const maxRatio = Math.max(.5, options.pixelRatio);
  const minRatio = Math.min(maxRatio, options.minPixelRatio ?? Math.max(.75, maxRatio * .5));
  let ratio = maxRatio;
  let mode: WalkMode = options.mode ?? "walk";
  let disposed = false, paused = false, ready = false, moved = false;
  const abort = new AbortController();

  // ---------- 画面 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x0b0c0d, 1);
  renderer.setPixelRatio(ratio);
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
  canvas.tabIndex = -1;
  canvas.setAttribute("aria-label", "可以走进去的三维世界");
  container.appendChild(canvas);
  const scene = new THREE.Scene();
  // 近裁剪面 10cm：贴到墙上时把眼前几厘米的高斯点裁掉，而不是满屏糊成一片
const camera = new THREE.PerspectiveCamera(62, 1, .1, 2000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  const resize = () => {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 竖屏时视角放宽一些，否则手机上像从门缝里看
    camera.fov = w < h ? 74 : 62;
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  // ---------- 模型变换 ----------
  const s = assets.metricScale ?? 1, g = assets.groundOffset ?? 0;
  const opencv = (assets.coordinate ?? "opencv") === "opencv";
  const placement = new THREE.Matrix4().compose(
    new THREE.Vector3(0, opencv ? g : -g, 0),
    opencv ? new THREE.Quaternion(1, 0, 0, 0) : new THREE.Quaternion(),
    new THREE.Vector3(s, s, s));
  let mesh: SplatMesh | null = null;
  let splatCount = 0;
  const place = (target: THREE.Object3D) => { placement.decompose(target.position, target.quaternion, target.scale); };

  // ---------- 碰撞 ----------
  let bvh: MeshBVH | null = null;
  let floorY = -Infinity; // 碰撞网格最低处：掉到这下面就回出生点
  const ray = new THREE.Ray();
  let groundNormalY = 1;
  const groundBelow = (x: number, fromY: number, z: number, maxDistance: number): number | null => {
    if (!bvh) return null;
    ray.origin.set(x, fromY, z); ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit || hit.distance > maxDistance) return null;
    groundNormalY = Math.abs(hit.face?.normal.y ?? 1);
    return hit.point.y;
  };
  /** 高斯点里抽样的中心（世界坐标），用来判断碰撞网格怎么摆才和画面重合 */
  const sampleCenters = (count: number): THREE.Vector3[] => {
    const packed = mesh?.packedSplats;
    if (!packed?.numSplats) return [];
    const total = packed.numSplats, step = Math.max(1, Math.floor(total / count));
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < total && out.length < count; i += step) {
      const splat = packed.getSplat(i);
      if (splat.opacity > .5) out.push(splat.center.clone().applyMatrix4(placement));
    }
    return out;
  };
  async function loadCollider(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    gltf.scene.traverse(object => {
      const m = object as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.attributes.position) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", m.geometry.attributes.position.clone());
      if (m.geometry.index) geometry.setIndex(m.geometry.index.clone());
      geometry.applyMatrix4(m.matrixWorld);
      parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
    });
    if (!parts.length) return;
    const raw = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    // 文档说网格与高斯点同一约定，但实际导出的 .glb 常有轴向差异（有的示例里两者的翻转方式就不一样）。
    // 所以按数据挑：候选 = 高斯点的变换 × 8 种轴向翻转，以及不做缩放平移的 8 种翻转；
    // 把抽样的高斯点中心变回网格的原始坐标，量它们到网格表面的中位距离——高斯点贴在表面上，距离最小的就是对的摆法。
    const rawBvh = new MeshBVH(raw);
    const samples = sampleCenters(400);
    const extent = mesh ? new THREE.Box3().setFromPoints(samples).getSize(new THREE.Vector3()).length() : 0;
    const flips: THREE.Matrix4[] = [];
    for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1]) flips.push(new THREE.Matrix4().makeScale(x, y, z));
    const candidates = [...flips.map(f => placement.clone().multiply(f)), ...flips];
    let best: { matrix: THREE.Matrix4; score: number } | null = null;
    const local = new THREE.Vector3(), hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    for (const matrix of candidates) {
      if (!samples.length) break;
      const inverse = matrix.clone().invert();
      const scale = new THREE.Vector3().setFromMatrixScale(matrix).x;
      const distances = samples.map(p => {
        local.copy(p).applyMatrix4(inverse);
        const r = rawBvh.closestPointToPoint(local, hit as never);
        return r ? r.distance * scale : Infinity;
      }).sort((a, b) => a - b);
      const score = distances[distances.length >> 1];
      if (!best || score < best.score) best = { matrix, score };
    }
    rawBvh.geometry.dispose();
    // 没有高斯点可比（不该发生）时按文档的约定；中位距离超过场景尺度的 4% 说明哪种都对不上，按无碰撞处理
    const chosen = !samples.length ? placement : best && best.score < Math.max(.08, extent * .04) ? best.matrix : null;
    if (!chosen) { raw.dispose(); console.warn("[world] 碰撞网格与画面对不上，按无碰撞处理", best?.score); return; }
    const geometry = raw.applyMatrix4(chosen);
    bvh = new MeshBVH(geometry);
    geometry.computeBoundingBox();
    floorY = geometry.boundingBox!.min.y - 4;
  }

  // ---------- 相机状态 ----------
  const spawn = options.spawn ?? {};
  const spawnPosition = () => new THREE.Vector3(...(spawn.position ?? [0, opencv ? g : -g, 0]));
  const spawnYaw = spawn.yaw ?? 0, spawnPitch = spawn.pitch ?? 0;
  const eye = spawnPosition();
  let yaw = spawnYaw, pitch = spawnPitch, yawShown = yaw, pitchShown = pitch;
  let eyeShownY = eye.y;
  const velocity = new THREE.Vector3();
  let vy = 0, grounded = false;
  let home = eye.clone();
  const bounds = assets.collider ? null : (options.bounds ?? { radius: 6 });
  const speedScale = bounds ? Math.min(1, bounds.radius / 3) : 1;
  /** 有碰撞网格时把出生点放到地面上 */
  const settleSpawn = () => {
    const p = spawnPosition();
    if (bvh) {
      const floor = groundBelow(p.x, p.y + .5, p.z, 40);
      if (floor !== null) p.y = floor + eyeHeight;
    }
    home = p;
    eye.copy(p); eyeShownY = p.y; velocity.set(0, 0, 0); vy = 0;
    yaw = yawShown = spawnYaw; pitch = pitchShown = spawnPitch;
  };

  // ---------- 输入 ----------
  const keys = new Set<string>();
  const external = { x: 0, y: 0 };
  const firstMove = () => { if (!moved && ready) { moved = true; options.onFirstMove?.(); } };
  const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable]");
  const keyDown = (event: KeyboardEvent) => {
    if (editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    const code = event.code;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "KeyE", "KeyC", "KeyQ", "ShiftLeft", "ShiftRight"].includes(code)) {
      keys.add(code);
      if (code.startsWith("Arrow") || code === "Space") event.preventDefault();
      if (!code.startsWith("Shift")) firstMove();
    }
  };
  const keyUp = (event: KeyboardEvent) => { keys.delete(event.code); };
  const blur = () => keys.clear();
  let drag: { id: number; x: number; y: number } | null = null;
  const look = (dx: number, dy: number) => {
    const k = LOOK_SPEED * (camera.fov / 62);
    yaw -= dx * k;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * k));
    if (Math.abs(dx) + Math.abs(dy) > 2) firstMove();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
  };
  const pointerMove = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    look(event.clientX - drag.x, event.clientY - drag.y);
    drag.x = event.clientX; drag.y = event.clientY;
  };
  const pointerUp = (event: PointerEvent) => { if (drag?.id === event.pointerId) drag = null; };
  // 滚轮：沿视线轻推一下（全屏界面里不会和页面滚动冲突）
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const push = Math.max(-1, Math.min(1, -event.deltaY / 240)) * 1.6 * speedScale;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(mode === "fly" ? pitch : 0, yaw, 0, "YXZ"));
    velocity.addScaledVector(dir, push);
    firstMove();
  };
  addEventListener("keydown", keyDown);
  addEventListener("keyup", keyUp);
  addEventListener("blur", blur);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("wheel", wheel, { passive: false });

  // ---------- 物理 ----------
  const segStart = new THREE.Vector3(), segEnd = new THREE.Vector3();
  const line = new THREE.Line3();
  const box = new THREE.Box3();
  const triPoint = new THREE.Vector3(), capPoint = new THREE.Vector3(), push = new THREE.Vector3();
  /** 胶囊（眼睛往下到脚上方 STEP 处）与碰撞网格求推出量，直接改 eye */
  const resolve = () => {
    if (!bvh) return;
    const bottom = mode === "walk" ? eye.y - eyeHeight + STEP + RADIUS : eye.y - .45;
    for (let iteration = 0; iteration < 3; iteration++) {
      line.start.set(eye.x, Math.min(bottom, eye.y), eye.z);
      line.end.set(eye.x, eye.y, eye.z);
      box.makeEmpty(); box.expandByPoint(line.start); box.expandByPoint(line.end);
      box.min.addScalar(-RADIUS); box.max.addScalar(RADIUS);
      push.set(0, 0, 0);
      let hits = 0;
      bvh.shapecast({
        intersectsBounds: b => b.intersectsBox(box),
        intersectsTriangle: tri => {
          const distance = tri.closestPointToSegment(line, triPoint, capPoint);
          if (distance < RADIUS) {
            const depth = RADIUS - distance;
            const dir = capPoint.sub(triPoint).normalize();
            line.start.addScaledVector(dir, depth); line.end.addScaledVector(dir, depth);
            hits++;
          }
          return false;
        },
      });
      if (!hits) break;
      push.subVectors(line.end, eye);
      // 行走时竖直方向交给地面射线，胶囊只负责水平推开，避免在斜坡上被往上顶
      if (mode === "walk") push.y = Math.min(0, push.y);
      eye.add(push);
      // 撞墙时去掉朝墙的速度分量，贴着墙滑
      if (push.lengthSq() > 1e-10) {
        const n = push.clone().normalize();
        const into = velocity.dot(n);
        if (into < 0) velocity.addScaledVector(n, -into);
      }
    }
  };
  const softBounds = (dt: number) => {
    if (!bounds) return;
    const dx = eye.x - home.x, dz = eye.z - home.z;
    const d = Math.hypot(dx, dz), R = bounds.radius;
    if (d > R) {
      // 越界部分按 80ms 的时间常数收回：像碰到一层有弹性的边，而不是硬墙
      const next = R + (d - R) * Math.exp(-dt / .08);
      eye.x = home.x + dx / d * next; eye.z = home.z + dz / d * next;
      const radial = (velocity.x * dx + velocity.z * dz) / d;
      if (radial > 0) { velocity.x -= dx / d * radial; velocity.z -= dz / d * radial; }
    }
    if (mode === "fly") {
      const limit = R * .6, dy = eye.y - home.y;
      if (Math.abs(dy) > limit) eye.y = home.y + Math.sign(dy) * (limit + (Math.abs(dy) - limit) * Math.exp(-dt / .08));
    } else eye.y = home.y;
  };
  const forward = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3();
  const step = (dt: number) => {
    const run = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const ix = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) + external.x;
    const iz = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) + external.y;
    const iy = mode === "fly" ? (keys.has("Space") || keys.has("KeyE") ? 1 : 0) - (keys.has("KeyC") || keys.has("KeyQ") ? 1 : 0) : 0;
    const base = (mode === "fly" ? (run ? 5 : 2) : (run ? 3 : 1.4)) * speedScale;
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    if (mode === "fly") forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    wish.set(0, 0, 0).addScaledVector(forward, iz).addScaledVector(right, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(base);
    if (mode === "fly") wish.y += iy * base * .8;
    // 起步快一点（τ≈0.1s，约 0.25s 到速），松手稍慢（τ≈0.12s，约 0.3s 停稳）
    const tau = wish.lengthSq() > velocity.lengthSq() ? .1 : .12;
    const k = 1 - Math.exp(-dt / tau);
    if (mode === "walk") { velocity.x += (wish.x - velocity.x) * k; velocity.z += (wish.z - velocity.z) * k; velocity.y = 0; }
    else velocity.lerp(wish, k);

    const beforeX = eye.x, beforeZ = eye.z;
    eye.addScaledVector(velocity, dt);
    if (mode === "walk" && bvh) {
      // 重力 + 贴地：从脚上方 STEP 处往下找地面；在台阶高度以内、且不太陡就站上去
      vy -= GRAVITY * dt;
      eye.y += vy * dt;
      const feet = eye.y - eyeHeight;
      const floor = groundBelow(eye.x, feet + STEP + .05, eye.z, STEP + .05 + Math.max(.05, -vy * dt) + (grounded ? STEP : 0));
      if (floor !== null && floor > feet + .02 && groundNormalY < WALKABLE) {
        // 往上走到了陡坡上：当作墙，退回这一步的水平位移
        eye.x = beforeX; eye.z = beforeZ; velocity.x = velocity.z = 0;
        eye.y = feet + eyeHeight - vy * dt; vy = 0;
      } else if (floor !== null && floor >= feet - (grounded ? STEP : 0) - .02) { eye.y = floor + eyeHeight; vy = 0; grounded = true; }
      else grounded = false;
    }
    resolve();
    softBounds(dt);
    if (bvh && eye.y < floorY) settleSpawn();
  };

  // ---------- 渲染循环 ----------
  let last = 0, statFrames = 0, statTime = 0, slow = 0, fast = 0;
  let reset: { from: THREE.Vector3; yaw: number; pitch: number; t: number } | null = null;
  const frame = (now: number) => {
    if (disposed || paused) return;
    const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60;
    const frameMs = last ? now - last : 16;
    last = now;
    if (ready) {
      if (reset) {
        reset.t = Math.min(1, reset.t + dt / .8);
        const e = reset.t < .5 ? 4 * reset.t ** 3 : 1 - (-2 * reset.t + 2) ** 3 / 2;
        eye.lerpVectors(reset.from, home, e);
        yaw = reset.yaw + (spawnYaw - reset.yaw) * e; pitch = reset.pitch + (spawnPitch - reset.pitch) * e;
        yawShown = yaw; pitchShown = pitch;
        if (reset.t >= 1) { reset = null; velocity.set(0, 0, 0); }
      } else {
        // 拖动转头带一点跟随（τ≈40ms），手感顺滑但不拖泥带水
        const lk = reduced ? 1 : 1 - Math.exp(-dt / .04);
        yawShown += (yaw - yawShown) * lk; pitchShown += (pitch - pitchShown) * lk;
        const substeps = Math.ceil(dt / (1 / 120));
        for (let i = 0; i < substeps; i++) step(dt / substeps);
      }
      // 上台阶时镜头高度平滑跟上（τ≈90ms）
      eyeShownY += (eye.y - eyeShownY) * (reduced ? 1 : 1 - Math.exp(-dt / .09));
      if (Math.abs(eye.y - eyeShownY) > 1.5) eyeShownY = eye.y;
      camera.position.set(eye.x, eyeShownY, eye.z);
      camera.quaternion.setFromEuler(new THREE.Euler(pitchShown, yawShown, 0, "YXZ"));
    }
    renderer.render(scene, camera);

    // 自适应像素比：持续偏慢降一档，持续充裕再升回来（不超过页面给的上限）
    if (ready && !document.hidden) {
      if (frameMs > 22.5) { slow += frameMs; fast = 0; } else if (frameMs < 13) { fast += frameMs; slow = 0; } else { slow = fast = 0; }
      if (slow > 1500 && ratio > minRatio + .01) { ratio = Math.max(minRatio, ratio - .25); renderer.setPixelRatio(ratio); resize(); slow = 0; }
      if (fast > 4000 && ratio < maxRatio - .01) { ratio = Math.min(maxRatio, ratio + .25); renderer.setPixelRatio(ratio); resize(); fast = 0; }
    }
    statFrames++; statTime += frameMs;
    if (statTime >= 1000) {
      options.onStats?.({ fps: Math.round(statFrames * 1000 / statTime), splats: splatCount, pixelRatio: ratio });
      statFrames = 0; statTime = 0;
    }
  };
  const start = () => { last = 0; renderer.setAnimationLoop(frame); };
  const visibility = () => { if (document.hidden) renderer.setAnimationLoop(null); else if (!paused && !disposed) start(); };
  document.addEventListener("visibilitychange", visibility);
  start();

  // ---------- 载入 ----------
  let loadToken = 0;
  async function loadSplats(quality: WorldQuality, initial: boolean) {
    const token = ++loadToken;
    const pick = pickSplat(assets, quality);
    if (!pick) throw new Error("这个世界没有可用的三维文件。");
    const report = (p: number) => { if (token === loadToken) options.onProgress?.(Math.max(0, Math.min(1, p))); };
    report(0);
    const bytes = await download(pick.url, p => report(p * .85), abort.signal);
    if (disposed || token !== loadToken) return;
    const next = new SplatMesh({ fileBytes: bytes, fileType: fileType(assets, pick.url) as never, fileName: pick.url.split("?")[0].split("/").pop() });
    place(next);
    await next.initialized;
    if (disposed || token !== loadToken) { next.dispose(); return; }
    report(.95);
    scene.add(next);
    const old = mesh;
    mesh = next;
    splatCount = next.packedSplats?.numSplats ?? 0;
    if (old) { scene.remove(old); old.dispose(); }
    if (initial && assets.collider) {
      try { await loadCollider(assets.collider); } catch (error) { console.warn("[world] 碰撞网格载入失败，按无碰撞处理", error); }
    }
    if (initial) settleSpawn();
    report(1);
  }
  loadSplats(options.quality, true).then(() => {
    if (disposed) return;
    ready = true;
    options.onReady?.();
  }, error => {
    if (disposed || abort.signal.aborted) return;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  const engine: WorldEngine & { __debug?: () => unknown } = {
    async setQuality(quality) { if (!disposed) await loadSplats(quality, false); },
    setMode(next) {
      if (next === mode) return;
      mode = next; vy = 0;
      // 从飞行切回行走：落到脚下的地面（没有碰撞网格就回到出生高度）
      if (mode === "walk" && bvh) { const floor = groundBelow(eye.x, eye.y, eye.z, 200); if (floor !== null) eye.y = floor + eyeHeight; }
    },
    setPixelRatio(next) { ratio = Math.max(minRatio, Math.min(maxRatio, next)); renderer.setPixelRatio(ratio); resize(); },
    resetView() {
      if (!ready) return;
      if (reduced) { settleSpawn(); return; }
      reset = { from: eye.clone(), yaw, pitch, t: 0 };
      velocity.set(0, 0, 0); vy = 0;
    },
    setPaused(next) {
      paused = next;
      if (paused) renderer.setAnimationLoop(null); else if (!document.hidden && !disposed) start();
    },
    setMoveInput(x, y) {
      external.x = Math.max(-1, Math.min(1, x)); external.y = Math.max(-1, Math.min(1, y));
      if (Math.hypot(x, y) > .1) firstMove();
    },
    look,
    capture() {
      renderer.render(scene, camera);
      return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("截图失败")), "image/png"));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      renderer.setAnimationLoop(null);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", blur);
      mesh?.dispose(); mesh = null;
      bvh?.geometry.dispose(); bvh = null;
      (spark as unknown as { dispose?: () => void }).dispose?.();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  // 验收脚本用（world-engine/test）：不在接口约定里
  engine.__debug = () => ({ eye: eye.toArray().map(v => +v.toFixed(3)), yaw: +yaw.toFixed(3), grounded, collider: !!bvh, mode, ratio, splats: splatCount });
  return engine;
}
