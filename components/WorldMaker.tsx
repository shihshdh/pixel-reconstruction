'use client';

// 工作室「走进世界」：让 World Labs 的世界模型从这张照片出发，补全镜头外看不见的四周，
// 生成一个可以走进去、四处走动的三维世界（接口与任务记录见 lib/world.ts）。
// 左边的画面讲的就是这件事：照片在中间不动，四周先是一片模糊的延展，随着进度从照片向外一圈圈变清晰；
// 一条斜放的轨道绕着照片，上面的光点是将来可以走动的“你”。完成后换成世界的缩略图。
// 生成约 5 分钟，可以先离开；任务记在本机，回到这件作品时接着等。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import LiquidSegmented from "@/components/LiquidSegmented";
import { createWorld, estimateProgress, expectedSeconds, forgetWorld, stageIndex, useWorldTask, WORLD_MODELS, WORLD_STAGES, type WorldModel } from "@/lib/world";
import styles from "./WorldMaker.module.css";

const WorldWalk = dynamic(() => import("@/components/WorldWalk"), { ssr: false });

const MODEL_KEY = "ruhua-world-model";
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export default function WorldMaker({ job, poster, scene, live, title }: {
  job: { job_id: string; backend_url?: string };
  /** 原照片（或修图后的当前版本） */
  poster?: string;
  /** 这件作品自己的三维场景：演示模式走进的就是它 */
  scene?: { href: string; format: "ply" | "splat" };
  /** 后端已接入 World Labs；否则走演示模式 */
  live: boolean;
  title?: string;
}) {
  const task = useWorldTask(job.job_id);
  const [model, setModel] = useState<WorldModel>("marble-1.1");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [ratio, setRatio] = useState(16 / 10);
  // 正式生成的世界要花额度：「重新生成」要再点一次确认（不弹窗）
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (!confirmReset) return; const timer = setTimeout(() => setConfirmReset(false), 3500); return () => clearTimeout(timer); }, [confirmReset]);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { const saved = localStorage.getItem(MODEL_KEY) as WorldModel | null; if (saved && WORLD_MODELS.some(m => m.value === saved)) setModel(saved); } catch {} }, []);
  const chooseModel = (value: WorldModel) => { setModel(value); try { localStorage.setItem(MODEL_KEY, value); } catch {} };
  // 等待期间每秒走一次表（进度条、已等待时间）
  useEffect(() => {
    if (task?.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task?.status]);
  // 照片原比例：画面中间那张照片按它摆
  useEffect(() => {
    if (!poster) return;
    const img = new Image();
    img.onload = () => { if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); };
    img.src = poster;
  }, [poster]);

  const start = async () => {
    setBusy(true); setError("");
    try { await createWorld(job, { model, prompt, demo: !live }); }
    catch (e) { setError(e instanceof Error ? e.message : "没能开始生成，请稍后重试。"); }
    finally { setBusy(false); }
  };

  const pending = task?.status === "pending";
  const done = task?.status === "done" && !!task.world;
  const progress = task ? estimateProgress(task, now) : 0;
  const stage = stageIndex(progress);
  const waited = task ? Math.max(0, (now - task.started) / 1000) : 0;
  const expected = task ? expectedSeconds(task) : 0;
  const demo = task ? !!task.demo : !live;
  const visualStyle = useMemo(() => ({
    ["--poster" as string]: poster ? `url("${poster.replace(/"/g, "%22")}")` : "none",
    ["--ar" as string]: String(ratio),
    ["--p" as string]: (done ? 1 : pending ? progress : 0).toFixed(3),
  }) as CSSProperties, [poster, ratio, done, pending, progress]);

  return <>
    <div ref={cardRef} id="world-card" className={`rig-card ${styles.card}`} data-state={done ? "done" : pending ? "pending" : task?.status === "failed" ? "failed" : "idle"}>
      <div className={styles.visual} style={visualStyle} aria-hidden={!done}>
        {done && task.world?.thumbnail
          ? <img className={styles.thumb} src={task.world.thumbnail} alt="生成的世界" />
          : <>
            <span className={styles.surround} />
            <span className={styles.focus} />
            <span className={styles.photo} />
          </>}
        <svg className={styles.orbit} viewBox="0 0 200 120" preserveAspectRatio="none" aria-hidden="true">
          <ellipse cx="100" cy="64" rx="88" ry="30" />
          <ellipse className={styles.orbitRun} cx="100" cy="64" rx="88" ry="30" pathLength={100} style={{ strokeDasharray: `${(pending ? progress : done ? 1 : .18) * 100} 100` }} />
        </svg>
        <span className={styles.walker} />
        {done && <button className={styles.enter} onClick={() => setOpen(true)} data-own-motion="">走进世界 <span aria-hidden="true">→</span></button>}
        {pending && <span className={styles.percent}>{Math.round(progress * 100)}%</span>}
      </div>

      <div className={styles.body}>
        <div className={styles.eyebrow}>
          AI 世界模型 · World Labs Marble
          {demo && <span className={styles.demo} title="后端还没接入 World Labs：流程与界面和正式版一样，最后走进的是这件作品自己的三维场景。接入后自动切换为真正的世界生成。">演示模式</span>}
        </div>

        {!pending && !done && <>
          <h3 className={styles.title}>走进这张照片。</h3>
          <p className={styles.lede}>世界模型从这张照片出发，补全镜头外看不见的四周，生成一个可以走进去、四处走动的三维世界——转身、绕到树后面、走到街道尽头。</p>
          <div className={styles.controls}>
            <LiquidSegmented<WorldModel> size="md" ariaLabel="世界的大小与精细度" value={model} onChange={chooseModel} disabled={busy}
              options={WORLD_MODELS.map(m => ({ value: m.value, label: m.label, sub: m.sub, title: m.title }))} />
            <label className={styles.prompt}>
              <span>补充描述（可选）</span>
              <input value={prompt} maxLength={300} onChange={e => setPrompt(e.target.value)} disabled={busy}
                placeholder="例如：黄昏，街道一直延伸到远处的海边" onKeyDown={e => { if (e.key === "Enter" && !busy) void start(); }} />
            </label>
          </div>
          <div className={styles.actions}>
            <button className="key primary" onClick={() => void start()} disabled={busy}>{busy ? "正在提交…" : "✦ 创建场景"}</button>
            <span className="seq-hint">{task?.status === "failed" ? `上次没有成功：${task.error}` : error || (demo ? "演示：约 15 秒走完整个流程。" : "照片会发送给 World Labs 生成世界。")}</span>
          </div>
        </>}

        {pending && <>
          <h3 className={styles.title}>{WORLD_STAGES[stage].label}<span className={styles.dots} aria-hidden="true" /></h3>
          <ol className={styles.stages} aria-label="生成进度">
            {WORLD_STAGES.map((s, i) => <li key={s.label} data-state={i < stage ? "done" : i === stage ? "now" : "next"}>
              <i aria-hidden="true" /><span>{s.label}</span><small>{s.note}</small>
            </li>)}
          </ol>
          <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="世界生成进度">
            <i style={{ transform: `scaleX(${progress})` }} />
          </div>
          <div className={styles.row}>
            <span>已等待 {clock(waited)}{waited > expected * 1.4 ? " · 比平时久一些，仍在生成" : ` · 预计 ${clock(expected)}`}</span>
            <span>{task.demo ? "演示" : WORLD_MODELS.find(m => m.value === task.model)?.label}</span>
          </div>
          <p className={styles.note}>可以先去别的页面或关掉窗口，生成在云端继续；回到这件作品时会接着显示。</p>
        </>}

        {done && task.world && <>
          <h3 className={styles.title}>世界已经长好了。</h3>
          {task.world.caption && <blockquote className={styles.caption} lang={/[一-鿿]/.test(task.world.caption) ? "zh" : "en"}>{task.world.caption}</blockquote>}
          <p className={styles.lede}>{task.world.demo
            ? "演示模式：你会走进这件作品自己的场景。后端接入 World Labs 之后，这里会是从照片补全出来的完整世界。"
            : "用 W A S D 或方向键走动，按住拖动转头，Shift 奔跑；手机上用左下角的摇杆。"}</p>
          <div className={styles.actions}>
            <button className="key primary" onClick={() => setOpen(true)}>走进世界 →</button>
            {task.world.marbleUrl && <a className="key ghost" href={task.world.marbleUrl} target="_blank" rel="noreferrer">在 Marble 中打开 ↗</a>}
            <button className="key ghost" onClick={() => { if (task.world?.demo || confirmReset) { setConfirmReset(false); forgetWorld(job.job_id); } else setConfirmReset(true); }}>
              {confirmReset ? "再点一次：换掉这个世界" : "重新生成"}
            </button>
          </div>
        </>}
      </div>
    </div>
    {open && task?.world && createPortal(<WorldWalk task={task} scene={scene} poster={poster} title={title} onClose={() => setOpen(false)} />, document.body)}
  </>;
}
