"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// 动效地基：FLIP 让序列增删时后面的片段平滑让位
import { prefersReduced, useFlipList } from "@/lib/motion";
import { downloadJobFile } from "@/lib/api";
import { downloadAsset, type DownloadProgress } from "@/lib/asset-download";
import { isDesktopApp, openWorksFolder, saveWorkFile, workFolder } from "@/lib/desktop";
import { createFrameGovernor, perfProfile, readPerfChoice, savePerfChoice, type PerfChoice, type PerfProfile } from "@/lib/perf";

/**
 * SplatViewer 2.0
 * - 十四种运镜，全部是 t∈[0,1] 的纯轨迹函数，无缝循环
 * - 时间轴引擎：开场粒子凝聚 → 运镜A → 平滑过渡 → 运镜B → …
 *   预览与导出共用同一条时间轴，所见即所得
 * - 开场动画原理：每个高斯就是一颗粒子，把 splatScale 从尘埃
 *   尺寸(0.02)养到全尺寸(1.0)，画面便从星尘凝聚成实景
 * - 导出：WebCodecs 逐帧编码 H.264 + mp4-muxer 封装
 */

type Preset =
  | "orbit" | "push" | "sweep" | "pedestal" | "arcpush" | "spiral"
  | "dollyzoom" | "handheld" | "pan" | "tilt" | "pendulum"
  | "float" | "dutch" | "breathe";

const PRESETS: { id: Preset; name: string; dur: number }[] = [
  { id: "orbit", name: "环绕", dur: 8 },
  { id: "push", name: "缓推", dur: 6 },
  { id: "sweep", name: "横移", dur: 6 },
  { id: "pedestal", name: "升降", dur: 6 },
  { id: "arcpush", name: "弧推", dur: 7 },
  { id: "spiral", name: "螺旋", dur: 8 },
  { id: "dollyzoom", name: "变焦", dur: 6 },
  { id: "handheld", name: "手持", dur: 8 },
  { id: "pan", name: "摇镜", dur: 7 },
  { id: "tilt", name: "俯仰", dur: 7 },
  { id: "pendulum", name: "摇臂", dur: 7 },
  { id: "float", name: "悬浮", dur: 10 },
  { id: "dutch", name: "侧倾", dur: 8 },
  { id: "breathe", name: "呼吸", dur: 10 },
];

const TARGET_Z = 1.8;
const FLY_SPEED = 0.9; // 场景单位/秒：约半个画面纵深每秒，细看和穿行都够用

// 键位 → 方向：x 右，y 上，z 前。方向键作为 WASD 的别名
const FLY_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1], ArrowUp: [0, 0, 1],
  KeyS: [0, 0, -1], ArrowDown: [0, 0, -1],
  KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
  Space: [0, 1, 0],
  ShiftLeft: [0, -1, 0], ShiftRight: [0, -1, 0],
};
const INTRO_DUR = 2.6; // 开场粒子凝聚时长
const BLEND_DUR = 0.8; // 运镜之间的过渡时长

const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const cycle = (t: number) => (1 - Math.cos(t * Math.PI * 2)) / 2;

type Pose = {
  pos: [number, number, number];
  fovScale: number;
  look?: [number, number, number];
  roll?: number;
};

function trajectory(preset: Preset, t: number): Pose {
  const TAU = Math.PI * 2;
  switch (preset) {
    case "orbit": {
      const ang = t * TAU;
      return { pos: [Math.sin(ang) * 0.22, 0, (1 - Math.cos(ang)) * 0.07], fovScale: 1 };
    }
    case "push": {
      const s = easeInOut(cycle(t));
      return { pos: [0, 0, s * 0.6], fovScale: 1 };
    }
    case "sweep": {
      const s = easeInOut(cycle(t)) * 2 - 1;
      return { pos: [s * 0.25, 0, 0], fovScale: 1 };
    }
    case "pedestal": {
      const s = easeInOut(cycle(t)) * 2 - 1;
      return { pos: [0, s * 0.15, 0], fovScale: 1 };
    }
    case "arcpush": {
      const s = easeInOut(cycle(t));
      return { pos: [0.22 * (1 - s), -0.05 * s, 0.45 * s], fovScale: 1 };
    }
    case "spiral": {
      const ang = t * TAU;
      const b = easeInOut(cycle(t));
      const r = 0.18 - 0.1 * b;
      return {
        pos: [Math.sin(ang) * r, -0.04 * b, (1 - Math.cos(ang)) * 0.05 + 0.35 * b],
        fovScale: 1,
      };
    }
    case "dollyzoom": {
      const s = easeInOut(cycle(t));
      const d = TARGET_Z - s * 0.7;
      return { pos: [0, 0, TARGET_Z - d], fovScale: TARGET_Z / d };
    }
    case "handheld": {
      const px = 0.013 * Math.sin(TAU * 2 * t) + 0.007 * Math.sin(TAU * 5 * t + 1.3);
      const py = 0.011 * Math.sin(TAU * 3 * t + 0.7) + 0.006 * Math.sin(TAU * 7 * t + 2.1);
      const pz = 0.08 * easeInOut(cycle(t)) + 0.01 * Math.sin(TAU * t + 0.4);
      const lx = 0.02 * Math.sin(TAU * t + 2.0) + 0.012 * Math.sin(TAU * 4 * t);
      const ly = 0.018 * Math.sin(TAU * 2 * t + 0.9);
      return { pos: [px, py, pz], fovScale: 1, look: [lx, ly, 0] };
    }
    case "pan": {
      const s = easeInOut(cycle(t)) * 2 - 1;
      return { pos: [0, 0, 0], fovScale: 1, look: [s * 0.35, 0, 0] };
    }
    case "tilt": {
      const s = easeInOut(cycle(t)) * 2 - 1;
      return { pos: [0, 0, 0], fovScale: 1, look: [0, s * 0.22, 0] };
    }
    case "pendulum": {
      const ang = 0.45 * Math.sin(TAU * t);
      return { pos: [Math.sin(ang) * 0.35, 0, (1 - Math.cos(ang)) * 0.35], fovScale: 1 };
    }
    case "float": {
      return {
        pos: [Math.sin(TAU * t) * 0.12, Math.sin(TAU * 2 * t) * 0.06, (1 - Math.cos(TAU * t)) * 0.04],
        fovScale: 1,
      };
    }
    case "dutch": {
      const s = easeInOut(cycle(t)) * 2 - 1;
      return { pos: [0, 0, 0.15 * easeInOut(cycle(t))], fovScale: 1, roll: s * 0.105 };
    }
    case "breathe": {
      const s = easeInOut(cycle(t));
      return { pos: [0, -0.015 * s, 0.1 * s], fovScale: 1 };
    }
  }
}

// ---------- 时间轴引擎 ----------
type Seg =
  | { kind: "intro"; dur: number; to: Pose }
  | { kind: "move"; preset: Preset; dur: number }
  | { kind: "blend"; from: Pose; to: Pose; dur: number };

type Timeline = { segs: Seg[]; total: number };

function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const e = easeInOut(Math.min(Math.max(k, 0), 1));
  const la = a.look || [0, 0, 0];
  const lb = b.look || [0, 0, 0];
  const L = (x: number, y: number) => x + (y - x) * e;
  return {
    pos: [L(a.pos[0], b.pos[0]), L(a.pos[1], b.pos[1]), L(a.pos[2], b.pos[2])],
    fovScale: L(a.fovScale, b.fovScale),
    look: [L(la[0], lb[0]), L(la[1], lb[1]), L(la[2], lb[2])],
    roll: L(a.roll || 0, b.roll || 0),
  };
}

function buildTimeline(seq: Preset[], withIntro: boolean): Timeline {
  const segs: Seg[] = [];
  if (withIntro) segs.push({ kind: "intro", dur: INTRO_DUR, to: trajectory(seq[0], 0) });
  seq.forEach((p, i) => {
    if (i > 0)
      segs.push({
        kind: "blend",
        dur: BLEND_DUR,
        from: trajectory(seq[i - 1], 1),
        to: trajectory(p, 0),
      });
    segs.push({ kind: "move", preset: p, dur: PRESETS.find((x) => x.id === p)!.dur });
  });
  return { segs, total: segs.reduce((s, x) => s + x.dur, 0) };
}

/** 在时间轴上采样：返回相机位姿 + 粒子尺寸(splatScale) */
function sampleTimeline(tl: Timeline, time: number): { pose: Pose; splat: number } {
  let t = time;
  for (const s of tl.segs) {
    if (t <= s.dur) {
      const k = s.dur > 0 ? t / s.dur : 1;
      if (s.kind === "move") return { pose: trajectory(s.preset, Math.min(k, 1)), splat: 1 };
      if (s.kind === "blend") return { pose: lerpPose(s.from, s.to, k), splat: 1 };
      // intro：机位从后方滑入 + 粒子从尘埃凝聚成像
      const start: Pose = {
        ...s.to,
        pos: [s.to.pos[0], s.to.pos[1] - 0.02, s.to.pos[2] - 0.35],
      };
      return { pose: lerpPose(start, s.to, k), splat: 0.02 + 0.98 * easeInOut(k) };
    }
    t -= s.dur;
  }
  const lastSeg = tl.segs[tl.segs.length - 1];
  const endPose =
    lastSeg.kind === "move" ? trajectory(lastSeg.preset, 1)
    : lastSeg.kind === "blend" ? lastSeg.to : lastSeg.to;
  return { pose: endPose, splat: 1 };
}

// ---------- 组件 ----------
type PreviewMode =
  | { kind: "free" }
  | { kind: "intro"; start: number }
  | { kind: "solo"; preset: Preset; start: number }
  | { kind: "seq"; tl: Timeline; start: number };

export default function SplatViewer({ plyUrl, jobId, backendUrl, sceneFormat = 'ply', posterUrl, previewQuality = 'full', preparationError, onPreparationRetry, onAssetLoaded }: { plyUrl: string; jobId?: string; backendUrl?: string; sceneFormat?: 'ply' | 'splat'; posterUrl?: string; previewQuality?: 'mobile' | 'full'; preparationError?: string; onPreparationRetry?: () => void; onAssetLoaded?: (blob: Blob) => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const rendererRef = useRef<any>(null);
  const roRef = useRef<any>(null);
  const threeRef = useRef<any>(null);
  const baseFovRef = useRef(50);
  const previewRef = useRef<PreviewMode>({ kind: "free" });
  const recordingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [preset, setPreset] = useState<Preset | "free">("free");
  // 每个片段带一个 uid：同一种运镜可以重复加入，FLIP 靠 uid 认人
  const [seq, setSeq] = useState<{ p: Preset; k: number }[]>([]);
  const uid = useRef(0);
  const seqIds = useMemo<Preset[]>(() => seq.map((x) => x.p), [seq]);
  const seqRef = useRef<HTMLDivElement | null>(null);
  useFlipList(seqRef, seq);
  const [seqPlaying, setSeqPlaying] = useState(false);
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);
  const restartDownloadRef = useRef(false);
  const loadedAssetRef = useRef<{ identity: string; blob: Blob } | null>(null);
  const [loadPhase, setLoadPhase] = useState<'download' | 'decode'>('download');
  const [download, setDownload] = useState<DownloadProgress>({ received: 0, total: 0, retry: 0 });
  const [loadSeconds, setLoadSeconds] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [sceneInfo, setSceneInfo] = useState({ points: 0, bytes: 0 });
  const onAssetLoadedRef = useRef(onAssetLoaded);
  onAssetLoadedRef.current = onAssetLoaded;
  const [recording, setRecording] = useState(false);
  const [recProgress, setRecProgress] = useState(0);
  const [canRecord, setCanRecord] = useState(true);
  // 运镜面板折叠：默认收起，不挡画面；点把手展开

  const nameOf = (p: Preset) => PRESETS.find((x) => x.id === p)!.name;

  // ---- 画质档位：按硬件自动选，也可以手动指定；运行中按帧率微调渲染分辨率 ----
  const [perfChoice, setPerfChoice] = useState<PerfChoice>("auto");
  const [perfInfo, setPerfInfo] = useState<{ tier: string; ratio: number } | null>(null);
  const profileRef = useRef<PerfProfile | null>(null);
  const governorRef = useRef<ReturnType<typeof createFrameGovernor> | null>(null);
  const applyPixelRatio = (ratio: number) => {
    const renderer = rendererRef.current, mount = mountRef.current;
    if (!renderer || !mount) return;
    renderer.setPixelRatio(ratio);
    renderer.setSize(mount.clientWidth || 960, mount.clientHeight || 600);
    viewerRef.current?.forceRenderNextFrame?.();
    setPerfInfo(info => ({ tier: profileRef.current?.tier || info?.tier || "", ratio }));
  };
  useEffect(() => { setPerfChoice(readPerfChoice()); }, []);
  function choosePerf(choice: PerfChoice) {
    setPerfChoice(choice); savePerfChoice(choice);
    const profile = perfProfile(choice);
    profileRef.current = profile;
    governorRef.current?.set(profile.maxPixelRatio);
    applyPixelRatio(profile.maxPixelRatio);
  }

  // ---- 键盘飞行：W/S 前后，A/D 左右，空格上升，Shift 下降 ----
  const heldKeysRef = useRef(new Set<string>());
  const readyRef = useRef(false);
  readyRef.current = ready;
  const flyInput = () => {
    const held = heldKeysRef.current;
    if (!held.size) return null;
    let x = 0, y = 0, z = 0;
    for (const code of held) { const d = FLY_KEYS[code]; if (d) { x += d[0]; y += d[1]; z += d[2]; } }
    return { x: Math.sign(x), y: Math.sign(y), z: Math.sign(z) };
  };
  useEffect(() => {
    const held = heldKeysRef.current;
    const typing = (el: EventTarget | null) => el instanceof HTMLElement
      && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const onScreen = () => {
      const r = mountRef.current?.getBoundingClientRect();
      return !!r && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    };
    const down = (e: KeyboardEvent) => {
      if (!FLY_KEYS[e.code] || !readyRef.current || recordingRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || !onScreen()) return;
      e.preventDefault(); // 空格不滚页面、不重复按下聚焦的按钮
      held.add(e.code);
    };
    const up = (e: KeyboardEvent) => {
      if (!held.delete(e.code)) return;
      e.preventDefault();
    };
    const clear = () => held.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      clear();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  /** 运镜播放中按下移动键：从当前机位直接接管，不跳回原点 */
  function takeOverCamera() {
    const viewer = viewerRef.current;
    const THREE = threeRef.current;
    if (!viewer?.camera || !THREE) return;
    previewRef.current = { kind: "free" };
    setPreset("free");
    setSeqPlaying(false);
    setSplat(1);
    const cam = viewer.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    cam.up.set(0, 1, 0);
    cam.fov = baseFovRef.current;
    cam.updateProjectionMatrix();
    if (viewer.controls) {
      viewer.controls.target.copy(cam.position).addScaledVector(dir, TARGET_Z);
      viewer.controls.enabled = true;
      viewer.controls.update?.();
    }
  }
  const setSplat = (v: number) => {
    try { viewerRef.current?.splatMesh?.setSplatScale?.(v); } catch {}
  };

  function applyPose(cam: any, pose: Pose) {
    const THREE = threeRef.current;
    const r = pose.roll || 0;
    cam.up.set(Math.sin(r), Math.cos(r), 0);
    cam.position.set(pose.pos[0], -pose.pos[1], -pose.pos[2]);
    const lk = pose.look || [0, 0, 0];
    cam.lookAt(new THREE.Vector3(lk[0], -lk[1], -TARGET_Z - lk[2]));
    const base = (baseFovRef.current * Math.PI) / 180;
    const fov = 2 * Math.atan(Math.tan(base / 2) * pose.fovScale);
    cam.fov = (fov * 180) / Math.PI;
    cam.updateProjectionMatrix();
  }

  useEffect(() => {
    setReady(false);
    setErr("");
    setLoadPhase('download');
    setDownload({ received: 0, total: 0, retry: 0 });
    setLoadSeconds(0);
    setStalled(false);
    setSceneInfo({ points: 0, bytes: 0 });
    if (!plyUrl) return;
    const restartDownload = restartDownloadRef.current;
    restartDownloadRef.current = false;
    const assetLoaded = onAssetLoadedRef.current;
    if (typeof window !== "undefined" && typeof (window as any).VideoEncoder === "undefined") {
      setCanRecord(false);
    }
    let disposed = false;
    let raf = 0;
    let ownedViewer: any = null;
    let ownedRenderer: any = null;
    let released = false;
    let rejectContext: (reason: Error) => void = () => {};
    const contextFailure = new Promise<never>((_, reject) => { rejectContext = reject; });
    // Context loss may occur after the initial load promise has already settled.
    void contextFailure.catch(() => {});
    const contextLost = (event: Event) => {
      event.preventDefault();
      if (disposed || released) return;
      const error = new Error('浏览器的三维画面被系统暂停了。请关闭其他占用内存的页面后重试，已保存的完整场景仍可使用。');
      clearInterval(elapsedTimer);
      cancelAnimationFrame(raf);
      ownedViewer?.stop?.();
      setReady(false); setStalled(false); setErr(error.message);
      rejectContext(error);
    };
    const releaseViewer = () => {
      if (released) return;
      released = true;
      ownedRenderer?.domElement?.removeEventListener('webglcontextlost', contextLost);
      cancelAnimationFrame(raf);
      try { roRef.current?.disconnect?.(); } catch {}
      try { ownedViewer?.stop?.(); ownedViewer?.controls?.stopListenToKeyEvents?.(); } catch {}
      Promise.resolve().then(() => ownedViewer?.dispose?.()).catch(() => {}).finally(() => {
        ownedRenderer?.dispose?.();
        ownedRenderer?.domElement?.remove();
      });
    };
    let sceneObjectUrl = '';
    const controller = new AbortController();
    const loadStarted = performance.now();
    let lastProgressAt = loadStarted, lastReceived = 0, downloading = true;
    const progress = (value: DownloadProgress) => {
      if (value.received !== lastReceived || value.phase === 'unpack') { lastProgressAt = performance.now(); lastReceived = value.received; setStalled(false); }
      setDownload(value);
    };
    const elapsedTimer = setInterval(() => {
      setLoadSeconds(Math.round((performance.now() - loadStarted) / 1000));
      setStalled(downloading && performance.now() - lastProgressAt >= 15000);
    }, 1000);

    (async () => {
      try {
        const isOffline = plyUrl.startsWith('blob:');
        const filename = !isOffline ? decodeURIComponent(new URL(plyUrl, location.href).pathname.split('/').pop() || '') : '';
        const identity = jobId && filename ? `${backendUrl || ''}::${jobId}::${filename}` : plyUrl;
        if (restartDownload || loadedAssetRef.current?.identity !== identity) loadedAssetRef.current = null;
        const assetPromise = loadedAssetRef.current
          ? Promise.resolve(loadedAssetRef.current.blob)
          : jobId && filename
          ? downloadJobFile(jobId, filename, backendUrl, { signal: controller.signal, onProgress: progress, restart: restartDownload })
          : downloadAsset(plyUrl, { signal: controller.signal, onProgress: progress, restart: restartDownload });
        const [GS, THREE, asset] = await Promise.all([
          import("@mkkellogg/gaussian-splats-3d"),
          import("three"),
          assetPromise,
        ]);
        if (disposed || !mountRef.current) return;
        loadedAssetRef.current = { identity, blob: asset };
        downloading = false; setStalled(false);
        assetLoaded?.(asset);
        setLoadPhase('decode');
        // Paint the phase label before the CPU decoder starts.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (disposed || !mountRef.current) return;
        threeRef.current = THREE;

        const mount = mountRef.current;
        const profile = perfProfile();
        profileRef.current = profile;
        const dpr = profile.maxPixelRatio;
        governorRef.current = createFrameGovernor(() => profileRef.current || profile, dpr);
        setPerfInfo({ tier: profile.tier, ratio: dpr });
        const W = mount.clientWidth || 960;
        const H = mount.clientHeight || 600;
        const renderer = new THREE.WebGLRenderer({
          powerPreference: "high-performance", // 双显卡电脑上用独显
          antialias: false,
          precision: "highp",
          preserveDrawingBuffer: true, // 录制抓帧的前提
        });
        renderer.setPixelRatio(dpr);
        renderer.setClearColor(new THREE.Color(0x04060a), 1);
        renderer.setSize(W, H);
        rendererRef.current = renderer;
        ownedRenderer = renderer;
        renderer.domElement.addEventListener('webglcontextlost', contextLost);
        // 外部渲染器需要自己把画布挂进 DOM（库只给"亲生"渲染器挂）
        renderer.domElement.style.display = "block";
        mount.appendChild(renderer.domElement);

        const viewer = new GS.Viewer({
          rootElement: mount,
          renderer,
          cameraUp: [0, 1, 0],
          initialCameraPosition: [0, 0, 0],
          initialCameraLookAt: [0, 0, -TARGET_Z],
          gpuAcceleratedSort: false,
          integerBasedSort: false,
          sharedMemoryForWorkers: false,
          // Free duplicate CPU texture buffers after upload. Keep every point and
          // full-precision GPU data; this is memory cleanup, not scene decimation.
          freeIntermediateSplatData: true,
          halfPrecisionCovariancesOnGPU: false,
          inMemoryCompressionLevel: 0,
          selfDrivenMode: true,
        });
        viewerRef.current = viewer;
        ownedViewer = viewer;

        const ro = new ResizeObserver(() => {
          const w = mount.clientWidth || 960;
          const h = mount.clientHeight || 600;
          renderer.setSize(w, h);
          if (viewer.camera) {
            viewer.camera.aspect = w / h;
            viewer.camera.updateProjectionMatrix();
          }
        });
        ro.observe(mount);
        roRef.current = ro;

        sceneObjectUrl = URL.createObjectURL(asset);
        const loading = viewer.addSplatScene(sceneObjectUrl, {
          rotation: [1, 0, 0, 0], // SHARP OpenCV coordinates -> Three.js coordinates.
          format: sceneFormat === 'splat' ? GS.SceneFormat.Splat : GS.SceneFormat.Ply,
          progressiveLoad: false,
          showLoadingUI: false,
        });
        // Library AbortablePromise.then ignores the rejection callback required by await.
        // Await its native promise so a decoder failure always exits the loading state.
        let decodeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            loading.promise || loading,
            contextFailure,
            new Promise((_, reject) => { decodeTimer = setTimeout(() => reject(new Error('文件已下载，但场景解析超时。请关闭其他占用内存的页面后重试。')), 120000); }),
          ]);
        } finally { clearTimeout(decodeTimer); URL.revokeObjectURL(sceneObjectUrl); sceneObjectUrl = ''; }
        if (disposed) return;

        viewer.start();
        // 库在 window 上挂了调试快捷键（F/G 改焦距、P 点云、方向键翻滚…），会和 WASD 冲突
        if (viewer.keyDownListener) window.removeEventListener('keydown', viewer.keyDownListener);
        viewer.controls && (viewer.controls.target = new THREE.Vector3(0, 0, -TARGET_Z));
        // —— 放开相机控制：让用户能自由走进场景的任何地方 ——
        if (viewer.controls) {
          const c: any = viewer.controls;
          c.enablePan = true;            // 允许平移（走到场景里）
          c.enableZoom = true;           // 允许推拉
          c.enableRotate = true;         // 允许环绕
          c.screenSpacePanning = true;   // 平移跟随屏幕，移动更自然
          c.panSpeed = 1.2;
          c.zoomSpeed = 1.2;
          c.rotateSpeed = 0.9;
          c.minDistance = 0.01;          // 几乎可以贴到物体表面
          c.maxDistance = 50;            // 也可以拉很远
          c.minPolarAngle = 0;           // 不限制俯仰
          c.maxPolarAngle = Math.PI;
          c.enableDamping = true;        // 惯性，手感顺滑
          c.dampingFactor = 0.08;
          // 键盘移动由下面的 WASD 飞行控制接管：关掉库自带的方向键平移
          c.stopListenToKeyEvents?.();
          c.update?.();
        }
        baseFovRef.current = viewer.camera.fov;
        {
          const w = mount.clientWidth || 960;
          const h = mount.clientHeight || 600;
          renderer.setSize(w, h);
          viewer.camera.aspect = w / h;
          viewer.camera.up.set(0, 1, 0);
          viewer.camera.updateProjectionMatrix();
        }
        setReady(true);
        setSceneInfo({ points: viewer.splatMesh.getSplatCount(), bytes: asset.size });
        clearInterval(elapsedTimer);

        // 场景就绪：播放一次粒子凝聚开场
        if (viewer.controls) viewer.controls.enabled = prefersReduced();
        previewRef.current = prefersReduced() ? { kind: "free" } : { kind: "intro", start: performance.now() };

        const introPoseTarget: Pose = { pos: [0, 0, 0], fovScale: 1 };

        let lastTick = 0;
        const forward = new THREE.Vector3(), right = new THREE.Vector3(), step = new THREE.Vector3();
        const worldUp = new THREE.Vector3(0, 1, 0);
        const tick = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
          lastTick = now;
          const adjusted = governorRef.current?.tick(now, recordingRef.current || document.hidden);
          if (adjusted) applyPixelRatio(adjusted);
          if (recordingRef.current || document.hidden) return;
          const v = viewerRef.current;
          const cam = v?.camera;
          if (!cam) return;
          const move = flyInput();
          if (move && previewRef.current.kind !== "intro") {
            if (previewRef.current.kind !== "free") takeOverCamera();
            // 前后左右沿水平面走（抬头低头不会把人带上天），空格/Shift 负责竖直升降
            cam.getWorldDirection(forward);
            forward.y = 0;
            if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0);
            forward.normalize();
            right.crossVectors(forward, worldUp).normalize();
            step.set(0, 0, 0)
              .addScaledVector(forward, move.z)
              .addScaledVector(right, move.x)
              .addScaledVector(worldUp, move.y);
            if (step.lengthSq() > 0) {
              step.normalize().multiplyScalar(FLY_SPEED * dt);
              cam.position.add(step);
              v.controls?.target.add(step);
              v.controls?.update?.();
            }
          }
          const pv = previewRef.current;

          if (pv.kind === "intro") {
            const k = (now - pv.start) / 1000 / INTRO_DUR;
            if (k >= 1) {
              setSplat(1);
              applyPose(cam, introPoseTarget);
              previewRef.current = { kind: "free" };
              if (v.controls) {
                v.controls.target.set(0, 0, -TARGET_Z);
                v.controls.enabled = true;
                v.controls.update?.();
              }
              return;
            }
            const start: Pose = { pos: [0, -0.02, -0.35], fovScale: 1 };
            applyPose(cam, lerpPose(start, introPoseTarget, k));
            setSplat(0.02 + 0.98 * easeInOut(k));
            v.forceRenderNextFrame?.();
          } else if (pv.kind === "solo") {
            const def = PRESETS.find((p) => p.id === pv.preset)!;
            const t = ((now - pv.start) / 1000 / def.dur) % 1;
            applyPose(cam, trajectory(pv.preset, t));
            v.forceRenderNextFrame?.();
          } else if (pv.kind === "seq") {
            const time = ((now - pv.start) / 1000) % pv.tl.total;
            const { pose, splat } = sampleTimeline(pv.tl, time);
            applyPose(cam, pose);
            setSplat(splat);
            v.forceRenderNextFrame?.();
          } else {
            // 自由查看：库是惰性渲染，静止时也要强制出画面
            v.forceRenderNextFrame?.();
          }
        };
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        clearInterval(elapsedTimer);
        releaseViewer();
        if (!disposed) setErr(e?.message || "查看器初始化失败");
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      clearInterval(elapsedTimer);
      if (sceneObjectUrl) URL.revokeObjectURL(sceneObjectUrl);
      recordingRef.current = false;
      releaseViewer();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plyUrl, jobId, backendUrl, sceneFormat, attempt]);

  function selectPreset(p: Preset | "free") {
    const viewer = viewerRef.current;
    const THREE = threeRef.current;
    setPreset(p);
    setSeqPlaying(false);
    if (!viewer?.camera) return;
    setSplat(1);

    if (p === "free") {
      previewRef.current = { kind: "free" };
      viewer.camera.fov = baseFovRef.current;
      viewer.camera.up.set(0, 1, 0);
      viewer.camera.updateProjectionMatrix();
      viewer.camera.position.set(0, 0, 0);
      viewer.camera.lookAt(new THREE.Vector3(0, 0, -TARGET_Z));
      if (viewer.controls) {
        viewer.controls.target.set(0, 0, -TARGET_Z);
        viewer.controls.enabled = true;
        viewer.controls.update?.();
      }
    } else {
      previewRef.current = { kind: "solo", preset: p, start: performance.now() };
      if (viewer.controls) viewer.controls.enabled = false;
    }
  }

  // ---- 序列编排 ----
  function addToSeq() {
    if (preset === "free") return;
    setSeq((s) => [...s, { p: preset, k: ++uid.current }]);
  }
  function removeFromSeq(i: number) {
    setSeq((s) => s.filter((_, idx) => idx !== i));
    setSeqPlaying(false);
  }
  function toggleSeqPreview() {
    const viewer = viewerRef.current;
    if (!viewer?.camera || seq.length === 0) return;
    if (seqPlaying) {
      setSeqPlaying(false);
      selectPreset("free");
      return;
    }
    setSeqPlaying(true);
    setPreset("free");
    if (viewer.controls) viewer.controls.enabled = false;
    previewRef.current = {
      kind: "seq",
      tl: buildTimeline(seqIds, true),
      start: performance.now(),
    };
  }

  const exportSeq: Preset[] =
    seq.length > 0 ? seqIds : preset !== "free" ? [preset] : [];
  const exportTotal = exportSeq.length
    ? Math.round(buildTimeline(exportSeq, true).total)
    : 0;

  // ---- 录制导出 ----
  async function record() {
    const viewer = viewerRef.current;
    if (!viewer?.camera || recording || exportSeq.length === 0) return;

    const tl = buildTimeline(exportSeq, true);
    const fps = 30;
    const total = Math.round(tl.total * fps);

    const canvas: HTMLCanvasElement =
      rendererRef.current?.domElement || viewer.renderer.domElement;
    // 导出分辨率固定（高/均衡档 1920 宽，流畅档 1280 宽），与实时预览降没降档无关：
    // 录制期间临时按目标宽度离屏渲染，结束后恢复。
    const profile = profileRef.current || perfProfile();
    const cssW = canvas.clientWidth || mountRef.current?.clientWidth || 960;
    const cssH = canvas.clientHeight || mountRef.current?.clientHeight || 600;
    const w = Math.floor(profile.exportWidth / 2) * 2;
    const h = Math.floor((profile.exportWidth * cssH / cssW) / 2) * 2;
    const liveRatio = governorRef.current?.ratio ?? profile.maxPixelRatio;
    rendererRef.current?.setPixelRatio(profile.exportWidth / cssW);
    rendererRef.current?.setSize(cssW, cssH);

    const area = w * h;
    let codec = "avc1.42001f";
    if (area > 2_097_152) codec = "avc1.420033";
    else if (area > 921_600) codec = "avc1.420028";

    setRecording(true);
    setRecProgress(0);
    recordingRef.current = true;
    let encoder: VideoEncoder | null = null;
    let encodeError: Error | null = null;

    try {
      const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: w, height: h, frameRate: fps },
        fastStart: "in-memory",
      });
      // 优先用显卡编码；不支持时再退回默认（可能是软件编码，慢一些）
      const base = { codec, width: w, height: h, bitrate: profile.exportBitrate, framerate: fps };
      let config: VideoEncoderConfig = { ...base, hardwareAcceleration: "prefer-hardware" };
      if (!(await VideoEncoder.isConfigSupported(config)).supported) config = base;
      if (!(await VideoEncoder.isConfigSupported(config)).supported) {
        throw new Error("当前设备不支持此尺寸的 H.264 编码，请缩小窗口后重试。");
      }
      encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { encodeError = e; },
      });
      encoder.configure(config);

      const cam = viewer.camera;
      // 不等屏幕刷新：直接驱动查看器更新并绘制这一帧。排序在后台线程进行，
      // 只有正在排序时才等它（最多 250ms），导出速度不再受显示器刷新率限制。
      const drawFrame = async () => {
        viewer.update();
        if (viewer.sortRunning && viewer.sortPromise) {
          await Promise.race([viewer.sortPromise, new Promise((r) => setTimeout(r, 250))]);
        }
        viewer.render();
      };
      // 编码积压时只等队列降下来，不整体 flush（flush 会让整条流水线停住）
      const drainTo = (limit: number) => new Promise<void>((resolve) => {
        if (!encoder || encoder.encodeQueueSize <= limit) return resolve();
        const check = () => { if (!encoder || encoder.encodeQueueSize <= limit) { encoder?.removeEventListener("dequeue", check); resolve(); } };
        encoder.addEventListener("dequeue", check);
      });
      const direct = w === canvas.width && h === canvas.height;

      for (let i = 0; i < total; i++) {
        if (!recordingRef.current || viewerRef.current !== viewer) return;
        if (encodeError) throw encodeError;
        const { pose, splat } = sampleTimeline(tl, i / fps);
        applyPose(cam, pose);
        setSplat(splat);
        await drawFrame();
        if (!recordingRef.current || viewerRef.current !== viewer) return;

        const timing = { timestamp: Math.round((i / fps) * 1_000_000), duration: Math.round(1_000_000 / fps) };
        const bitmap = direct ? null : await createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        const frame = new VideoFrame(bitmap || canvas, timing);
        encoder.encode(frame, { keyFrame: i % fps === 0 });
        frame.close();
        bitmap?.close();
        const percent = Math.round(((i + 1) / total) * 100);
        if (percent !== Math.round((i / total) * 100)) setRecProgress(percent);
        await drainTo(6);
        // 偶尔让出主线程，进度条和界面才能刷新
        if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0));
      }

      await encoder.flush();
      muxer.finalize();

      const names = exportSeq.map(nameOf);
      const label = names.length > 3 ? `${names.slice(0, 3).join("")}等${names.length}段` : names.join("");
      const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
      // 客户端：直接存进这件作品的本地文件夹并打开它；失败再走普通下载
      if (isDesktopApp()) {
        const folder = jobId ? workFolder(jobId) : "exports";
        if (await saveWorkFile(folder, `video_${Date.now()}.mp4`, blob)) { void openWorksFolder(folder); return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Pixel Reconstruction_${label}_${Date.now()}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) {
      setErr("录制失败：" + (e?.message || e));
    } finally {
      if (encoder && encoder.state !== "closed") encoder.close();
      recordingRef.current = false;
      applyPixelRatio(liveRatio);
      setSplat(1);
      selectPreset(exportSeq[exportSeq.length - 1] ?? "free");
      setRecording(false);
    }
  }

  return (
    <div className="screen" data-scene-ready={ready || undefined} data-scene-points={sceneInfo.points || undefined} data-scene-bytes={sceneInfo.bytes || undefined}>
      <div className="stage">
        <div ref={mountRef} className="viewer-mount" />
        {ready && !recording && <div className="fly-hint" aria-hidden="true"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动 · <kbd>空格</kbd> 上升 · <kbd>Shift</kbd> 下降 · 拖动转向</div>}
        {!ready && posterUrl && <img src={posterUrl} alt="原图预览，三维场景正在载入" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#121413', pointerEvents: 'none' }} />}
        {!ready && !err && !preparationError && (
          <div className="processing" role="status" style={{ color: '#f5f2e9', background: 'linear-gradient(180deg,rgba(18,20,19,.08) 8%,rgba(18,20,19,.9) 100%)', justifyContent: 'flex-end', gap: 8, padding: '18px 14px', boxSizing: 'border-box' }}>
            <div className="stagename" style={{ color: 'inherit', fontSize: 16 }}>{!plyUrl ? '正在获取场景文件' : loadPhase === 'download' ? (download.phase === 'unpack' ? '无损还原场景数据' : stalled ? '网络暂时没有进展' : download.retry ? '正在恢复下载' : previewQuality === 'mobile' ? '打开历史离线预览' : '载入完整场景') : '解析与排序'}</div>
            <div className="bar" role="progressbar" aria-label="场景加载" aria-valuenow={loadPhase === 'download' && download.total ? Math.round(download.received / download.total * 100) : undefined}>
              <i style={loadPhase === 'download' && download.total ? { width: '100%', animation: 'none', transformOrigin: 'left', transform: `scaleX(${download.received / download.total})`, background: '#c4cc9a' } : { background: '#c4cc9a' }} />
            </div>
            <div className="note" style={{ color: '#e1e3da' }}>{!plyUrl ? '正在获取这件作品的访问凭证。' : loadPhase === 'download'
              ? `${(download.received / 1048576).toFixed(1)}${download.total ? ' / ' + (download.total / 1048576).toFixed(1) : ''} MB · ${loadSeconds} 秒${download.received ? '' : ' · 等待文件服务'}`
              : `下载完成，正在为当前设备准备画面 · ${loadSeconds} 秒`}</div>
            <div className="note" style={{ color: '#c8cdbf', marginTop: 8 }}>{stalled ? '已收到的数据会暂时保留；网络超时后自动尝试续传。' : previewQuality === 'mobile' ? '当前为以前保存的轻量缓存，联网后可恢复完整场景。' : '保留完整点数与细节 · 保存后再次打开无需下载'}</div>
            {stalled && <button className="key active" style={{ marginTop: 12 }} onClick={() => { restartDownloadRef.current = true; setAttempt(value => value + 1); }}>从头重新下载</button>}
          </div>
        )}
        {(err || preparationError) && (
          <div className="processing" role="alert" style={{ color: '#f5f2e9', background: 'rgba(18,20,19,.72)', gap: 20, padding: 28 }}>
            <div className="stagename" style={{ color: 'inherit' }}>场景未能载入</div>
            <div className="note" style={{ color: '#c0c2b9', maxWidth: 460 }}>{preparationError || err}</div>
            <button className="key active" onClick={() => { if (preparationError) onPreparationRetry?.(); else { restartDownloadRef.current = !loadedAssetRef.current; setAttempt(value => value + 1); } }}>重新加载场景</button>
          </div>
        )}

        {recording && (
          <div className="rec-overlay">
            <div className="stagename">导 出 中</div>
            <div className="clock">{recProgress}%</div>
            <div className="bar" style={{ width: 230 }}>
              <i style={{ width: `${recProgress}%`, animation: "none", transform: "none" }} />
            </div>
            <div className="note">粒子开场 + {exportSeq.map(nameOf).join(" → ")}，正在你的显卡上逐帧编码，请勿切走标签页。</div>
          </div>
        )}
      </div>

      {/* ===== 运镜工作台：运镜选择 / 序列编排 / 导出 ===== */}
      <div className="rig">
        {/* 运镜选择 */}
        <div className="rig-card">
          <div className="rig-card-title">运镜 <span>选一种，预览即所见</span>
            <label className="perf-choice" title={perfInfo ? `当前渲染倍率 ${perfInfo.ratio.toFixed(2)}×` : undefined}>画质
              <select value={perfChoice} onChange={(e) => choosePerf(e.target.value as PerfChoice)} disabled={recording}>
                <option value="auto">自动{perfInfo && perfChoice === "auto" ? `（${{ high: "高", mid: "均衡", low: "流畅" }[perfInfo.tier as "high"] || ""}）` : ""}</option>
                <option value="high">高 · 超采样，导出 1920 宽</option>
                <option value="mid">均衡 · 导出 1920 宽</option>
                <option value="low">流畅 · 导出 1280 宽</option>
              </select>
            </label>
          </div>
          <div className="rig-deck">
            <button
              className={`key ${preset === "free" && !seqPlaying ? "active" : ""}`}
              onClick={() => selectPreset("free")}
              disabled={!ready || recording}
            >
              自由
            </button>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`key ${preset === p.id ? "active" : ""}`}
                onClick={() => selectPreset(p.id)}
                disabled={!ready || recording}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* 序列 + 导出：两栏 */}
        <div className="rig-grid">
          <div className="rig-card">
            <div className="rig-card-title">运镜序列 <span>把多段运镜串成一条时间轴</span></div>
            <div className="seq-area" ref={seqRef}>
              {seq.length === 0 && <span className="seq-empty">还没有片段</span>}
              {seq.map((it, i) => (
                <span className="chip" key={it.k} data-flip={`c${it.k}`}>
                  <span className="ord">{i + 1}</span>
                  {nameOf(it.p)}
                  <button onClick={() => removeFromSeq(i)} disabled={recording} aria-label="移除">×</button>
                </span>
              ))}
              <button
                data-flip="__add"
                className="key ghost add"
                onClick={addToSeq}
                disabled={!ready || recording || preset === "free"}
                title="把当前选中的运镜追加到序列末尾"
              >
                ＋ 加入当前
              </button>
            </div>
            <div className="seq-actions">
              {seq.length > 0 ? (
                <>
                  <button className="key ghost" onClick={toggleSeqPreview} disabled={!ready || recording}>
                    {seqPlaying ? "■ 停止预览" : "▶ 预览序列"}
                  </button>
                  <button className="key ghost" onClick={() => { setSeq([]); setSeqPlaying(false); }} disabled={recording}>
                    清空
                  </button>
                </>
              ) : <span className="seq-hint">选一个运镜，点「加入当前」开始编排</span>}
              {exportSeq.length > 0 && <span className="total">总长 ≈ {exportTotal}s</span>}
            </div>
          </div>

          <div className="rig-card export-card">
            <div className="rig-card-title">导出</div>
            <div className="export-desc">粒子凝聚开场 + 你编排的运镜序列，在本机显卡上逐帧编码为 mp4。</div>
            <button
              className="key primary big prog"
              onClick={record}
              disabled={!ready || recording || exportSeq.length === 0 || !canRecord}
              title={
                !canRecord ? "当前浏览器不支持 WebCodecs，请用最新版 Chrome/Edge"
                : exportSeq.length === 0 ? "先选一个运镜，或编排一条序列"
                : "粒子开场 + 序列运镜，导出为 mp4"
              }
            >
              {/* 录制时进度直接填进按钮本体：状态留在你按下去的地方 */}
              {recording && (
                <span className="prog-fill" aria-hidden="true"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, recProgress / 100))})` }} />
              )}
              <span className="prog-label">{recording ? `导出中… ${recProgress}%` : "⏺ 导出 mp4"}</span>
            </button>
            {!canRecord
              ? <div className="rig-warn">当前浏览器不支持 WebCodecs，请用最新版 Chrome / Edge 导出</div>
              : exportSeq.length === 0
                ? <div className="export-hint">先选一个运镜，或编排一条序列</div>
                : <div className="export-hint">将导出：{exportSeq.map(nameOf).join(" → ")}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

