// 跟后端通信的所有动作。
// 后端地址优先级：界面里填的（存 localStorage）> 环境变量 > localhost:8000
const KEY = "ruhua-backend";
const DEFAULT_BASE =
  process.env.NEXT_PUBLIC_MODAL_API || "http://localhost:8000";

export type JobResult = {
  job_id: string;
  ply_file: string;
  mp4_file: string | null;
  enhanced?: boolean;
  predict_seconds?: number;
  total_seconds?: number;
};

export type StatusResp =
  | ({ status: "done" } & JobResult)
  | { status: "running" }
  | { status: "error"; message: string };

export function getBase(): string {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(KEY);
    if (saved) return saved.replace(/\/$/, "");
  }
  return DEFAULT_BASE.replace(/\/$/, "");
}

export function saveBase(url: string) {
  window.localStorage.setItem(KEY, url.trim().replace(/\/$/, ""));
}

/** 探测后端是否在线，顺便拿到对方的显卡型号 */
export async function ping(): Promise<{
  ok: boolean;
  device?: string;
  enhance?: boolean;
}> {
  try {
    const res = await fetch(`${getBase()}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    return { ok: true, device: j.device, enhance: !!j.enhance };
  } catch {
    return { ok: false };
  }
}

export async function submitPhoto(
  file: File,
  renderVideo: boolean,
  enhance: boolean
) {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("render_video", String(renderVideo));
  fd.append("enhance", String(enhance));
  const res = await fetch(`${getBase()}/generate`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(`上传失败（${res.status}）：${await res.text()}`);
  return (await res.json()) as { call_id: string; job_id: string };
}

export async function checkStatus(callId: string): Promise<StatusResp> {
  const res = await fetch(`${getBase()}/status/${callId}`);
  if (!res.ok) throw new Error(`查询状态失败（${res.status}）`);
  return res.json();
}

export async function editImage(
  jobId: string,
  prompt: string,
  padRatio = 0,
  base = "",
  history: string[] = []
) {
  const res = await fetch(`${getBase()}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id: jobId,
      prompt,
      pad_ratio: padRatio,
      base,
      history,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { image: string };
}

export async function requestRerender(jobId: string, source: string) {
  const res = await fetch(`${getBase()}/rerender`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, source }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { call_id: string };
}

export function fileUrl(jobId: string, name: string) {
  return `${getBase()}/file/${jobId}/${name}`;
}
