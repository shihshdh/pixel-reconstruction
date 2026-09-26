"use client";

import { isDesktopApp } from "@/lib/desktop";
import { perfProfile } from "@/lib/perf";
import { useEffect, useRef } from "react";
import { INTRO_SCENE_START } from "@/lib/intro";

import type { LandingScene } from "@/lib/landing-scenes";

export type LandingSceneStatus = "loading" | "ready" | "fallback";
/** download: bytes still arriving (percent is null when the server sends no size); process: downloaded, now parsing and building. */
export type LandingLoadProgress = { phase: "download" | "process"; percent: number | null };

// Fall back to the photograph only when loading has truly stalled. A slow but
// progressing connection keeps waiting, so it still gets the real scene.
const STALL_MS = 20000;   // connect/download: no new data for this long = stalled
const PROCESS_MS = 45000; // after download: time allowed for parsing and the first build
// gaussian-splats-3d does not export LoaderStatus; compare with its internal value.
const LOADER_PROCESSING = 1;

/** A real SHARP scene. The photograph remains visible if WebGL or its asset fails. */
export default function LandingSplat({ scene: SCENE, depth, reducedMotion, onStatus, onInteraction, onProgress }: {
  scene: LandingScene;
  depth: number;
  reducedMotion: boolean;
  onStatus: (status: LandingSceneStatus) => void;
  onInteraction?: () => void;
  onProgress?: (progress: LandingLoadProgress) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef(depth);
  const reducedRef = useRef(reducedMotion);
  const interactionRef = useRef(onInteraction);
  const progressRef = useRef(onProgress);
  depthRef.current = depth;
  reducedRef.current = reducedMotion;
  interactionRef.current = onInteraction;
  progressRef.current = onProgress;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let sceneReady = false;
    let hoverAnchor: { x: number; y: number } | null = null;
    let frame = 0;
    let viewer: any;
    let renderer: any;
    let resize: ResizeObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Watchdog: every sign of progress re-arms it; only sustained silence falls back.
    const arm = (ms: number) => { clearTimeout(timeout); timeout = setTimeout(fail, ms); };
    let reported = "";
    const report = (progress: LandingLoadProgress) => {
      // Called for every chunk; notify the UI only when the whole percent or phase changes.
      const key = progress.phase + ":" + (progress.percent === null ? "?" : Math.floor(progress.percent));
      if (key === reported || disposed) return;
      reported = key;
      progressRef.current?.(progress);
    };
    let fieldOfViewTangent = SCENE.height / (2 * SCENE.fy);
    const desired = { x: 0, y: 0 };
    const drag = { x: 0, y: 0 };
    let gesture: { id: number; x: number; y: number; baseX: number; baseY: number; touch: boolean; active: boolean } | null = null;
    const current = { x: 0, y: 0, z: 0 };
    const abort = new AbortController();
    const pointer = (event: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      if (gesture?.id === event.pointerId) {
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (gesture.touch && !gesture.active) {
          // Horizontal touch drags explore; vertical gestures continue native page scrolling.
          if (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy)) return;
          gesture.active = true;
          mount.setPointerCapture(event.pointerId);
        }
        const nextX = Math.max(-1, Math.min(1, gesture.baseX - dx / rect.width * 3));
        const nextY = gesture.touch ? gesture.baseY : Math.max(-1, Math.min(1, gesture.baseY + dy / rect.height * 2.4));
        if (sceneReady && Math.hypot(dx, dy) > 4 && Math.abs(nextX - drag.x) + Math.abs(nextY - drag.y) > .001) interactionRef.current?.();
        drag.x = nextX;
        drag.y = nextY;
        return;
      }
      if (event.pointerType !== "mouse") return;
      desired.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      desired.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      // Window-level parallax also sees controls. Only deliberate movement on
      // the scene quiets the copy; the first sample and pointer jitter do not.
      const target = event.target instanceof Element ? event.target : null;
      const overScene = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom && !target?.closest('button, a, input, [role="button"]');
      if (!sceneReady || reducedRef.current || !overScene) { hoverAnchor = null; return; }
      if (!hoverAnchor) { hoverAnchor = { x: event.clientX, y: event.clientY }; return; }
      if (Math.hypot(event.clientX - hoverAnchor.x, event.clientY - hoverAnchor.y) >= 6) {
        hoverAnchor = { x: event.clientX, y: event.clientY };
        interactionRef.current?.();
      }
    };
    const reset = () => { desired.x = 0; desired.y = 0; hoverAnchor = null; };
    const down = (event: PointerEvent) => {
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, baseX: drag.x, baseY: drag.y, touch: event.pointerType === "touch", active: event.pointerType !== "touch" };
      if (!gesture.touch) mount.setPointerCapture(event.pointerId);
      mount.style.cursor = "grabbing";
    };
    const up = (event: PointerEvent) => {
      if (gesture?.id !== event.pointerId) return;
      if (mount.hasPointerCapture(event.pointerId)) mount.releasePointerCapture(event.pointerId);
      gesture = null;
      mount.style.cursor = "grab";
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        drag.x = Math.max(-1, Math.min(1, drag.x + (event.key === "ArrowLeft" ? -.22 : .22)));
        if (sceneReady) interactionRef.current?.();
      }
      if (event.key === "Home") { drag.x = 0; drag.y = 0; }
    };
    mount.addEventListener("pointerdown", down);
    mount.addEventListener("pointerup", up);
    mount.addEventListener("pointercancel", up);
    mount.addEventListener("keydown", keys);
    window.addEventListener("pointermove", pointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);

    const fail = () => {
      clearTimeout(timeout);
      if (!disposed) {
        sceneReady = false;
        cancelAnimationFrame(frame);
        onStatus("fallback");
        viewer?.stop?.();
      }
    };

    (async () => {
      // While the opening title plays over the landing, hold the heavy work (library import, WebGL
      // context, download and parsing) until the mark has been drawn or the title hands over.
      // The poster stays underneath meanwhile, so nothing visible waits on this.
      if (document.documentElement.getAttribute("data-intro") === "play") {
        await new Promise<void>(resolve => {
          const done = () => { watcher.disconnect(); clearTimeout(timer); resolve(); };
          const watcher = new MutationObserver(() => { if (document.documentElement.getAttribute("data-intro") !== "play") done(); });
          watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-intro"] });
          const timer = setTimeout(done, Math.max(0, INTRO_SCENE_START - performance.now()));
        });
        if (disposed) return;
      }
      // The HEAD probe, library import and time to first byte are covered too.
      arm(STALL_MS);
      try {
        const navigatorInfo = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
        // 客户端里文件在本地，不必为流量省；只有低档硬件才用轻量版首页场景
        const desktopProfile = isDesktopApp() ? perfProfile() : null;
        const low = desktopProfile ? desktopProfile.tier === "low" : window.innerWidth < 768 || (navigatorInfo.deviceMemory || 8) <= 4 || navigatorInfo.connection?.saveData;
        // Both .ksplat files are served with a one-year immutable cache (netlify.toml).
        // Bump v= whenever an asset changes, or returning visitors keep the old scene.
        const path = `/scene/${SCENE.id}${low ? "-lo" : ""}.ksplat?v=${SCENE.version}`;
        // Check availability before allocating a GPU context. Missing assets must not imply 3D.
        const asset = await fetch(path, { method: "HEAD", signal: abort.signal });
        if (!asset.ok) throw new Error("Scene unavailable");
        const [GS, THREE] = await Promise.all([import("@mkkellogg/gaussian-splats-3d"), import("three")]);
        if (disposed) return;
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: isDesktopApp() ? "high-performance" : "low-power" });
        renderer.setPixelRatio(desktopProfile ? desktopProfile.maxPixelRatio : Math.min(window.devicePixelRatio || 1, low ? 1.25 : 1.5));
        renderer.setClearColor(0x171710, 1);
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        renderer.domElement.setAttribute("aria-label", "由照片生成的三维高斯场景");
        renderer.domElement.addEventListener("webglcontextlost", fail);
        mount.appendChild(renderer.domElement);
        viewer = new GS.Viewer({
          rootElement: mount,
          renderer,
          cameraUp: [0, 1, 0],
          initialCameraPosition: [0, 0, 0],
          initialCameraLookAt: [0, 0, -SCENE.focus],
          useBuiltInControls: false,
          sharedMemoryForWorkers: false,
          selfDrivenMode: true,
          sphericalHarmonicsDegree: 0,
          gpuAcceleratedSort: false,
          integerBasedSort: false,
          renderMode: GS.RenderMode.OnChange,
        });
        const measure = () => {
          if (!viewer?.camera || disposed) return;
          const w = mount.clientWidth, h = mount.clientHeight;
          renderer.setSize(w, h);
          viewer.camera.aspect = w / h;
          // Original SHARP intrinsics of the showcase photo. Preserve more of
          // the scene at rest, reserving a small border only as the camera moves.
          fieldOfViewTangent = Math.min(SCENE.height / (2 * SCENE.fy), SCENE.width / (2 * SCENE.fy) / (w / h));
          const excursion = Math.max(Math.abs(current.x) / (.68 * SCENE.reach), Math.abs(current.y) / (.345 * SCENE.reach));
          viewer.camera.fov = 2 * Math.atan(fieldOfViewTangent * (.95 - excursion * .045)) * 180 / Math.PI;
          viewer.camera.updateProjectionMatrix();
          viewer.forceRenderNextFrame?.();
        };
        resize = new ResizeObserver(measure);
        resize.observe(mount);

        // SHARP stores OpenCV coordinates (+Y down, +Z forward). Convert once
        // to Three coordinates; retaining +Z caused reversed CPU depth sorting.
        // AbortablePromise.then does not forward the rejection callback passed
        // by await. Await its native promise so leaving mid-load is handled.
        await viewer.addSplatScene(path, {
          format: GS.SceneFormat.KSplat, showLoadingUI: false, progressiveLoad: false, rotation: [1, 0, 0, 0],
          onProgress: (percent: number | undefined, _label: string | undefined, loaderStatus: number) => {
            if (disposed) return;
            if (loaderStatus >= LOADER_PROCESSING || percent === 100) {
              arm(PROCESS_MS);
              report({ phase: "process", percent: 100 });
            } else {
              arm(STALL_MS);
              const known = typeof percent === "number" && Number.isFinite(percent);
              report({ phase: "download", percent: known ? Math.max(0, Math.min(99, percent)) : null });
            }
          },
        }).promise;
        clearTimeout(timeout);
        if (disposed) return;
        measure();
        viewer.start();
        sceneReady = true;
        onStatus("ready");
        const tick = () => {
          if (disposed) return;
          frame = requestAnimationFrame(tick);
          if (document.hidden) return;
          const reduced = reducedRef.current;
          // Single-photo reconstruction has a finite view cone. Keep the camera inside it.
          const r = SCENE.reach;
          const x = Math.max(-.68 * r, Math.min(.68 * r, (drag.x * .58 + (reduced ? 0 : -desired.x * .10)) * r));
          const y = Math.max(-.345 * r, Math.min(.345 * r, (drag.y * .30 + (reduced ? 0 : desired.y * .045)) * r));
          const z = reduced ? 0 : depthRef.current * 0.50 * r;
          if (Math.abs(x - current.x) + Math.abs(y - current.y) + Math.abs(z - current.z) < .00005) return;
          current.x += (x - current.x) * 0.065;
          current.y += (y - current.y) * 0.065;
          current.z += (z - current.z) * 0.065;
          viewer.camera.position.set(current.x, -current.y, -current.z);
          viewer.camera.up.set(0, 1, 0);
          viewer.camera.lookAt(0, 0, -SCENE.focus);
          const excursion = Math.max(Math.abs(current.x) / (.68 * r), Math.abs(current.y) / (.345 * r));
          viewer.camera.fov = 2 * Math.atan(fieldOfViewTangent * (.95 - excursion * .045)) * 180 / Math.PI;
          viewer.camera.updateProjectionMatrix();
          viewer.forceRenderNextFrame?.();
        };
        frame = requestAnimationFrame(tick);
      } catch {
        fail();
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", pointer);
      mount.removeEventListener("pointerdown", down);
      mount.removeEventListener("pointerup", up);
      mount.removeEventListener("pointercancel", up);
      mount.removeEventListener("keydown", keys);
      document.documentElement.removeEventListener("pointerleave", reset);
      resize?.disconnect();
      renderer?.domElement.removeEventListener("webglcontextlost", fail);
      // Viewer disposal is asynchronous; external renderers are owned by this component.
      Promise.resolve(viewer?.dispose?.()).catch(() => {}).finally(() => {
        renderer?.dispose();
        renderer?.domElement.remove();
      });
    };
  // 每个场景各自挂载一次（父组件用 key 区分），这里不随场景对象重建
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStatus]);

  return <div ref={mountRef} tabIndex={0} role="img" aria-label="三维场景，可拖动或按左右方向键探索，Home 键复位"
    style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "pan-y", outlineOffset: "-4px" }} />;
}
