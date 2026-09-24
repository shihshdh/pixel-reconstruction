/** Abort helpers for browsers that have AbortController but no AbortSignal statics. */
export function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason !== undefined ? signal.reason : new DOMException('操作已取消', 'AbortError');
}

export function createAbortSignal(signals: Array<AbortSignal | null | undefined>, timeoutMs?: number) {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason: unknown;
  let timedOut = false;
  const dispose = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    listeners.forEach((listener, signal) => signal.removeEventListener('abort', listener));
    listeners.clear();
  };
  const abort = (cause: unknown, timeout = false) => {
    if (controller.signal.aborted) return;
    reason = cause; timedOut = timeout;
    controller.abort(cause);
    dispose();
  };
  for (const signal of signals) {
    if (!signal || listeners.has(signal)) continue;
    if (signal.aborted) { abort(abortReason(signal)); break; }
    const listener = () => abort(abortReason(signal));
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  if (!controller.signal.aborted && timeoutMs !== undefined) {
    timer = setTimeout(() => abort(new DOMException('请求超时', 'TimeoutError'), true), Math.max(0, timeoutMs));
  }
  return { signal: controller.signal, dispose, get reason() { return reason; }, get timedOut() { return timedOut; } };
}
