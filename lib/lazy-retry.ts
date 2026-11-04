// 懒加载的组件代码在断网、弱网时可能下载失败。失败后等网络恢复（online 事件）或退避后重试，
// 组件晚一点出现，而不是让整个页面报错。webpack 5 在 chunk 加载失败后会清掉记录，再次 import() 会重新请求。
// 3 分钟仍失败才抛出（例如站点刚更新、旧文件已不存在），交给 app/error.tsx 提示重新加载。
export function retryImport<T>(load: () => Promise<T>, budget = 180000): () => Promise<T> {
  return () => new Promise<T>((resolve, reject) => {
    const started = Date.now();
    let tries = 0;
    const attempt = () => load().then(resolve, error => {
      const remaining = budget - (Date.now() - started);
      if (typeof window === "undefined" || remaining <= 0) { reject(error); return; }
      tries++;
      const go = () => {
        window.removeEventListener("online", go); clearTimeout(timer);
        if (Date.now() - started >= budget) reject(error); else attempt();
      };
      const timer = setTimeout(go, Math.min(remaining, navigator.onLine === false ? 30000 : Math.min(10000, 1000 * tries)));
      window.addEventListener("online", go);
    });
    attempt();
  });
}
