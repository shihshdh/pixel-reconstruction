import { SCENE_TRANSFER_MIME, unpackSceneTransfer } from './scene-transfer';
import { abortReason, createAbortSignal } from './abort';

export type DownloadProgress = { received: number; total: number; retry: number; phase?: 'download' | 'unpack'; lossless?: boolean };
type Options = {
  key?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  refreshUrl?: () => Promise<string>;
  restart?: boolean;
};
type Transfer = {
  promise: Promise<Blob>;
  controller: AbortController;
  listeners: Set<(progress: DownloadProgress) => void>;
  progress: DownloadProgress;
  users: number;
  done: boolean;
};
const transfers = new Map<string, Transfer>();
const IDLE_TIMEOUT_MS = 45000;
const TRANSFER_TIMEOUT_MS = 600000;
const MAX_GETS = 3;

class RetryDownload extends Error {
  constructor(message: string, readonly reset = false) { super(message); }
}

// Some fetch/stream implementations do not reject a pending read immediately
// when aborted. Bound every wait, including signed-link renewal, ourselves.
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(abortReason(signal)); };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => {
      signal.removeEventListener('abort', cancel); reject(error);
    });
  });
}

function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

function contentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const length = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(length) || length < 0) throw new RetryDownload('场景文件长度无效，正在重新连接。', true);
  return length;
}

async function transferAsset(url: string, options: Options, entry: Transfer, update: (progress: DownloadProgress) => void): Promise<Blob> {
  const logical = createAbortSignal([entry.controller.signal], TRANSFER_TIMEOUT_MS);
  let currentUrl = url;
  let packed = typeof DecompressionStream !== 'undefined' && /^https?:/i.test(url) && /\.splat(?:\?|$)/i.test(url);
  let parts: ArrayBuffer[] = [], received = 0, total: number | undefined;
  let type = '', etag: string | null = null, canResume = false;
  const reset = () => { parts = []; received = 0; total = undefined; type = ''; etag = null; canResume = false; };
  try {
    for (let attempt = 0; attempt < MAX_GETS; attempt++) {
      if (logical.signal.aborted) throw abortReason(logical.signal);
      // Never join unidentified or HTTP-decoded representations. Immutable
      // scene URLs expose a strong ETag through the same-origin file relay.
      if (received && (!canResume || (total !== undefined && received >= total))) reset();
      const offset = received;
      const idle = new AbortController();
      const request = createAbortSignal([logical.signal, idle.signal]);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleExpired = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let bodyComplete = false;
      const stopIdle = () => { if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; } };
      const progressDeadline = () => {
        stopIdle();
        idleTimer = setTimeout(() => { idleExpired = true; idle.abort(new DOMException('下载没有进展', 'TimeoutError')); }, IDLE_TIMEOUT_MS);
      };
      update({ received, total: total || 0, retry: attempt, lossless: type === SCENE_TRANSFER_MIME });
      progressDeadline();
      try {
        const headers: Record<string, string> = {};
        if (packed) headers.Accept = SCENE_TRANSFER_MIME + ', application/octet-stream';
        if (offset) headers.Range = `bytes=${offset}-`;
        response = await withSignal(fetch(currentUrl, {
          signal: request.signal,
          ...(Object.keys(headers).length ? { headers } : {}),
        }), request.signal);
        if (response.status === 403 && options.refreshUrl && attempt < MAX_GETS - 1) {
          void response.body?.cancel().catch(() => {});
          currentUrl = await withSignal(options.refreshUrl(), request.signal);
          if (!currentUrl) throw new Error('作品访问凭证已失效，请从作品库重新打开。');
          continue; // Keep the verified prefix across signed-link renewal.
        }
        if ([502, 503, 504].includes(response.status)) throw new RetryDownload(`作品下载暂时中断（${response.status}），请重试。`);
        if (response.status === 416 && offset) throw new RetryDownload('场景续传范围已变化，正在重新下载。', true);
        if (!response.ok) throw new Error(response.status === 403
          ? '作品访问凭证已失效。请从作品库重新打开，或使用已保存的本地文件。'
          : `作品下载失败（${response.status}）。请重试，已有作品不会丢失。`);

        const incomingType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        if (/text\/html|application\/json/.test(incomingType)) throw new Error('服务返回的不是场景文件，请稍后重试。');
        const incomingEtag = response.headers.get('etag');
        const encoding = (response.headers.get('content-encoding') || '').trim().toLowerCase();
        const decodedHttp = !!encoding && encoding !== 'identity';
        // Fetch decodes HTTP Content-Encoding before exposing the stream; its
        // encoded Content-Length is not a length of those decoded bytes.
        const length = decodedHttp ? undefined : contentLength(response.headers.get('content-length'));
        let expectedEnd: number | undefined;
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          const start = match ? Number(match[1]) : NaN;
          const end = match ? Number(match[2]) : NaN;
          const size = match ? Number(match[3]) : NaN;
          if (decodedHttp || ![start, end, size].every(Number.isSafeInteger) || start !== offset || end < start || end >= size
            || (length !== undefined && length !== end - start + 1)
            || (offset > 0 && ((total !== undefined && total !== size) || incomingType !== type || incomingEtag !== etag))) {
            throw new RetryDownload('场景续传校验未通过，正在重新下载完整文件。', true);
          }
          total = size;
          expectedEnd = end + 1;
        } else if (response.status === 200) {
          // A server may ignore Range or replace a representation. A complete
          // 200 response is safe only after discarding the previous prefix.
          reset();
          if (response.headers.has('content-range')) throw new RetryDownload('场景文件范围无效，正在重新下载。', true);
          total = length;
          expectedEnd = length;
        } else throw new Error(`场景下载返回了不支持的状态（${response.status}）。`);
        type = incomingType;
        etag = incomingEtag;
        canResume = !decodedHttp && !!etag && /^"[^\r\n]*"$/.test(etag);
        const lossless = type === SCENE_TRANSFER_MIME;
        let lastUpdate = 0;
        reader = response.body?.getReader();
        const append = (value: Uint8Array) => {
          if (!value.byteLength) return;
          if (expectedEnd !== undefined && value.byteLength > expectedEnd - received) {
            throw new RetryDownload('场景文件超过声明长度，正在重新下载。', true);
          }
          parts.push(new Uint8Array(value).buffer);
          received += value.byteLength;
          progressDeadline();
          const now = performance.now();
          if (now - lastUpdate > 120) { update({ received, total: total || 0, retry: attempt, lossless }); lastUpdate = now; }
        };
        if (reader) {
          while (true) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await withSignal(reader.read(), request.signal); }
            catch (error) {
              if (request.signal.aborted) throw error;
              throw new RetryDownload('场景下载连接中断，请检查网络后重试。');
            }
            if (next.done) break;
            append(next.value);
          }
        } else append(new Uint8Array(await withSignal(response.arrayBuffer(), request.signal)));
        bodyComplete = true;
        stopIdle();
        if ((expectedEnd !== undefined && received !== expectedEnd) || (total !== undefined && received !== total)) {
          throw new RetryDownload('场景文件尚未完整下载，请检查网络后重试。');
        }
        if (!received) throw new Error('场景文件为空，请重新生成。');
        const blob = new Blob(parts, { type });
        parts = []; // Release chunk references before lossless unpacking.
        update({ received, total: total || received, retry: attempt, lossless, phase: lossless ? 'unpack' : 'download' });
        if (!lossless) return blob;
        try {
          const scene = await withSignal(unpackSceneTransfer(blob, logical.signal), logical.signal);
          if (scene === blob) throw new Error('场景压缩数据格式无效。');
          return scene;
        } catch (error) {
          if (logical.signal.aborted) throw error;
          if (attempt >= MAX_GETS - 1) throw error;
          // Corrupt packets retry the exact original file, with no packed bytes
          // or byte offset carried into the different representation.
          packed = false; reset();
          continue;
        }
      } catch (error) {
        if (logical.signal.aborted) throw abortReason(logical.signal);
        const retry = idleExpired ? new RetryDownload('场景下载连续 45 秒没有进展，请检查网络后重试。')
          : error instanceof TypeError ? new RetryDownload('场景下载连接中断，请检查网络后重试。') : error;
        if (!(retry instanceof RetryDownload) || attempt >= MAX_GETS - 1) throw retry;
        if (retry.reset) reset();
      } finally {
        stopIdle();
        if (!bodyComplete) {
          if (reader) void reader.cancel().catch(() => {});
          else void response?.body?.cancel().catch(() => {});
        }
        try { reader?.releaseLock(); } catch { /* A cancelled pending read is already rejected. */ }
        request.dispose();
      }
      await retryDelay(900 * (attempt + 1), logical.signal);
    }
    throw new Error('场景暂时无法下载，请重试。');
  } catch (error) {
    if (entry.controller.signal.aborted) throw abortReason(entry.controller.signal);
    if (logical.timedOut) throw new Error('场景下载已持续 10 分钟，请检查网络后重试。');
    throw error;
  } finally { logical.dispose(); }
}

/** The viewer and offline gallery share one network transfer, including signed-link renewal. */
export function downloadAsset(url: string, options: Options = {}): Promise<Blob> {
  if (!url) return Promise.reject(new Error('找不到作品文件，请从作品库重新打开。'));
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const key = options.key || url;
  let transfer = transfers.get(key);
  if (options.restart && transfer && !transfer.done) {
    transfer.controller.abort(new DOMException('已重新连接下载', 'AbortError'));
    transfers.delete(key);
    transfer = undefined;
  }
  if (!transfer || transfer.controller.signal.aborted) {
    const entry: Transfer = { promise: Promise.resolve(new Blob()), controller: new AbortController(), listeners: new Set(), progress: { received: 0, total: 0, retry: 0 }, users: 0, done: false };
    transfer = entry;
    transfers.set(key, entry);
    const update = (progress: DownloadProgress) => {
      entry.progress = progress;
      entry.listeners.forEach(listener => listener(progress));
    };
    entry.promise = transferAsset(url, options, entry, update);
    entry.promise.then(() => {
      entry.done = true;
      // Short handoff window: metadata/thumbnail storage can finish before requesting the same scene.
      setTimeout(() => { if (transfers.get(key) === entry) transfers.delete(key); }, 15000);
    }, () => { entry.done = true; if (transfers.get(key) === entry) transfers.delete(key); });
  }
  const entry = transfer;
  entry.users++;
  if (options.onProgress) { entry.listeners.add(options.onProgress); options.onProgress(entry.progress); }
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (reason?: unknown) => {
      if (finished) return false;
      finished = true;
      options.signal?.removeEventListener('abort', cancel);
      if (options.onProgress) entry.listeners.delete(options.onProgress);
      entry.users--;
      if (!entry.users && !entry.done) entry.controller.abort(reason);
      return true;
    };
    const cancel = () => { const reason = abortReason(options.signal); if (finish(reason)) reject(reason); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    entry.promise.then(blob => { if (finish()) resolve(blob); }, error => { if (finish()) reject(error); });
  });
}
