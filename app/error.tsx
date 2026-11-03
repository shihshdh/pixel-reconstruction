'use client';

// 页面级兜底：组件代码长时间下载不到（断网、站点刚更新）或渲染出错时，显示可恢复的提示，
// 代替 Next 默认的 "Application error" 白屏。网络恢复后自动重试一次。
import { useEffect } from "react";

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const chunk = error?.name === "ChunkLoadError" || /Loading (CSS )?chunk|dynamically imported module/i.test(error?.message || "");
  useEffect(() => {
    console.error(error);
    const again = () => reset();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [error, reset]);
  return (
    <main role="alert" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "var(--bg, #0a0c12)", color: "var(--txt, #f2f4f8)", fontFamily: "var(--font-round, system-ui)" }}>
      <div style={{ maxWidth: 420, textAlign: "center", padding: "28px 24px", borderRadius: 28, background: "var(--glass, rgba(255,255,255,.06))", border: "1px solid var(--stroke, rgba(255,255,255,.14))" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 10px" }}>{chunk ? "页面文件没有加载完成" : "页面出现错误"}</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, opacity: .72, margin: "0 0 20px" }}>
          {chunk ? "网络中断或站点刚更新。网络恢复后会自动重试；作品库里已保存的作品不受影响。" : "已保存的作品不受影响。可以先重试，仍不行再重新加载页面。"}
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button type="button" onClick={() => reset()} style={{ padding: "10px 18px", borderRadius: 999, border: "1px solid var(--stroke, rgba(255,255,255,.14))", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" }}>重试</button>
          <button type="button" onClick={() => location.reload()} style={{ padding: "10px 18px", borderRadius: 999, border: 0, background: "var(--txt, #f2f4f8)", color: "var(--bg, #0a0c12)", font: "inherit", fontWeight: 600, cursor: "pointer" }}>重新加载页面</button>
        </div>
      </div>
    </main>
  );
}
