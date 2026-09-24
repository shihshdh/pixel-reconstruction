// Offline behavioral checks against the actual TypeScript sources.
// No real network, browser, API credentials, GPU requests or implementation edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { gzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const checks = [];

function load(fetchMock, includeApi = false, compression = true, legacy = false, deadlineMs = 1000, environment = {}) {
  const cache = new Map();
  const context = vm.createContext({
    Blob, Response, Headers, Request, ReadableStream, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    DecompressionStream: compression ? DecompressionStream : undefined,
    AbortController, AbortSignal: legacy ? {} : AbortSignal, DOMException, Error, TypeError, URL,
    performance, console, process: { env: { NEXT_PUBLIC_BEAM_API: 'https://offline.invalid' } },
    fetch: fetchMock,
    setTimeout: (callback, delay) => {
      // Preserve asynchronous retry behavior without 900/1800ms waits; completed
      // transfer eviction must not keep this offline test process alive.
      const timer = setTimeout(callback, delay === 15000 ? 1000 : delay === 600000 ? Math.max(1000, deadlineMs * 10) : delay >= 20000 ? deadlineMs : Math.min(delay, 5));
      if (delay === 15000) timer.unref();
      return timer;
    },
    clearTimeout,
    ...environment,
  });
  function moduleFor(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} };
    cache.set(relative, module);
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: relative,
    }).outputText;
    const factory = vm.runInContext('(function(require,module,exports){\n' + compiled + '\n})', context, { filename: relative });
    factory(specifier => {
      if (specifier === 'react') return require('react');
      if (specifier.startsWith('@/lib/')) specifier = './' + specifier.slice('@/lib/'.length);
      assert.ok(['./asset-download', './scene-transfer', './abort', './asset-route', './api', './gallery-storage'].includes(specifier), 'Unexpected dependency in offline loader');
      return moduleFor('lib/' + specifier.slice(2) + '.ts');
    }, module, module.exports);
    return module.exports;
  }
  if (includeApi === 'poster') return { ...moduleFor('components/ScenePoster.tsx'), ...moduleFor('lib/gallery-storage.ts') };
  return moduleFor(includeApi === 'gallery' ? 'lib/gallery-storage.ts' : includeApi === 'abort' ? 'lib/abort.ts' : includeApi ? 'lib/api.ts' : 'lib/asset-download.ts');
}

// Minimal asynchronous IndexedDB double: exercise actual gallery policy without a browser/network.
function galleryEnvironment() {
  const stores = new Map(), storage = new Map();
  const database = {
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(names) {
      let pending = 0, completion;
      const tx = { objectStore(name) {
        const store = stores.get(name);
        const run = operation => {
          const request = {}; pending++; clearTimeout(completion);
          queueMicrotask(() => {
            try { request.result = operation(); request.onsuccess?.(); }
            catch (error) { request.error = error; tx.error = error; tx.onerror?.(); }
            if (!--pending) completion = setTimeout(() => tx.oncomplete?.(), 0);
          });
          return request;
        };
        return { get: key => run(() => structuredClone(store.get(key))), getAll: () => run(() => structuredClone([...store.values()])), put: value => run(() => { store.set(value.id, structuredClone(value)); return value.id; }), delete: key => run(() => store.delete(key)) };
      }, abort() { tx.onabort?.(); } };
      return tx;
    }, close() {},
  };
  return {
    navigator: { userAgent: 'iPhone', storage: { persist: async () => true } }, Event,
    window: { matchMedia: () => ({ matches: true }), dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = database; request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } },
  };
}

function response(status = 200, data = 'scene-binary') {
  const bytes = new TextEncoder().encode(data);
  return new Response(bytes, { status, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
}

function controlledFetch() {
  const calls = [];
  let aborts = 0;
  return {
    calls,
    get aborts() { return aborts; },
    fetch: (url, { signal }) => new Promise((resolve, reject) => {
      const call = { url, signal, resolve };
      calls.push(call);
      const aborted = () => { aborts++; reject(new DOMException('mock aborted', 'AbortError')); };
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
    }),
  };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Promise remained pending for 1000ms')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
async function test(name, run) { await run(); checks.push({ name, passed: true }); }

function packedResponse(bytes, corrupt = false) {
  const header = Buffer.alloc(20); header.write('PRSGZ001');
  header.writeUInt32LE(bytes.length, 8); header.writeUInt32LE(65536, 12); header.writeUInt32LE(1, 16);
  const rows = bytes.length / 32, shuffled = Buffer.alloc(bytes.length);
  for (let lane = 0; lane < 32; lane++) for (let row = 0; row < rows; row++) shuffled[lane * rows + row] = bytes[row * 32 + lane];
  const compressed = gzipSync(shuffled);
  if (corrupt) compressed[compressed.length - 5] ^= 255;
  const packet = Buffer.concat([header, compressed]);
  return new Response(packet, { headers: { 'content-type': 'application/vnd.pixel-reconstruction.splat+gzip', 'content-length': String(packet.length) } });
}

(async () => {
  await test('same key shares one fetch across two consumers', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch);
    const first = downloadAsset('https://offline.invalid/one', { key: 'shared' });
    const second = downloadAsset('https://offline.invalid/two', { key: 'shared' });
    assert.equal(mock.calls.length, 1);
    mock.calls[0].resolve(response());
    const [a, b] = await bounded(Promise.all([first, second]));
    assert.equal(a, b, 'Consumers should receive the shared Blob');
    assert.equal(await a.text(), 'scene-binary');
  });

  await test('one cancellation leaves the other consumer running', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch);
    const a = new AbortController(), b = new AbortController();
    const first = outcome(downloadAsset('https://offline.invalid/scene', { key: 'shared', signal: a.signal }));
    const second = outcome(downloadAsset('https://offline.invalid/scene', { key: 'shared', signal: b.signal }));
    a.abort();
    assert.equal((await bounded(first)).error.name, 'AbortError');
    assert.equal(mock.calls[0].signal.aborted, false);
    assert.equal(mock.aborts, 0);
    mock.calls[0].resolve(response());
    assert.equal(await (await bounded(second)).value.text(), 'scene-binary');
  });

  await test('all cancellations abort the underlying fetch', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch);
    const a = new AbortController(), b = new AbortController();
    const first = outcome(downloadAsset('https://offline.invalid/scene', { key: 'shared', signal: a.signal }));
    const second = outcome(downloadAsset('https://offline.invalid/scene', { key: 'shared', signal: b.signal }));
    a.abort(); b.abort();
    const result = await bounded(Promise.all([first, second]));
    assert.ok(result.every(item => item.error?.name === 'AbortError'));
    assert.equal(mock.calls[0].signal.aborted, true);
    assert.equal(mock.aborts, 1);
    assert.equal(mock.calls.length, 1);
  });

  await test('502 retries and returns the successful asset', async () => {
    let calls = 0;
    const { downloadAsset } = load(async () => response(++calls === 1 ? 502 : 200));
    const blob = await bounded(downloadAsset('https://offline.invalid/scene'));
    assert.equal(calls, 2);
    assert.equal(await blob.text(), 'scene-binary');
  });

  await test('403 refreshes the signed URL before retrying', async () => {
    const urls = [];
    let refreshes = 0;
    const { downloadAsset } = load(async url => { urls.push(url); return response(url.endsWith('expired') ? 403 : 200); });
    const blob = await bounded(downloadAsset('https://offline.invalid/expired', {
      refreshUrl: async () => { refreshes++; return 'https://offline.invalid/fresh'; },
    }));
    assert.deepEqual(urls, ['https://offline.invalid/expired', 'https://offline.invalid/fresh']);
    assert.equal(refreshes, 1);
    assert.equal(await blob.text(), 'scene-binary');
  });

  await test('API download without a grant rejects instead of hanging', async () => {
    const urls = [];
    const api = load(async url => { urls.push(url); return response(403); }, true);
    const result = await bounded(outcome(api.downloadJobFile('missing-grant', 'scene.splat', 'https://offline.invalid')));
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /凭证|无法下载/);
    assert.equal(urls.length, 3, 'An unavailable grant must stop after the bounded retry count');
    assert.ok(urls.every(url => url.includes('/file/')), 'No grant should be sent to the refresh endpoint');
  });

  await test('403 with a rejected grant refresh propagates the error', async () => {
    let calls = 0;
    const { downloadAsset } = load(async () => { calls++; return response(403); });
    const result = await bounded(outcome(downloadAsset('https://offline.invalid/expired', {
      refreshUrl: async () => { throw new Error('refresh grant rejected'); },
    })));
    assert.equal(result.error.message, 'refresh grant rejected');
    assert.equal(calls, 1);
  });

  await test('cancelled transfer can be requested again', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch);
    const controller = new AbortController();
    const cancelled = outcome(downloadAsset('https://offline.invalid/scene', { key: 'retry', signal: controller.signal }));
    controller.abort();
    assert.equal((await bounded(cancelled)).error.name, 'AbortError');
    const fresh = downloadAsset('https://offline.invalid/scene', { key: 'retry' });
    assert.equal(mock.calls.length, 2);
    mock.calls[1].resolve(response());
    assert.equal(await (await bounded(fresh)).text(), 'scene-binary');
  });
  await test('negotiated packet restores exact original bytes and shares one transfer', async () => {
    const original = Buffer.from(Array.from({ length: 32 * 17 }, (_, i) => i % 251));
    let calls = 0;
    const { downloadAsset } = load(async (url, options) => { calls++; assert.match(options.headers.Accept, /pixel-reconstruction/); return packedResponse(original); });
    const progress = [];
    const [first, second] = await bounded(Promise.all([
      downloadAsset('https://offline.invalid/file.splat', { onProgress: p => progress.push(p) }),
      downloadAsset('https://offline.invalid/file.splat'),
    ]));
    assert.equal(calls, 1); assert.equal(first, second);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), original);
    assert(progress.some(p => p.lossless && p.phase === 'unpack'));
  });
  await test('old gateway raw responses remain compatible with negotiation', async () => {
    const { downloadAsset } = load(async () => response());
    assert.equal(await (await bounded(downloadAsset('https://offline.invalid/old.splat'))).text(), 'scene-binary');
  });
  await test('browser without native decompression requests the original file', async () => {
    const { downloadAsset } = load(async (url, options) => { assert.equal(options.headers, undefined); return response(); }, false, false);
    assert.equal(await (await bounded(downloadAsset('https://offline.invalid/raw.splat'))).text(), 'scene-binary');
  });
  await test('corrupt compressed data falls back to raw within bounded attempts', async () => {
    const original = Buffer.alloc(32 * 2, 9); let calls = 0;
    const { downloadAsset } = load(async (url, options) => {
      calls++;
      if (calls === 1) return packedResponse(original, true);
      assert.equal(options.headers, undefined);
      return new Response(original, { headers: { 'content-type': 'application/octet-stream' } });
    });
    const scene = await bounded(downloadAsset('https://offline.invalid/corrupt.splat'));
    assert.equal(calls, 2); assert.deepEqual(Buffer.from(await scene.arrayBuffer()), original);
  });
  await test('missing AbortSignal.any and timeout still permits a lossless download', async () => {
    const original = Buffer.alloc(32 * 9, 17);
    const { downloadAsset } = load(async () => packedResponse(original), false, true, true);
    const blob = await bounded(downloadAsset('https://offline.invalid/legacy.splat'));
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), original);
  });
  await test('legacy browser caller cancellation preserves its reason and aborts fetch', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch, false, true, true);
    const controller = new AbortController();
    const reason = new DOMException('User closed the viewer', 'AbortError');
    const pending = outcome(downloadAsset('https://offline.invalid/legacy.splat', { signal: controller.signal }));
    controller.abort(reason);
    assert.equal((await bounded(pending)).error, reason);
    assert.equal(mock.calls[0].signal.reason, reason);
    assert.equal(mock.aborts, 1);
  });
  await test('legacy idle timeout retries within bounds and preserves the readable timeout message', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch, false, true, true, 5);
    const result = await bounded(outcome(downloadAsset('https://offline.invalid/legacy.splat')));
    assert.match(result.error.message, /连续 45 秒没有进展/);
    assert.equal(mock.calls.length, 3);
    assert.equal(mock.aborts, 3);
  });
  await test('legacy API reads work without either AbortSignal static', async () => {
    const api = load(async () => new Response(JSON.stringify({ status: 'running' })), true, true, true);
    assert.equal((await bounded(api.checkStatus('legacy-job'))).status, 'running');
  });
  await test('legacy API timeout preserves its readable timeout message', async () => {
    const mock = controlledFetch();
    const api = load(mock.fetch, true, true, true, 5);
    const result = await bounded(outcome(api.checkStatus('legacy-job')));
    assert.match(result.error.message, /等待服务响应超时/);
    assert.equal(mock.calls.length, 1);
  });
  await test('disposing merged signals removes listeners and clears the deadline', async () => {
    const { createAbortSignal } = load(async () => response(), 'abort', true, true);
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal), originalRemove = signal.removeEventListener.bind(signal);
    let added = 0, removed = 0;
    signal.addEventListener = (...args) => { added++; return originalAdd(...args); };
    signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
    const merged = createAbortSignal([signal, signal], 1);
    merged.dispose(); merged.dispose();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(added, 1); assert.equal(removed, 1);
    assert.equal(merged.signal.aborted, false);
    controller.abort();
    assert.equal(merged.signal.aborted, false);
  });
  await test('an already cancelled signal keeps its reason without waiting for a deadline', async () => {
    const { createAbortSignal } = load(async () => response(), 'abort', true, true);
    const controller = new AbortController(), waiting = new AbortController();
    const reason = new Error('Already closed'); controller.abort(reason);
    const merged = createAbortSignal([waiting.signal, controller.signal], 1);
    assert.equal(merged.signal.aborted, true);
    assert.equal(merged.reason, reason);
    assert.equal(merged.signal.reason, reason);
    assert.equal(merged.timedOut, false);
    merged.dispose();
  });
  await test('manual reconnect aborts the stalled shared transfer and starts only one replacement', async () => {
    const mock = controlledFetch();
    const { downloadAsset } = load(mock.fetch);
    const oldViewer = outcome(downloadAsset('https://offline.invalid/scene', { key: 'restart' }));
    const oldCache = outcome(downloadAsset('https://offline.invalid/scene', { key: 'restart' }));
    const fresh = downloadAsset('https://offline.invalid/scene', { key: 'restart', restart: true });
    assert.equal(mock.calls.length, 2); assert.equal(mock.aborts, 1);
    mock.calls[1].resolve(response());
    assert.equal(await (await bounded(fresh)).text(), 'scene-binary');
    assert.equal((await oldViewer).error.name, 'AbortError'); assert.equal((await oldCache).error.name, 'AbortError');
  });
  await test('mobile preview metadata requests are shared and never fetch the full model', async () => {
    const urls = [];
    const api = load(async url => { urls.push(url); return new Response(JSON.stringify({ mobile_viewer_file: 'scene_mobile.splat', file_urls: { 'scene_mobile.splat': 'https://offline.invalid/file/job/scene_mobile.splat' } })); }, true);
    const job = { job_id: 'job', job_token: 'test-grant', ply_file: 'scene.ply', viewer_file: 'scene.splat', mp4_file: null, backend_url: 'https://offline.invalid' };
    const [a, b] = await bounded(Promise.all([api.prepareMobilePreview(job), api.prepareMobilePreview(job)]));
    assert.equal(urls.length, 1); assert.ok(urls[0].endsWith('/files/job?preview=mobile'));
    assert.equal(a.mobile_viewer_file, 'scene_mobile.splat'); assert.equal(b.mobile_viewer_file, a.mobile_viewer_file);
  });
  await test('unavailable mobile preview does not silently download the full model', async () => {
    const urls = [];
    const api = load(async url => { urls.push(url); return new Response(JSON.stringify({ detail: 'mobile unavailable' }), { status: 409 }); }, true);
    const job = { job_id: 'job', job_token: 'test-grant', ply_file: 'scene.ply', viewer_file: 'scene.splat', mp4_file: null };
    const result = await bounded(outcome(api.prepareMobilePreview(job)));
    assert.match(result.error.message, /mobile unavailable/); assert.equal(urls.length, 1);
  });
  await test('historical mobile cache is offline-only; online/default saving restores full without deleting it', async () => {
    const urls = [];
    const files = { 'original.jpg': 'https://offline.invalid/file/job/original.jpg', 'scene.splat': 'https://offline.invalid/file/job/scene.splat', 'scene_mobile.splat': 'https://offline.invalid/file/job/scene_mobile.splat' };
    const gallery = load(async url => {
      urls.push(url);
      if (url.includes('/files/')) return new Response(JSON.stringify({ mobile_viewer_file: 'scene_mobile.splat', file_urls: files }));
      return response(200, url.endsWith('original.jpg') ? 'photo' : url.endsWith('_mobile.splat') ? 'mobile-scene' : 'full-scene');
    }, 'gallery', false, true, 1000, galleryEnvironment());
    const job = { job_id: 'job', job_token: 'test-grant', ply_file: 'scene.ply', viewer_file: 'scene.splat', mp4_file: 'movie.mp4', backend_url: 'https://offline.invalid', file_urls: files };
    const saved = await bounded(gallery.cacheGalleryItem(job, { quality: 'mobile' }));
    assert.equal(saved.cacheState, 'local'); assert.equal(saved.mobileReady, true); assert.equal(saved.viewerReady, false);
    assert.equal(await (await gallery.getGalleryAsset(saved.id, 'mobile')).text(), 'mobile-scene');
    assert.ok(!urls.some(url => url.endsWith('/scene.splat') || url.endsWith('.ply') || url.endsWith('.mp4')));
    const offline = await gallery.getGalleryScene(saved, false);
    assert.equal(offline.quality, 'mobile'); assert.equal(await offline.mobile.text(), 'mobile-scene');
    const online = await gallery.getGalleryScene(saved, true);
    assert.equal(online.quality, 'full'); assert.equal(online.mobile, undefined); assert.equal(online.viewer, undefined);
    const full = await bounded(gallery.cacheGalleryItem(saved));
    assert.equal(full.viewerReady, true); assert.equal(full.mobileReady, true);
    assert.equal(await (await gallery.getGalleryAsset(saved.id, 'viewer')).text(), 'full-scene');
    assert.equal(urls.filter(url => url.endsWith('/scene.splat')).length, 1);
    const requests = urls.length;
    await bounded(gallery.cacheGalleryItem(full));
    for (const isOnline of [true, false]) {
      const reopened = await gallery.getGalleryScene(full, isOnline);
      assert.equal(reopened.quality, 'full'); assert.equal(reopened.mobile, undefined);
      assert.equal(await reopened.viewer.text(), 'full-scene');
    }
    assert.equal(urls.length, requests, 'A saved full model reopens online or offline without another GET');
    await bounded(gallery.deleteGalleryItem(saved.id));
    assert.equal(await gallery.getGalleryAsset(saved.id, 'mobile'), undefined);
    assert.equal(await gallery.getGalleryAsset(saved.id, 'viewer'), undefined);
  });
  await test('a phone saves the complete model by default and never requests a light preview', async () => {
    const urls = [];
    const gallery = load(async url => { urls.push(url); return response(200, url.endsWith('original.jpg') ? 'photo' : 'all-model-points'); }, 'gallery', false, true, 1000, galleryEnvironment());
    const job = { job_id: 'phone-full', job_token: 'test-grant', ply_file: 'scene.ply', viewer_file: 'scene.splat', mobile_viewer_file: 'scene_mobile.splat', mp4_file: null, backend_url: 'https://offline.invalid' };
    const saved = await bounded(gallery.cacheGalleryItem(job));
    assert.equal(saved.viewerReady, true); assert.equal(saved.mobileReady, false); assert.equal(saved.cacheState, 'local');
    assert.equal(await (await gallery.getGalleryAsset(saved.id, 'viewer')).text(), 'all-model-points');
    assert.equal(urls.filter(url => url.endsWith('/scene.splat')).length, 1);
    assert.ok(!urls.some(url => url.includes('preview=mobile') || url.endsWith('_mobile.splat')));
  });
  await test('two rerenders in the same job request their exact mobile sources independently', async () => {
    const mock = controlledFetch();
    const api = load(mock.fetch, true);
    const sourceA = 'scene_' + 'a'.repeat(32) + '.splat', sourceB = 'scene_' + 'b'.repeat(32) + '.splat';
    const job = source => ({ job_id: 'same-job', job_token: 'test-grant', ply_file: source.replace('.splat', '.ply'), viewer_file: source, mp4_file: null });
    const old = api.prepareMobilePreview(job(sourceA)), recent = api.prepareMobilePreview(job(sourceB));
    assert.equal(mock.calls.length, 2);
    for (const call of [...mock.calls].reverse()) {
      const url = new URL(call.url), source = url.searchParams.get('source');
      assert.ok([sourceA, sourceB].includes(source));
      assert.equal(url.pathname, '/files/same-job');
      call.resolve(new Response(JSON.stringify({ mobile_viewer_file: source.replace('.splat', '_mobile.splat'), mobile_preview: { source_file: source }, file_urls: {} })));
    }
    const [a, b] = await bounded(Promise.all([old, recent]));
    assert.equal(a.mobile_viewer_file, sourceA.replace('.splat', '_mobile.splat'));
    assert.equal(b.mobile_viewer_file, sourceB.replace('.splat', '_mobile.splat'));
    assert.equal(a.viewer_file, sourceA); assert.equal(b.viewer_file, sourceB);
  });
  await test('a latest-scene response cannot replace the requested old mobile version', async () => {
    const source = 'scene_' + 'a'.repeat(32) + '.splat', other = 'scene_' + 'b'.repeat(32) + '.splat';
    let calls = 0;
    const api = load(async () => { calls++; return new Response(JSON.stringify({ mobile_viewer_file: other.replace('.splat', '_mobile.splat'), mobile_preview: { source_file: other }, file_urls: {} })); }, true);
    const result = await bounded(outcome(api.prepareMobilePreview({ job_id: 'same-job', job_token: 'test-grant', ply_file: source.replace('.splat', '.ply'), viewer_file: source, mp4_file: null })));
    assert.match(result.error.message, /版本不一致/); assert.equal(calls, 1);
  });
  await test('rerender gallery records and binaries stay separate; late preview cannot overwrite selection', async () => {
    const requests = [];
    const gallery = load(async url => { requests.push(url); return response(200, new URL(url).pathname.split('/').pop()); }, 'gallery', false, true, 1000, galleryEnvironment());
    const job = letter => ({ job_id: 'same-job', job_token: 'test-grant', ply_file: 'scene_' + letter.repeat(32) + '.ply', viewer_file: 'scene_' + letter.repeat(32) + '.splat', backend_url: 'https://offline.invalid', mp4_file: null });
    const a = await bounded(gallery.cacheGalleryItem(job('a'), { quality: 'full' }));
    const b = await bounded(gallery.cacheGalleryItem(job('b'), { quality: 'full' }));
    assert.notEqual(a.id, b.id); assert.equal((await gallery.listGallery()).length, 2);
    assert.equal(await (await gallery.getGalleryAsset(a.id, 'viewer', a.viewer_file)).text(), a.viewer_file);
    assert.equal(await (await gallery.getGalleryAsset(b.id, 'viewer', b.viewer_file)).text(), b.viewer_file);
    let selection = { ...b, gallery_id: b.id, viewer_quality: 'mobile' };
    const before = selection;
    await Promise.resolve().then(() => { if (gallery.isSameGalleryScene(selection, a)) selection = { ...selection, mobile_viewer_file: 'incorrect-old-result' }; });
    assert.equal(selection, before, 'A delayed old-version callback must leave the current selection unchanged');
    assert.equal(gallery.isSameGalleryScene(selection, b), true);
    assert.ok(requests.every(url => new URL(url).pathname.startsWith('/file/')), 'Gallery operations must not submit GPU jobs');
  });
  await test('legacy explicit gallery IDs survive while stale version assets are replaced', async () => {
    const requests = [];
    const gallery = load(async url => { requests.push(url); return response(200, new URL(url).pathname.split('/').pop()); }, 'gallery', false, true, 1000, galleryEnvironment());
    const old = { id: 'legacy-same-job-id', job_id: 'same-job', job_token: 'test-grant', ply_file: 'scene_' + 'a'.repeat(32) + '.ply', viewer_file: 'scene_' + 'a'.repeat(32) + '.splat', backend_url: 'https://offline.invalid', mp4_file: null };
    const first = await bounded(gallery.cacheGalleryItem(old, { quality: 'full' }));
    const second = await bounded(gallery.cacheGalleryItem({ ...old, ply_file: 'scene_' + 'b'.repeat(32) + '.ply', viewer_file: 'scene_' + 'b'.repeat(32) + '.splat' }, { quality: 'full' }));
    assert.equal(second.id, old.id); assert.equal((await gallery.listGallery()).length, 1);
    assert.equal(await gallery.getGalleryAsset(second.id, 'viewer', first.viewer_file), undefined);
    assert.equal(await (await gallery.getGalleryAsset(second.id, 'viewer', second.viewer_file)).text(), second.viewer_file);
    assert.equal(requests.filter(url => url.endsWith(second.viewer_file)).length, 1);
  });
  await test('studio posters share the gallery original download; cancelling one leaves the save alive', async () => {
    const originals = controlledFetch();
    const urls = [];
    const app = load((url, options) => {
      urls.push(url);
      return url.endsWith('original.jpg') ? originals.fetch(url, options) : Promise.resolve(response(200, 'complete-model'));
    }, 'poster', false, true, 1000, galleryEnvironment());
    const job = { job_id: 'poster-job', job_token: 'test-grant', ply_file: 'scene.ply', viewer_file: 'scene.splat', mobile_viewer_file: 'scene_mobile.splat', backend_url: 'https://offline.invalid', mp4_file: null };
    const cancelled = new AbortController();
    const saving = app.cacheGalleryItem(job);
    const firstPoster = outcome(app.loadScenePosterBlob(job, cancelled.signal));
    const secondPoster = app.loadScenePosterBlob(job);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(originals.calls.length, 1, 'Gallery and both poster subscribers must use one GET');
    cancelled.abort();
    assert.equal((await bounded(firstPoster)).error.name, 'AbortError');
    assert.equal(originals.calls[0].signal.aborted, false);
    originals.calls[0].resolve(response(200, 'original-photo'));
    const [saved, poster] = await bounded(Promise.all([saving, secondPoster]));
    assert.equal(saved.originalReady, true); assert.equal(saved.cacheState, 'local');
    assert.equal(await poster.text(), 'original-photo');
    assert.equal(originals.aborts, 0);
    assert.ok(!urls.some(url => url.endsWith('_mobile.splat') || url.endsWith('.ply')));
    const count = urls.length;
    assert.equal(await (await bounded(app.loadScenePosterBlob({ ...job, gallery_id: saved.id }))).text(), 'original-photo');
    assert.equal(urls.length, count, 'A cached poster must not make another remote request');
  });
  console.log(JSON.stringify({ passed: checks.length, network: 'mocked', checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
