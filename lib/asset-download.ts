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

// ---------- parallel ranged download ----------
// A single long-haul connection to the file server (US) swings between ~0.5 and ~2 MB/s from
// China; several ranged connections hold near the top of that range (measured in Edge: one
// connection 14–52 s, four connections 13–17 s for the same 26 MB). Cross-origin, Beam does not
// expose Content-Range or ETag, so the plan relies only on what a browser can always read: the
// status, Content-Type and Content-Length. Any surprise falls back to the sequential path below.
// Only for direct cross-origin downloads (the Windows client talks to Beam directly). Through the
// site's same-origin relay the relay hop is the limit (~2.2 MB/s either way), and there the
// sequential path can resume from a validated offset, which cross-origin it cannot.
function parallelWorthwhile(url: string) {
  if (typeof location === 'undefined' || typeof ReadableStream === 'undefined' || !/^https:/i.test(url)) return false;
  try { return new URL(url).origin !== location.origin; } catch { return false; }
}
const PARALLEL_WORKERS = 4;
const CHUNK = 2 * 1048576;
const CHUNK_ATTEMPTS = 3;
class NoParallel extends Error {}

async function readBody(response: Response, signal: AbortSignal, limit: number, onBytes: (count: number) => void): Promise<ArrayBuffer[]> {
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = await withSignal(response.arrayBuffer(), signal);
    onBytes(whole.byteLength);
    return [whole];
  }
  const parts: ArrayBuffer[] = [];
  let count = 0;
  try {
    while (count < limit) {
      const next = await withSignal(reader.read(), signal);
      if (next.done) break;
      const value = next.value.byteLength > limit - count ? next.value.subarray(0, limit - count) : next.value;
      parts.push(new Uint8Array(value).buffer);
      count += value.byteLength;
      onBytes(value.byteLength);
    }
  } finally { void reader.cancel().catch(() => {}); }
  return parts;
}

async function parallelDownload(startUrl: string, packed: boolean, options: Options, signal: AbortSignal, update: (progress: DownloadProgress) => void): Promise<{ blob: Blob; type: string; url: string }> {
  let url = startUrl, renewing: Promise<string> | null = null;
  const renew = (stale: string) => {
    if (url !== stale) return Promise.resolve(url);
    if (!options.refreshUrl) return Promise.reject(new NoParallel());
    renewing ||= options.refreshUrl().then(fresh => {
      if (!fresh) throw new Error('作品访问凭证已失效，请从作品库重新打开。');
      url = fresh; return fresh;
    }).finally(() => { renewing = null; });
    return renewing;
  };
  const accept = packed ? { Accept: SCENE_TRANSFER_MIME + ', application/octet-stream' } : {};
  let received = 0, lastUpdate = 0, total = 0, type = '';
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastUpdate < 120) return;
    lastUpdate = now;
    update({ received, total, retry: 0, lossless: type === SCENE_TRANSFER_MIME });
  };

  // One request with an idle deadline; 403 renews the signed link once, 5xx and drops retry.
  const request = async (range: string | undefined, handle: (response: Response, request: AbortSignal, alive: () => void) => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortReason(signal);
      const idle = new AbortController();
      const scoped = createAbortSignal([signal, idle.signal]);
      let timer = setTimeout(() => idle.abort(new DOMException('下载没有进展', 'TimeoutError')), IDLE_TIMEOUT_MS);
      const bump = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('下载没有进展', 'TimeoutError')), IDLE_TIMEOUT_MS); };
      const used = url;
      try {
        const response = await withSignal(fetch(used, { signal: scoped.signal, headers: { ...accept, ...(range ? { Range: range } : {}) } }), scoped.signal);
        if (response.status === 403 && attempt < CHUNK_ATTEMPTS - 1) { void response.body?.cancel().catch(() => {}); await withSignal(renew(used), signal); continue; }
        if ([502, 503, 504].includes(response.status)) { void response.body?.cancel().catch(() => {}); throw new TypeError('temporary'); }
        bump();
        await handle(response, scoped.signal, bump);
        return;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof NoParallel || attempt >= CHUNK_ATTEMPTS - 1) throw error;
        await retryDelay(700 * (attempt + 1), signal);
      } finally { clearTimeout(timer); scoped.dispose(); }
    }
  };

  // The head request: a plain GET tells the total size and type; it keeps only the first chunk.
  const chunks: ArrayBuffer[][] = [];
  await request(undefined, async (response, scoped, alive) => {
    if (response.status !== 200) throw new NoParallel();
    type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (/text\/html|application\/json/.test(type)) throw new NoParallel();
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0) throw new NoParallel();
    total = length;
    received = 0;
    // Small files are not worth splitting: read them whole on this connection.
    const keep = total <= CHUNK * 2 ? total : CHUNK;
    chunks[0] = await readBody(response, scoped, keep, count => { received += count; alive(); report(); });
    const got = chunks[0].reduce((sum, part) => sum + part.byteLength, 0);
    if (got !== keep) throw new NoParallel();
  });
  report(true);
  if (total > CHUNK * 2) {
    const count = Math.ceil(total / CHUNK);
    let next = 1;
    const worker = async () => {
      while (next < count) {
        const index = next++;
        const start = index * CHUNK, end = Math.min(total, start + CHUNK);
        let partial = 0;
        await request(`bytes=${start}-${end - 1}`, async (response, scoped, alive) => {
          received -= partial; partial = 0;
          if (response.status !== 206) throw new NoParallel();
          const incoming = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (incoming !== type) throw new NoParallel();
          const parts = await readBody(response, scoped, end - start, bytes => { partial += bytes; received += bytes; alive(); report(); });
          if (partial !== end - start) throw new TypeError('short chunk');
          chunks[index] = parts;
        }).catch(error => { received -= partial; throw error; });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_WORKERS, count - 1) }, worker));
  }
  const blob = new Blob(chunks.flat(), { type });
  if (blob.size !== total) throw new NoParallel();
  received = total; report(true);
  return { blob, type, url };
}

async function transferAsset(url: string, options: Options, entry: Transfer, update: (progress: DownloadProgress) => void): Promise<Blob> {
  const logical = createAbortSignal([entry.controller.signal], TRANSFER_TIMEOUT_MS);
  let currentUrl = url;
  let packed = typeof DecompressionStream !== 'undefined' && /^https?:/i.test(url) && /\.splat(?:\?|$)/i.test(url);
  if (parallelWorthwhile(url)) {
    try {
      const fast = await parallelDownload(url, packed, options, logical.signal, update);
      currentUrl = fast.url;
      if (fast.type !== SCENE_TRANSFER_MIME) { logical.dispose(); return fast.blob; }
      update({ received: fast.blob.size, total: fast.blob.size, retry: 0, lossless: true, phase: 'unpack' });
      const scene = await withSignal(unpackSceneTransfer(fast.blob, logical.signal), logical.signal).catch(() => fast.blob);
      if (scene !== fast.blob) { logical.dispose(); return scene; }
      packed = false;   // Corrupt packed data: fetch the exact original file below instead.
    } catch (error) {
      if (logical.signal.aborted) {
        logical.dispose();
        if (entry.controller.signal.aborted) throw abortReason(entry.controller.signal);
        throw new Error('场景下载已持续 10 分钟，请检查网络后重试。');
      }
      // Anything unexpected (range ignored, representation changed, repeated drops): the
      // sequential path below starts over with its own retries and resume logic.
    }
  }
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
