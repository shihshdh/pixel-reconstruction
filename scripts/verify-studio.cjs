// Real browser/network checks only. Never submits a generation job.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const legacyAbort = process.env.LEGACY_ABORT === '1';
const legacyMobileCache = process.argv.includes('--legacy-mobile-cache');
const checkContextLoss = process.argv.includes('--context-loss');
const mobile = legacyAbort || legacyMobileCache || process.env.MOBILE === '1';
const mbps = Number(process.env.NETWORK_MBPS || 0), latency = Number(process.env.NETWORK_LATENCY || 0);
const loadTimeout = Math.min(240000, Math.max(5000, Number(process.env.LOAD_TIMEOUT_MS || 210000)));
const stem = legacyMobileCache ? 'studio-mobile-legacy-cache' : legacyAbort ? 'studio-mobile-compatible' : mobile ? 'studio-mobile' : 'studio-network-check';
const expectedRawBytes = Number(process.env.EXPECTED_RAW_BYTES || 37748736);
const minimumPoints = Number(process.env.MIN_SCENE_POINTS || 1000000);
const report = { mobile, legacyAbort, legacyMobileCache, checkContextLoss, expectedRawBytes, minimumPoints, network: { mbps: mbps || null, latencyMs: latency }, runtimeErrors: [], requests: [], downloads: [] };
const redact = value => String(value).replace(/https?:\/\/[^\s'"<>]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return '[URL]'; } });
const modelFile = file => /\.(ply|splat)$/.test(file);
const mobileFile = file => /_mobile\.splat$/.test(file);
const assetUrl = value => { try { const u = new URL(value); return /^\/(file|scene-file)\/[^/]+\/[^/]+$/.test(u.pathname) ? u : null; } catch { return null; } };

(async () => {
  assert.ok(Number.isFinite(mbps) && mbps >= 0 && Number.isFinite(latency) && latency >= 0, 'Invalid network limits');
  assert.ok(Number.isSafeInteger(expectedRawBytes) && expectedRawBytes > 0 && Number.isSafeInteger(minimumPoints) && minimumPoints > 0, 'Invalid full-scene expectations');
  const job = JSON.parse(fs.readFileSync(process.env.JOB_FILE || (fs.existsSync('artifacts/mobile-ready-job.json') ? 'artifacts/mobile-ready-job.json' : 'artifacts/secure-job.json')));
  const fullFilename = job.viewer_file || job.ply_file;
  assert.ok(fullFilename && !mobileFile(fullFilename), 'The fixture needs a full viewer or PLY file');
  // Retain historical light-model metadata even in the ordinary fresh-cache
  // case: its presence must never switch a phone away from the full model.
  job.mobile_viewer_file ||= fullFilename.replace(/\.(splat|ply)$/, '_mobile.splat');
  report.fullFilename = fullFilename;
  report.metadataContainsMobileFile = true;
  const workId = `${(job.backend_url || '').replace(/\/+$/, '')}::${job.job_id}::${job.ply_file}`;
  let mobileFixture;
  if (legacyMobileCache) {
    mobileFixture = fs.readFileSync(process.env.MOBILE_FIXTURE_FILE || 'artifacts/landing-mobile.splat');
    assert(mobileFixture.length > 0 && mobileFixture.length % 32 === 0, 'Historical preview fixture must be a real raw splat');
    const expectedHash = process.env.MOBILE_FIXTURE_SHA256 || '47b783af194f4dcca23ada657bcb6a6d4e85ac8b5f747e479813ef760cd22b77';
    const hash = createHash('sha256').update(mobileFixture).digest('hex');
    assert.equal(hash, expectedHash, 'Historical preview fixture must match the verified cloud-preview bytes');
    report.legacyFixture = { bytes: mobileFixture.length, points: mobileFixture.length / 32, sha256: hash };
  }
  const started = Date.now();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const watchdog = setTimeout(() => { report.error = 'Verification exceeded the 10-minute overall deadline'; void browser.close(); }, 600000);
  let phase = 'setup', openedAt = 0;
  let page;
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 900 }, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
    if (legacyAbort) await context.addInitScript(() => {
      Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
      Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    });
    await context.addInitScript(job => {
      localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/9/19', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
    }, job);
    page = await context.newPage(); page.setDefaultTimeout(30000);
    const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
    const networkRecords = new Map();
    cdp.on('Network.requestWillBeSent', event => {
      const u = assetUrl(event.request.url); if (!u) return;
      const record = { phase, file: u.pathname.split('/').pop(), route: u.pathname.startsWith('/scene-file/') ? 'relay' : 'direct', method: event.request.method, secondsFromClick: openedAt ? (Date.now() - openedAt) / 1000 : null, receivedBytes: 0 };
      report.requests.push(record); networkRecords.set(event.requestId, { record, clickedAt: openedAt });
    });
    cdp.on('Network.dataReceived', event => {
      const tracked = networkRecords.get(event.requestId); if (!tracked) return;
      const { record, clickedAt } = tracked;
      if (record.firstBodySecondsFromClick === undefined && event.dataLength > 0) { record.firstBodyAt = Date.now(); record.firstBodySecondsFromClick = clickedAt ? (record.firstBodyAt - clickedAt) / 1000 : null; }
      record.receivedBytes += event.dataLength;
    });
    cdp.on('Network.loadingFinished', event => {
      const tracked = networkRecords.get(event.requestId);
      if (tracked) { tracked.record.finishedSecondsFromClick = tracked.clickedAt ? (Date.now() - tracked.clickedAt) / 1000 : null; tracked.record.encodedBytes = event.encodedDataLength; }
    });
    cdp.on('Network.loadingFailed', event => { const tracked = networkRecords.get(event.requestId); if (tracked) tracked.record.error = event.errorText; });
    page.on('pageerror', error => report.runtimeErrors.push(redact(error.message)));
    // Includes direct downloads and the new same-origin relay; never log signatures.
    page.on('response', response => {
      const u = assetUrl(response.url());
      if (u && modelFile(u.pathname)) report.downloads.push({ phase, file: u.pathname.split('/').pop(), route: u.pathname.startsWith('/scene-file/') ? 'relay' : 'direct', status: response.status(), contentType: response.headers()['content-type'], bytes: Number(response.headers()['content-length']) || null, secondsFromClick: openedAt ? (Date.now() - openedAt) / 1000 : null });
    });
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    await page.getByRole('button', { name: '直接进入' }).click();
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    if (legacyMobileCache) {
      // Seed a verified historical binary directly from disk before throttling.
      // No private download or generation is needed to construct this scenario.
      report.legacyCacheSeed = await page.evaluate(({ base64, job, workId }) => new Promise((resolve, reject) => {
        const raw = atob(base64), bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const request = indexedDB.open('ruhua-gallery', 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('works')) database.createObjectStore('works', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('assets')) database.createObjectStore('assets', { keyPath: 'id' });
        };
        request.onerror = () => reject(new Error('Cannot seed historical gallery cache'));
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction(['works', 'assets'], 'readwrite');
          const item = { ...job, id: workId, title: '验收场景', date: '2026/9/19', createdAt: Date.now(), meta: 'Beam', fav: false,
            thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href,
            cacheState: 'partial', mobileReady: true, viewerReady: false, plyReady: false, originalReady: false, thumbnailReady: false, videoReady: false };
          tx.objectStore('works').put(item);
          tx.objectStore('assets').put({ id: `${workId}:mobile`, workId, kind: 'mobile', filename: job.mobile_viewer_file, blob: new Blob([bytes], { type: 'application/octet-stream' }) });
          tx.oncomplete = () => { database.close(); localStorage.setItem('ruhua-gallery-v1', JSON.stringify([item])); window.dispatchEvent(new Event('ruhua-gallery-changed')); resolve({ mobile: true, full: false, bytes: bytes.length }); };
          tx.onerror = () => { database.close(); reject(new Error('Cannot write historical gallery assets')); };
          tx.onabort = () => { database.close(); reject(new Error('Historical cache transaction aborted')); };
        };
      }), { base64: mobileFixture.toString('base64'), job, workId });
    }
    if (mbps || latency) await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency, downloadThroughput: mbps ? mbps * 1000000 / 8 : -1, uploadThroughput: mbps ? mbps * 1000000 / 8 : -1, connectionType: mobile ? 'cellular4g' : 'wifi',
    });
    await page.locator('nav').getByRole('button', { name: '作品库', exact: true }).click();

    const resetMetrics = async () => page.evaluate(() => {
      window.__studioObserver?.disconnect();
      if (window.__studioLoadListener) document.removeEventListener('load', window.__studioLoadListener, true);
      if (window.__studioClickListener) document.removeEventListener('click', window.__studioClickListener, true);
      let start = null;
      const metrics = window.__studioMetrics = { startedAt: null, sawLoading: false, posterElementMs: null, posterReadyMs: null, firstProgressMs: null, renderReadyMs: null };
      window.__studioClickListener = () => { start = performance.now(); metrics.startedAt = Date.now(); document.removeEventListener('click', window.__studioClickListener, true); };
      document.addEventListener('click', window.__studioClickListener, true);
      const inspect = () => {
        if (start === null) return;
        const stage = document.querySelector('.stage'); if (!stage) return;
        const elapsed = Math.round(performance.now() - start);
        if (stage.querySelector('[role=status]')) metrics.sawLoading = true;
        const poster = stage.querySelector('img[alt^="原图预览"]');
        const rect = poster?.getBoundingClientRect();
        if (poster && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(poster).visibility !== 'hidden') {
          if (metrics.posterElementMs === null) metrics.posterElementMs = elapsed;
          if (poster.complete && poster.naturalWidth > 0 && metrics.posterReadyMs === null) metrics.posterReadyMs = elapsed;
        }
        const amount = (stage.querySelector('[role=status]')?.textContent || '').match(/([\d.]+)(?:\s*\/\s*[\d.]+)?\s*MB/);
        if (amount && Number(amount[1]) > 0 && metrics.firstProgressMs === null) metrics.firstProgressMs = elapsed;
        const free = document.querySelector('.rig-deck button');
        if (metrics.sawLoading && free && !free.disabled && metrics.renderReadyMs === null) metrics.renderReadyMs = elapsed;
      };
      window.__studioLoadListener = inspect; document.addEventListener('load', inspect, true);
      window.__studioObserver = new MutationObserver(inspect);
      window.__studioObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const waitReady = async (timeout = loadTimeout) => {
      await page.waitForFunction(() => {
        const error = document.querySelector('.stage [role=alert]'); if (error) throw new Error(error.textContent);
        return window.__studioMetrics?.renderReadyMs != null && document.querySelector('.rig-deck button') && !document.querySelector('.rig-deck button').disabled;
      }, null, { timeout });
      const metrics = await page.evaluate(() => ({ ...window.__studioMetrics }));
      // CDP events arrive in Node; align those earlier action timestamps to the actual DOM click.
      const correction = (openedAt - metrics.startedAt) / 1000;
      for (const record of report.requests.filter(record => record.phase === phase)) {
        for (const key of ['secondsFromClick', 'firstBodySecondsFromClick', 'finishedSecondsFromClick']) if (record[key] != null) record[key] += correction;
      }
      for (const record of report.downloads.filter(record => record.phase === phase)) if (record.secondsFromClick != null) record.secondsFromClick += correction;
      for (const tracked of networkRecords.values()) if (tracked.record.phase === phase) tracked.clickedAt = metrics.startedAt;
      openedAt = metrics.startedAt;
      return metrics;
    };
    const assertFullScene = async () => {
      await page.waitForFunction(() => {
        const screen = document.querySelector('.screen');
        return Number(screen?.getAttribute('data-scene-points')) > 0 && Number(screen?.getAttribute('data-scene-bytes')) > 0;
      });
      const scene = await page.locator('.screen').evaluate(element => ({
        points: Number(element.getAttribute('data-scene-points')),
        bytes: Number(element.getAttribute('data-scene-bytes')),
      }));
      assert.equal(scene.bytes, expectedRawBytes, 'Viewer must receive the complete decoded model bytes');
      assert.ok(scene.points >= minimumPoints, `Viewer rendered ${scene.points} points instead of the full scene`);
      return scene;
    };

    phase = 'initial'; openedAt = Date.now(); await resetMetrics();
    await page.getByRole('button', { name: '打开验收场景', exact: true }).click();
    report.initial = await waitReady();
    report.initial.scene = await assertFullScene();
    report.initial.posterVisibleBeforeReady = report.initial.posterReadyMs !== null && report.initial.posterReadyMs <= report.initial.renderReadyMs;
    const initialModels = report.requests.filter(r => r.phase === 'initial' && r.method === 'GET' && modelFile(r.file));
    assert.ok(initialModels.length, 'No real model GET was observed');
    assert.ok(initialModels.every(r => !mobileFile(r.file) && r.file === fullFilename), 'Default viewing must request only the complete non-mobile model');
    report.initial.fullModelDefault = true;
    assert.ok(report.initial.posterVisibleBeforeReady, 'Original-photo loading backdrop was not visible before the model became ready');
    report.visualSettleWaitMs = 4500; // Excluded from the measured click-to-ready time.
    await page.waitForTimeout(report.visualSettleWaitMs);
    await page.screenshot({ path: mobile ? `artifacts/${stem}.png` : 'artifacts/studio-real.png', fullPage: true });
    await page.locator('.rig-deck').getByRole('button', { name: '缓推', exact: true }).click();
    await page.waitForTimeout(1000);
    if (process.argv.includes('--export')) {
      const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
      await page.getByRole('button', { name: '⏺ 导出 mp4', exact: true }).click();
      await (await downloadPromise).saveAs('artifacts/studio-export.mp4');
      report.exportBytes = fs.statSync('artifacts/studio-export.mp4').size;
    }
    await page.locator('.gallery-save-status.local').waitFor({ timeout: 30000 });

    report.cache = await page.evaluate(workId => new Promise((resolve, reject) => {
      const request = indexedDB.open('ruhua-gallery'); request.onerror = () => reject(new Error('Cannot inspect gallery cache'));
      request.onsuccess = () => {
        const database = request.result, read = database.transaction('assets', 'readonly').objectStore('assets').getAll();
        read.onsuccess = () => {
          const assets = read.result.filter(asset => asset.workId === workId);
          resolve({ mobile: assets.some(asset => asset.kind === 'mobile'), full: assets.filter(asset => asset.kind === 'viewer' || asset.kind === 'ply').map(asset => ({ kind: asset.kind, filename: asset.filename, bytes: asset.blob?.size || 0 })) });
          database.close();
        };
        read.onerror = () => { database.close(); reject(new Error('Cannot read gallery assets')); };
      };
    }), workId);
    assert.ok(report.cache.full.some(asset => asset.filename === fullFilename && asset.bytes === expectedRawBytes), 'Offline cache must contain the complete current model');
    if (legacyMobileCache) assert.ok(report.cache.mobile, 'Migrating to the full model should preserve historical preview data');

    // Recheck after settling and saving: no delayed effect may request a light
    // preview. Retries/ranges of the same full file remain valid.
    assert.ok(report.requests.filter(r => r.phase === 'initial' && r.method === 'GET' && modelFile(r.file)).every(r => !mobileFile(r.file) && r.file === fullFilename), 'A background effect requested a reduced or different model');

    if (checkContextLoss) {
      phase = 'context-loss';
      const modelGetsBeforeLoss = report.requests.filter(record => record.method === 'GET' && modelFile(record.file)).length;
      report.contextLoss = { status: 'RUNNING', modelGetsBeforeLoss };
      const support = await page.locator('.screen').evaluate(screen => {
        const canvas = screen.querySelector('.viewer-mount canvas');
        if (!(canvas instanceof HTMLCanvasElement)) return { supported: false, reason: 'No active viewer canvas' };
        // The viewer already owns this context; this retrieves it and does not
        // construct a synthetic WebGL context or dispatch a fake DOM event.
        const gl = canvas.getContext('webgl2');
        if (!gl) return { supported: false, reason: 'Active viewer has no WebGL2 context' };
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) return { supported: false, reason: 'WEBGL_lose_context is unavailable in this browser' };
        if (gl.isContextLost()) return { supported: false, reason: 'Viewer context was already lost before injection' };
        window.__studioLostCanvas = canvas;
        window.__studioObservedContextLoss = false;
        canvas.addEventListener('webglcontextlost', () => { window.__studioObservedContextLoss = true; }, { once: true });
        extension.loseContext();
        return { supported: true, extension: 'WEBGL_lose_context' };
      });
      report.contextLoss.support = support;
      if (!support.supported) {
        report.contextLoss.status = 'SKIP';
        report.contextLoss.reason = support.reason;
        console.log(JSON.stringify({ check: 'context-loss', status: 'SKIP', reason: support.reason }));
      } else {
        await page.waitForFunction(() => window.__studioObservedContextLoss === true);
        const alert = page.locator('.screen .stage [role=alert]');
        await alert.waitFor({ state: 'visible' });
        assert.match(await alert.innerText(), /三维画面被系统暂停/, 'Real WebGL loss must show the recoverable context-loss message');
        await page.screenshot({ path: `artifacts/${stem}-context-lost.png`, fullPage: true });
        openedAt = Date.now(); await resetMetrics();
        await alert.getByRole('button', { name: '重新加载场景', exact: true }).click();
        // The old alert clears in the retry effect. Do not interpret it as a new
        // loading failure while React is committing that effect.
        await alert.waitFor({ state: 'hidden' });
        report.contextLoss.recovery = await waitReady(60000);
        report.contextLoss.scene = await assertFullScene();
        assert.deepEqual(report.contextLoss.scene, report.initial.scene, 'Context retry must restore every full-scene point and byte');
        await page.waitForTimeout(350);
        const context = await page.locator('.screen').evaluate(screen => {
          const canvas = screen.querySelector('.viewer-mount canvas');
          const gl = canvas instanceof HTMLCanvasElement ? canvas.getContext('webgl2') : null;
          return { exists: !!gl, lost: gl ? gl.isContextLost() : null, replacedCanvas: canvas !== window.__studioLostCanvas };
        });
        assert(context.exists && context.lost === false, 'Recovered scene needs a live WebGL context');
        const modelGetsAfterRecovery = report.requests.filter(record => record.method === 'GET' && modelFile(record.file)).length;
        assert.equal(modelGetsAfterRecovery, modelGetsBeforeLoss, 'Context retry must reuse the retained model Blob without a new model GET');
        report.contextLoss.context = context;
        report.contextLoss.newModelGets = modelGetsAfterRecovery - modelGetsBeforeLoss;
        report.contextLoss.status = 'PASS';
        await page.screenshot({ path: `artifacts/${stem}-context-restored.png`, fullPage: true });
      }
    }

    phase = 'offline';
    const requestsBeforeReopen = report.requests.filter(r => r.method === 'GET').length;
    await context.setOffline(true);
    await page.locator('nav').getByRole('button', { name: '作品库', exact: true }).click();
    openedAt = Date.now(); await resetMetrics();
    await page.getByRole('button', { name: '打开验收场景', exact: true }).click();
    report.offline = await waitReady(60000);
    report.offline.scene = await assertFullScene();
    assert.equal(report.requests.filter(r => r.method === 'GET').length, requestsBeforeReopen, 'Offline reopen attempted a private-asset GET, including failed requests');
    report.offline.privateGets = report.requests.filter(r => r.method === 'GET').length - requestsBeforeReopen;
    assert.equal(report.offline.scene.points, report.initial.scene.points, 'Offline reopen must keep every rendered point from the full scene');
    await context.setOffline(false);
    assert.equal(report.runtimeErrors.length, 0, report.runtimeErrors.join('\n'));
    report.studio = 'rendered'; report.motion = 'push'; report.offlineReopen = true;
  } catch (error) {
    report.error ||= redact(error.message);
    report.failedPhase = phase;
    if (phase === 'context-loss' && report.contextLoss?.status === 'RUNNING') report.contextLoss.status = 'FAIL';
    if (page && !page.isClosed()) {
      report.lastUiMetrics = await page.evaluate(() => window.__studioMetrics || null).catch(() => null);
      await page.screenshot({ path: `artifacts/${stem}-failure.png`, fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(watchdog); report.elapsedSeconds = (Date.now() - started) / 1000;
    fs.writeFileSync(`artifacts/${stem}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await browser.close();
  }
})().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
