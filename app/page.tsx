"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkStatus,
  editImage,
  fileUrl,
  getBase,
  JobResult,
  ping,
  requestRerender,
  saveBase,
  submitPhoto,
} from "@/lib/api";

const SplatViewer = dynamic(() => import("@/components/SplatViewer"), {
  ssr: false,
});

type ChatMsg = { role: "user" | "ai"; text?: string; img?: string; ref?: string };

const AI_PRESETS: { label: string; pad: number; prompt: string }[] = [
  {
    label: "扩图 25%",
    pad: 0.25,
    prompt:
      "这张图片的中心是一张原始照片，四周边缘是模糊的待补全区域。请把四周模糊区域补全为清晰、真实的场景延伸：透视、光线、色调、季节必须与中心原图完全一致，衔接处无缝过渡；中心原图区域保持原样不要改动。照片级写实，不要出现任何文字或水印。",
  },
  {
    label: "增加细节",
    pad: 0,
    prompt:
      "在完全保持构图、内容、光线与色调不变的前提下，提升这张照片的清晰度与细节质感：纹理更锐利、噪点更少、层次更丰富。不要改变任何物体、人物与色彩风格，照片级写实。",
  },
  {
    label: "增强光影",
    pad: 0,
    prompt:
      "轻微增强这张照片的光影层次与立体感：阴影过渡更深邃、高光更通透、明暗对比更有质感，整体保持自然真实，不改变构图与内容。",
  },
  {
    label: "电影感调色",
    pad: 0,
    prompt:
      "对这张照片做轻度电影感调色：青橙色调倾向、柔和的对比度、淡淡的胶片颗粒质感，氛围高级克制。完全不改变画面内容与构图。",
  },
  {
    label: "移除杂物",
    pad: 0,
    prompt:
      "移除画面中分散注意力的无关路人、杂物与瑕疵，用与周围环境完全一致的内容自然填补，其余部分保持原样不变，照片级写实。",
  },
  {
    label: "黄金时刻",
    pad: 0,
    prompt:
      "把这张照片的光线改为日落黄金时刻：温暖的低角度阳光、拉长的柔和阴影、金色氛围感，保持构图与所有物体不变，照片级写实。",
  },
];

type Phase = "idle" | "uploading" | "processing" | "done" | "error";
type Conn = "unknown" | "checking" | "ok" | "fail";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [dragging, setDragging] = useState(false);
  const [renderVideo, setRenderVideo] = useState(false);
  const [enhanceAvail, setEnhanceAvail] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [plyV, setPlyV] = useState(0);
  const [isRerender, setIsRerender] = useState(false);
  const [baseImg, setBaseImg] = useState("");
  const [editHistory, setEditHistory] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [result, setResult] = useState<JobResult | null>(null);
  const [tab, setTab] = useState<"splat" | "video">("splat");
  const [backend, setBackend] = useState("");
  const [conn, setConn] = useState<Conn>("unknown");
  const [device, setDevice] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    pollRef.current = clockRef.current = null;
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  // 页面打开时：读取已保存的后端地址并探测一次
  useEffect(() => {
    setBackend(getBase());
    void testConnection(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function testConnection(saveFirst = true) {
    if (saveFirst && backend.trim()) saveBase(backend);
    setConn("checking");
    const r = await ping();
    if (r.ok) {
      setConn("ok");
      setDevice(r.device || "");
      setEnhanceAvail(!!r.enhance);
    } else {
      setConn("fail");
      setDevice("");
    }
  }

  function beginPolling(callId: string, rerendering: boolean) {
    setIsRerender(rerendering);
    clockRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    pollRef.current = setInterval(async () => {
      try {
        const st = await checkStatus(callId);
        if (st.status === "done") {
          stopTimers();
          setResult((prev) => (rerendering && prev ? { ...prev, ...st } : st));
          setPlyV((v) => v + 1);
          setTab(st.mp4_file ? "video" : "splat");
          setPhase("done");
          if (rerendering)
            setChat((c) => [
              ...c,
              { role: "ai", text: "✓ 已用新图重新显影，上方就是新的 3D 场景" },
            ]);
        } else if (st.status === "error") {
          stopTimers();
          setErrMsg(st.message);
          setPhase("error");
        }
      } catch {
        /* 单次轮询失败就静默重试 */
      }
    }, 2500);
  }

  async function sendEdit(display: string, prompt: string, pad: number) {
    if (!result || aiBusy) return;
    const ref = baseImg;
    setChat((c) => [...c, { role: "user", text: display, ref: ref || undefined }]);
    setAiBusy(true);
    try {
      const r = await editImage(result.job_id, prompt, pad, ref, editHistory);
      setChat((c) => [...c, { role: "ai", img: r.image }]);
      setEditHistory((h) => [...h, display]);
      setBaseImg("");
    } catch (e: any) {
      setChat((c) => [...c, { role: "ai", text: "修图失败：" + (e?.message || e) }]);
    }
    setAiBusy(false);
  }

  async function doRerender(source: string) {
    if (!result || phase !== "done") return;
    try {
      setErrMsg("");
      setElapsed(0);
      setPhase("processing");
      const { call_id } = await requestRerender(result.job_id, source);
      beginPolling(call_id, true);
    } catch (e: any) {
      setPhase("done");
      setChat((c) => [
        ...c,
        { role: "ai", text: "重新渲染失败：" + (e?.message || e) },
      ]);
    }
  }

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/") && !/\.heic$/i.test(file.name)) {
      setErrMsg("请选择一张图片（jpg / png / webp / heic）");
      setPhase("error");
      return;
    }
    setErrMsg("");
    setResult(null);
    setChat([]);
    setEditHistory([]);
    setBaseImg("");
    setElapsed(0);
    setPhase("uploading");

    try {
      const { call_id } = await submitPhoto(file, renderVideo, false);
      setPhase("processing");
      beginPolling(call_id, false);
    } catch (e: any) {
      stopTimers();
      setErrMsg(e?.message || "上传失败。后端服务在运行吗？");
      setPhase("error");
    }
  }

  function stageCopy() {
    if (isRerender) return "重新显影 · 高斯泼溅";
    if (elapsed < 4) return "胶片入仓 · 送往显卡";
    if (elapsed < 20) return "高斯泼溅 · 显影中";
    return renderVideo ? "渲染运镜轨迹" : "高斯泼溅 · 显影中";
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const busy = phase === "uploading" || phase === "processing";

  return (
    <>
      <header className="slate">
        <h1>
          入<span className="dot">·</span>画
        </h1>
        <div className="meta">
          Single photo → 3D Gaussian scene
          <br />
          Apple SHARP · 你自己的 GPU
        </div>
      </header>

      <main className="stage">
        <p className="lede">上传一张照片，显影成可以走近端详的三维场景。</p>

        <div className="backend-row">
          <span className="label">后端</span>
          <input
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            placeholder="http://localhost:8000"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && testConnection()}
          />
          <button className="key" onClick={() => testConnection()}>
            连接
          </button>
          <span className={`status ${conn}`}>
            <i />
            {conn === "ok" && (device || "已连接")}
            {conn === "fail" && "离线"}
            {conn === "checking" && "探测中"}
            {conn === "unknown" && "未连接"}
          </span>
        </div>

        {conn === "fail" && (
          <div className="error-box">
            连不上后端。请确认本机已启动服务：在装好 SHARP 的环境里运行{" "}
            <code>python backend/local_server.py</code>
            （详见项目里的《本地部署保姆级教程》），然后点"连接"重试。
          </div>
        )}

        {(phase === "idle" || phase === "error") && (
          <>
            <div
              className={`gate ${dragging ? "dragging" : ""}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
            >
              <p className="big">放入一张照片</p>
              <p className="hint">轻点选择，或拖拽到这里 · 单张 ≤ 20MB</p>
              <input
                ref={fileInput}
                type="file"
                accept="image/*,.heic"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
            </div>

            <label className="option-row">
              <input
                type="checkbox"
                checked={renderVideo}
                onChange={(e) => setRenderVideo(e.target.checked)}
              />
              同时在服务端渲染运镜视频（需后端编译 gsplat；一般不用勾，3D 视图里可直接导出 mp4）
            </label>


            {phase === "error" && <div className="error-box">{errMsg}</div>}
          </>
        )}

        {(busy || phase === "done") && (
          <div className="monitor">
            <div className="hud">
              <span className="rec">
                {busy ? (
                  <>
                    <i /> REC · 显影中
                  </>
                ) : (
                  <>SCENE · {result?.job_id}</>
                )}
              </span>
              <span>
                {phase === "done" && result?.total_seconds
                  ? `${device || "GPU"} · ${result.total_seconds}s${result.enhanced ? " · ✦ AI增强" : ""}`
                  : device || "SHARP 1536²"}
              </span>
            </div>

            {busy && (
              <div className="screen">
                <div className="processing">
                  <div className="stagename">{stageCopy()}</div>
                  <div className="clock">
                    {mm}:{ss}
                  </div>
                  <div className="bar">
                    <i />
                  </div>
                  <div className="note">
                    本机生成通常十几秒。如果是这台电脑装好后的第一次运行，
                    需要现场编译渲染内核，可能要等几分钟——只有第一次这样。
                  </div>
                </div>
              </div>
            )}

            {phase === "done" && result && (
              <>
                {tab === "splat" ? (
                  <SplatViewer
                    key={`${result.job_id}-${plyV}`}
                    plyUrl={`${fileUrl(result.job_id, result.ply_file)}?v=${plyV}`}
                  />
                ) : (
                  <div className="screen">
                    <video
                      src={fileUrl(result.job_id, result.mp4_file!)}
                      controls
                      autoPlay
                      loop
                      playsInline
                    />
                  </div>
                )}

                <div className="deck">
                  <div className="tabs">
                    <button
                      className={tab === "splat" ? "on" : ""}
                      onClick={() => setTab("splat")}
                    >
                      3D 实时
                    </button>
                    {result.mp4_file && (
                      <button
                        className={tab === "video" ? "on" : ""}
                        onClick={() => setTab("video")}
                      >
                        运镜视频
                      </button>
                    )}
                  </div>
                  <div className="right">
                    {result.mp4_file && (
                      <a
                        className="key"
                        href={fileUrl(result.job_id, result.mp4_file)}
                        download
                      >
                        下载视频
                      </a>
                    )}
                    <a
                      className="key"
                      href={fileUrl(result.job_id, result.ply_file)}
                      download
                    >
                      下载 .ply
                    </a>
                    <button
                      className="key primary"
                      onClick={() => {
                        stopTimers();
                        setPhase("idle");
                        setResult(null);
                      }}
                    >
                      再来一张
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {phase === "done" && result && enhanceAvail && (
          <section className="ai-panel">
            <div className="ai-head">
              ✦ 豆包修图
              <span>先把图改到满意，再重新显影成 3D</span>
            </div>
            <div className="chip-row">
              {AI_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="key ghost"
                  disabled={aiBusy}
                  onClick={() => sendEdit(p.label, p.prompt, p.pad)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="chat">
              <div className="bubble ai">
                <img src={fileUrl(result.job_id, "original.jpg")} alt="原图" />
                <div className="cap">
                  原图
                  <button
                    className="key ghost"
                    disabled={aiBusy}
                    onClick={() => setBaseImg("original.jpg")}
                  >
                    引用
                  </button>
                </div>
              </div>
              {chat.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="bubble user">
                    {m.ref && (
                      <span className="ref-tag">
                        引用 {m.ref === "original.jpg" ? "原图" : m.ref}
                      </span>
                    )}
                    {m.text}
                  </div>
                ) : m.img ? (
                  <div key={i} className="bubble ai">
                    <img src={fileUrl(result.job_id, m.img)} alt={m.img} />
                    <div className="cap">
                      {m.img}
                      <a className="key ghost" href={fileUrl(result.job_id, m.img)}>
                        下载
                      </a>
                      <button
                        className="key ghost"
                        disabled={aiBusy}
                        onClick={() => setBaseImg(m.img!)}
                      >
                        引用
                      </button>
                      <button
                        className="key ghost"
                        disabled={aiBusy}
                        onClick={() => doRerender(m.img!)}
                      >
                        ⟳ 重新渲染
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="bubble ai note">
                    {m.text}
                  </div>
                )
              )}
              {aiBusy && (
                <div className="bubble ai">
                  <div className="bar" style={{ width: 170 }}>
                    <i />
                  </div>
                  <div className="cap">豆包绘制中 · 约 10 秒</div>
                </div>
              )}
            </div>
            {baseImg && (
              <div className="base-pill">
                引用 {baseImg === "original.jpg" ? "原图" : baseImg} 作为下一次修改的基础
                <button onClick={() => setBaseImg("")}>×</button>
              </div>
            )}
            <div className="ai-input">
              <input
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                placeholder={'直接说想怎么改，支持接着上文说，比如：刚才太亮了，再暗一点'}
                disabled={aiBusy}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && aiInput.trim()) {
                    sendEdit(aiInput.trim(), aiInput.trim(), 0);
                    setAiInput("");
                  }
                }}
              />
              <button
                className="key primary"
                disabled={aiBusy || !aiInput.trim()}
                onClick={() => {
                  sendEdit(aiInput.trim(), aiInput.trim(), 0);
                  setAiInput("");
                }}
              >
                发送
              </button>
            </div>
          </section>
        )}

        {phase === "done" && result && !enhanceAvail && (
          <p className="footnote">
            想解锁豆包修图（扩图、加细节、调色后重新渲染 3D）？在「启动入画.bat」里填入
            ARK_API_KEY 后重启后端即可。
          </p>
        )}

        <p className="footnote">
          这个站不烧任何云端算力：页面是静态的，照片在你自己（或你指定的）
          电脑显卡上显影。运镜小知识：SHARP 是单图生成，只有原视角附近是
          "真材实料"，小幅环绕、缓推、变焦最出片；3D 视图里的「变焦」是
          希区柯克变焦——机位后撤同时焦距推近，主体不动、空间被拉扯。
        </p>
      </main>
    </>
  );
}
