"use client";

import { useEffect, useRef, useState } from "react";

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

export default function SplatViewer({ plyUrl }: { plyUrl: string }) {
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
  const [seq, setSeq] = useState<Preset[]>([]);
  const [seqPlaying, setSeqPlaying] = useState(false);
  const [err, setErr] = useState("");
  const [recording, setRecording] = useState(false);
  const [recProgress, setRecProgress] = useState(0);
  const [canRecord, setCanRecord] = useState(true);

  const nameOf = (p: Preset) => PRESETS.find((x) => x.id === p)!.name;
  const setSplat = (v: number) => {
    try { viewerRef.current?.splatMesh?.setSplatScale?.(v); } catch {}
  };

  function applyPose(cam: any, pose: Pose) {
    const THREE = threeRef.current;
    const r = pose.roll || 0;
    cam.up.set(Math.sin(r), -Math.cos(r), 0); // y 朝下 + 视轴侧倾
    cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    const lk = pose.look || [0, 0, 0];
    cam.lookAt(new THREE.Vector3(lk[0], lk[1], TARGET_Z + lk[2]));
    const base = (baseFovRef.current * Math.PI) / 180;
    const fov = 2 * Math.atan(Math.tan(base / 2) * pose.fovScale);
    cam.fov = (fov * 180) / Math.PI;
    cam.updateProjectionMatrix();
  }

  useEffect(() => {
    if (typeof window !== "undefined" && typeof (window as any).VideoEncoder === "undefined") {
      setCanRecord(false);
    }
    let disposed = false;
    let raf = 0;

    (async () => {
      try {
        const [GS, THREE] = await Promise.all([
          import("@mkkellogg/gaussian-splats-3d"),
          import("three"),
        ]);
        if (disposed || !mountRef.current) return;
        threeRef.current = THREE;

        const mount = mountRef.current;
        const dpr = window.devicePixelRatio || 1;
        const W = mount.clientWidth || 960;
        const H = mount.clientHeight || 600;
        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          precision: "highp",
          preserveDrawingBuffer: true, // 录制抓帧的前提
        });
        renderer.setPixelRatio(dpr);
        renderer.setClearColor(new THREE.Color(0x04060a), 1);
        renderer.setSize(W, H);
        rendererRef.current = renderer;
        // 外部渲染器需要自己把画布挂进 DOM（库只给"亲生"渲染器挂）
        renderer.domElement.style.display = "block";
        mount.appendChild(renderer.domElement);

        const viewer = new GS.Viewer({
          rootElement: mount,
          renderer,
          cameraUp: [0, -1, 0],
          initialCameraPosition: [0, 0, 0],
          initialCameraLookAt: [0, 0, TARGET_Z],
          sharedMemoryForWorkers: false,
          selfDrivenMode: true,
        });
        viewerRef.current = viewer;

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

        await viewer.addSplatScene(plyUrl, {
          format: GS.SceneFormat.Ply,
          progressiveLoad: true,
          showLoadingUI: false,
        });
        if (disposed) return;

        viewer.start();
        viewer.controls && (viewer.controls.target = new THREE.Vector3(0, 0, TARGET_Z));
        baseFovRef.current = viewer.camera.fov;
        {
          const w = mount.clientWidth || 960;
          const h = mount.clientHeight || 600;
          renderer.setSize(w, h);
          viewer.camera.aspect = w / h;
          viewer.camera.up.set(0, -1, 0);
          viewer.camera.updateProjectionMatrix();
        }
        setReady(true);

        // 场景就绪：播放一次粒子凝聚开场
        if (viewer.controls) viewer.controls.enabled = false;
        previewRef.current = { kind: "intro", start: performance.now() };

        const introPoseTarget: Pose = { pos: [0, 0, 0], fovScale: 1 };

        const tick = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(tick);
          if (recordingRef.current) return;
          const v = viewerRef.current;
          const cam = v?.camera;
          if (!cam) return;
          const pv = previewRef.current;

          if (pv.kind === "intro") {
            const k = (now - pv.start) / 1000 / INTRO_DUR;
            if (k >= 1) {
              setSplat(1);
              applyPose(cam, introPoseTarget);
              previewRef.current = { kind: "free" };
              if (v.controls) {
                v.controls.target.set(0, 0, TARGET_Z);
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
        if (!disposed) setErr(e?.message || "查看器初始化失败");
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      try { roRef.current?.disconnect?.(); } catch {}
      try { viewerRef.current?.dispose?.(); } catch {}
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plyUrl]);

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
      viewer.camera.up.set(0, -1, 0);
      viewer.camera.updateProjectionMatrix();
      viewer.camera.position.set(0, 0, 0);
      viewer.camera.lookAt(new THREE.Vector3(0, 0, TARGET_Z));
      if (viewer.controls) {
        viewer.controls.target.set(0, 0, TARGET_Z);
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
    setSeq((s) => [...s, preset]);
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
      tl: buildTimeline(seq, true),
      start: performance.now(),
    };
  }

  const exportSeq: Preset[] =
    seq.length > 0 ? seq : preset !== "free" ? [preset] : [];
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
    let w = canvas.width;
    let h = canvas.height;
    const scale = Math.min(1, 1280 / w);
    w = Math.floor((w * scale) / 2) * 2;
    h = Math.floor((h * scale) / 2) * 2;

    const area = w * h;
    let codec = "avc1.42001f";
    if (area > 2_097_152) codec = "avc1.420033";
    else if (area > 921_600) codec = "avc1.420028";

    setRecording(true);
    setRecProgress(0);
    recordingRef.current = true;

    try {
      const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: w, height: h, frameRate: fps },
        fastStart: "in-memory",
      });
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { throw e; },
      });
      encoder.configure({ codec, width: w, height: h, bitrate: 8_000_000, framerate: fps });

      const cam = viewer.camera;
      const nextFrame = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        );

      for (let i = 0; i < total; i++) {
        const { pose, splat } = sampleTimeline(tl, i / fps);
        applyPose(cam, pose);
        setSplat(splat);
        viewer.forceRenderNextFrame?.();
        await nextFrame();

        const bitmap = await createImageBitmap(canvas, {
          resizeWidth: w, resizeHeight: h, resizeQuality: "high",
        });
        const frame = new VideoFrame(bitmap, {
          timestamp: Math.round((i / fps) * 1_000_000),
          duration: Math.round(1_000_000 / fps),
        });
        encoder.encode(frame, { keyFrame: i % fps === 0 });
        frame.close();
        bitmap.close();
        setRecProgress(Math.round(((i + 1) / total) * 100));
        if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      }

      await encoder.flush();
      muxer.finalize();

      const names = exportSeq.map(nameOf);
      const label = names.length > 3 ? `${names.slice(0, 3).join("")}等${names.length}段` : names.join("");
      const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `入画_${label}_${Date.now()}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) {
      setErr("录制失败：" + (e?.message || e));
    } finally {
      recordingRef.current = false;
      setSplat(1);
      selectPreset(exportSeq[exportSeq.length - 1] ?? "free");
      setRecording(false);
    }
  }

  return (
    <div className="screen">
      <div ref={mountRef} className="viewer-mount" />
      {!ready && !err && (
        <div className="processing">
          <div className="stagename">解 码 点 云</div>
          <div className="bar"><i /></div>
          <div className="note">.ply 可能上百兆，首次加载取决于网速，会边下边显示。</div>
        </div>
      )}
      {err && (
        <div className="processing"><div className="note">{err}</div></div>
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

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        <div className="deck">
          <span className="label">运镜</span>
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
        <div className="seq-row">
          <span className="label">序列</span>
          <button
            className="key ghost"
            onClick={addToSeq}
            disabled={!ready || recording || preset === "free"}
            title="把当前选中的运镜追加到序列末尾"
          >
            ＋ 加入当前
          </button>
          {seq.map((p, i) => (
            <span className="chip" key={`${p}-${i}`}>
              <span className="ord">{i + 1}</span>
              {nameOf(p)}
              <button onClick={() => removeFromSeq(i)} disabled={recording}>×</button>
            </span>
          ))}
          {seq.length > 0 && (
            <>
              <button className="key ghost" onClick={toggleSeqPreview} disabled={!ready || recording}>
                {seqPlaying ? "■ 停止预览" : "▶ 预览序列"}
              </button>
              <button className="key ghost" onClick={() => { setSeq([]); setSeqPlaying(false); }} disabled={recording}>
                清空
              </button>
            </>
          )}
          <div className="right">
            {exportSeq.length > 0 && <span className="total">≈ {exportTotal}s</span>}
            <button
              className="key primary"
              onClick={record}
              disabled={!ready || recording || exportSeq.length === 0 || !canRecord}
              title={
                !canRecord ? "当前浏览器不支持 WebCodecs，请用最新版 Chrome/Edge"
                : exportSeq.length === 0 ? "先选一个运镜，或编排一条序列"
                : "粒子开场 + 序列运镜，导出为 mp4"
              }
            >
              {recording ? "导出中…" : "⏺ 导出 mp4"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
