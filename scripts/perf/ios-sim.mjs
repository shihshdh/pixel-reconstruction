import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Both drivers run the same scenarios. No device/GPU spoofing; WebKit is a logic check only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (key, fallback) => { const n = process.argv.indexOf(key); return n < 0 ? fallback : process.argv[n + 1]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.spz': 'application/octet-stream' };

// Mount the harness outside public/. In URL mode proxy only the tested site's engine bundle.
function serve(port, site) {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (site && pathname === '/world/engine.js') {
          const upstream = await fetch(new URL('/world/engine.js', site));
          if (!upstream.ok) throw new Error(`engine HTTP ${upstream.status}`);
          res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(Buffer.from(await upstream.arrayBuffer())); return;
        }
        const base = pathname === '/__perf/world-test.html' ? path.join(root, 'scripts/perf/ios') : path.join(root, 'out');
        const relative = pathname === '/__perf/world-test.html' ? 'world-test.html' : pathname.replace(/^\/+/, '') || 'index.html';
        let filename = path.resolve(base, relative);
        if (!filename.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
        if ((await fs.stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
        res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(filename));
      } catch (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(String(error)); }
    });
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

function instrument() {
  if (window.__iosPerf) return;
  const counters = new Map(), wrapped = new WeakSet(), errors = [];
  let rafRequests = 0, rafCallbacks = 0, intervals = [], tasks = [], started, previous;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const label = c => String(c.getAttribute('aria-label') || c.className || c.parentElement?.className || 'canvas').slice(0, 100);
  const entry = c => { if (!counters.has(c)) counters.set(c, { frames: 0, draws: 0, pixels: 0, last: null }); return counters.get(c); };
  function wrap(gl, canvas) {
    if (!gl || wrapped.has(gl)) return;
    wrapped.add(gl); entry(canvas);
    function count() {
      const s = entry(canvas), t = document.timeline.currentTime;
      s.draws++;
      if (s.last !== t) { s.last = t; s.frames++; s.pixels += canvas.width * canvas.height; }
    }
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = gl[name];
      if (typeof original === 'function') gl[name] = function (...args) { count(); return original.apply(this, args); };
    }
    const ext = gl.getExtension('ANGLE_instanced_arrays');
    if (ext) for (const name of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) {
      const original = ext[name]; ext[name] = function (...args) { count(); return original.apply(this, args); };
    }
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const context = getContext.call(this, type, ...args);
    if (/webgl/.test(type)) wrap(context, this);
    return context;
  };
  const scan = () => document.querySelectorAll('canvas').forEach(c => {
    entry(c);
    try { wrap(c.getContext('webgl2') || c.getContext('webgl'), c); } catch {}
  });
  scan();
  const observer = new MutationObserver(scan); observer.observe(document.documentElement, { childList: true, subtree: true });
  window.requestAnimationFrame = callback => { rafRequests++; return nativeRaf(t => { rafCallbacks++; callback(t); }); };
  const sample = t => { if (previous !== undefined) intervals.push(t - previous); previous = t; nativeRaf(sample); };
  nativeRaf(sample); // Excluded from application rAF counts.
  const longtaskSupported = !!window.PerformanceObserver?.supportedEntryTypes?.includes('longtask');
  if (longtaskSupported) new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask' });
  addEventListener('error', e => errors.push({ type: 'error', message: e.message || `Resource failed: ${e.target?.src || e.target?.href || e.target?.tagName}` }), true);
  addEventListener('unhandledrejection', e => errors.push({ type: 'rejection', message: String(e.reason?.stack || e.reason) }));
  const quantile = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))] : null;
  window.__iosPerf = {
    reset() { scan(); for (const s of counters.values()) Object.assign(s, { frames: 0, draws: 0, pixels: 0, last: null }); rafRequests = rafCallbacks = 0; intervals = []; tasks = []; previous = undefined; started = performance.now(); },
    snapshot() {
      const seconds = (performance.now() - started) / 1000, sorted = [...intervals].sort((a, b) => a - b);
      const canvases = [...counters].map(([c, s]) => ({ label: label(c), width: c.width, height: c.height, attached: c.isConnected,
        visible: c.isConnected && c.getBoundingClientRect().height > 0 && getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).opacity !== '0',
        frames: s.frames, draws: s.draws, fps: s.frames / seconds, pixelsPerSecond: s.pixels / seconds }));
      const animations = document.getAnimations().filter(a => a.playState === 'running');
      return { seconds, canvases, totalPixelsPerSecond: canvases.reduce((n, c) => n + c.pixelsPerSecond, 0), rafRequests, rafCallbacks,
        rafCallbacksPerSecond: rafCallbacks / seconds, cssAnimations: animations.length, cssInfinite: animations.filter(a => a.effect?.getTiming().iterations === Infinity).length,
        longtasks: longtaskSupported ? tasks.filter(t => t.start >= started) : null, longtaskSupported,
        frameIntervalMs: { samples: sorted.length, p50: quantile(sorted, .50), p95: quantile(sorted, .95), max: sorted.at(-1) ?? null }, errors: [...errors] };
    }
  };
  window.__iosPerf.reset();
}

async function main() {
  const port = Number(arg('--port', '3000')), site = arg('--url', process.env.TEST_URL || ''), driver = arg('--driver', 'safari');
  const base = site || `http://127.0.0.1:${port}`, output = path.resolve(arg('--out', 'artifacts/perf/ios-sim'));
  const server = await serve(port, site);
  if (process.argv.includes('--serve')) { console.log(`Serving on ${port}`); return; }
  await fs.mkdir(output, { recursive: true });
  const report = { time: new Date().toISOString(), driver, url: base, commit: process.env.GITHUB_SHA || null,
    runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    caveats: ['Simulator GPU/frame rate is not physical iPhone performance.', 'Pixels/second is canvas area per rendered frame, not GPU fragment count.', 'Instrumentation begins after navigation; initial navigation errors may precede hooks.', 'rAF sampling is excluded from app counts; pre-injection cached rAF functions cannot be intercepted.'], results: [], errors: [] };
  let browser, session, page, evaluate, navigate, shot, cleanup;
  try {
    if (driver === 'webkit') {
      const { webkit } = await import('playwright');
      browser = await webkit.launch();
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      page = await context.newPage();
      page.on('pageerror', e => report.errors.push({ type: 'pageerror', message: e.message }));
      evaluate = (fn, ...args) => page.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: fn.toString(), args });
      navigate = url => page.goto(url, { waitUntil: 'load', timeout: 120000 });
      shot = file => page.screenshot({ path: file });
      cleanup = () => browser.close();
    } else {
      const { Builder } = await import('selenium-webdriver');
      session = await new Builder().usingServer('http://127.0.0.1:4444').withCapabilities({ browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceType': 'iPhone', ...(process.env.SIMULATOR_UDID ? { 'safari:deviceUDID': process.env.SIMULATOR_UDID } : {}) }).build();
      await session.manage().setTimeouts({ pageLoad: 120000, script: 30000, implicit: 0 });
      evaluate = (fn, ...args) => session.executeScript(fn, ...args);
      navigate = url => session.get(url);
      shot = async file => execFileSync('xcrun', ['simctl', 'io', process.env.SIMULATOR_UDID || 'booted', 'screenshot', file], { stdio: 'inherit' });
      cleanup = () => session.quit();
    }
    const waitFor = async (fn, ms = 60000) => {
      const start = Date.now(); while (Date.now() - start < ms) { if (await evaluate(fn)) return; await sleep(250); }
      throw new Error(`Timeout (${ms}ms): ${fn.toString()}`);
    };
    const clickText = async text => {
      await waitFor(() => !!document.querySelector('button'));
      const clicked = await evaluate(text => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim().replace(/\s+/g, '') === text || (text === '直接进入' && b.textContent.includes(text)));
        if (!button) return false;
        button.click(); return true;
      }, text);
      if (!clicked) throw new Error(`Button missing: ${text}`);
    };
    const measure = async (name, action) => {
      await evaluate(() => window.__iosPerf.reset());
      if (action) await action(); else await sleep(8000);
      const result = { name, ...await evaluate(() => window.__iosPerf.snapshot()) };
      if (name.startsWith('world-')) result.world = await evaluate(() => window.__worldTest);
      result.screenshot = `${name}.png`;
      await shot(path.join(output, result.screenshot));
      report.results.push(result); console.log(JSON.stringify(result));
    };
    try {
      await navigate(base); await evaluate(instrument);
      report.userAgent = await evaluate(() => navigator.userAgent);
      await measure('landing-idle');
      await clickText('直接进入');
      await waitFor(() => !document.querySelector('[role="dialog"][aria-label^="Pixel Reconstruction"]'));
      await sleep(2500);
      await measure('home-idle');
      await measure('home-scroll', async () => {
        for (const direction of [1, -1]) for (let i = 0; i < 25; i++) {
          await evaluate(direction => window.scrollBy(0, direction * Math.max(innerHeight * .35, document.documentElement.scrollHeight / 25)), direction);
          await sleep(200);
        }
      });
      await clickText('创作'); await sleep(2500); await measure('create-idle');
      await clickText('作品库'); await sleep(2500); await measure('gallery-idle');
    } catch (error) { report.errors.push({ scenario: 'site', message: String(error.stack || error) }); await shot(path.join(output, 'site-error.png')).catch(() => {}); }
    for (const quality of ['100k', '500k']) {
      try {
        await navigate(`http://127.0.0.1:${port}/__perf/world-test.html?q=${quality}`);
        await evaluate(instrument);
        await evaluate(() => { window.startWorldTest(); });
        await waitFor(() => window.__worldTest?.ready || window.__worldTest?.error, 240000);
        const state = await evaluate(() => window.__worldTest);
        if (state.error) throw new Error(state.error);
        await measure(`world-${quality}-idle`);
        await evaluate(() => window.__worldEngine.dispose());
      } catch (error) { report.errors.push({ scenario: `world-${quality}`, message: String(error.stack || error), state: await evaluate(() => window.__worldTest || null).catch(() => null) }); await shot(path.join(output, `world-${quality}-error.png`)).catch(() => {}); }
    }
  } catch (error) { report.errors.push({ scenario: 'driver', message: String(error.stack || error) }); }
  finally {
    if (cleanup) await cleanup().catch(error => report.errors.push({ scenario: 'cleanup', message: String(error) }));
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, 'ios-sim-results.json'), JSON.stringify(report, null, 2));
    if (report.errors.length || report.results.length !== 7 || report.results.some(r => r.errors.length || r.world?.error)) process.exitCode = 1;
  }
}
await main();
