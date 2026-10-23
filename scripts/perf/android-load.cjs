// 安卓模拟器实测：在 AVD 里的真 Chrome 上数每个页面“在干多少活”，并用 rAF 采样记录帧间隔。
// 计数注入与场景照搬 scripts/perf/phone-load.cjs，但**不伪装** GPU / 核数 / UA / 视口——安卓上全用真实值。
//   node scripts/perf/android-load.cjs --label baseline --serve C:\Users\ys221\Desktop\sharp-web-baseline\out --port 3101
//   node scripts/perf/android-load.cjs --label current  --url http://10.0.2.2:3000
// 选项：--out artifacts/perf/android-<label>.json  --only landing,home,gallery,studio,world  --keep-chrome  --no-clear
// 前提：模拟器已启动（emulator -avd EBOOK_API34 -gpu host -no-snapshot-save），adb 在 %LOCALAPPDATA%\Android\Sdk\platform-tools。
// 每次运行先 `pm clear` Chrome（冷缓存、干净的 localStorage），再通过 adb forward + CDP 用 Playwright 接管。
// 作品库/工作室/走进世界用 artifacts/secure-job.json 与 artifacts/world-live-task.json 里的测试作品与世界（不花额度，不点「创建场景」）。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = name => process.argv.includes(name);
const LABEL = arg('--label', 'run');
const SERVE = arg('--serve', '');
const PORT = Number(arg('--port', SERVE ? '3101' : '0'));
const URL_BASE = arg('--url', SERVE ? `http://10.0.2.2:${PORT}` : 'http://10.0.2.2:3000');
const OUT = arg('--out', `artifacts/perf/android-${LABEL}.json`);
const SHOTS = path.join(path.dirname(OUT), `android-${LABEL}`);
const only = arg('--only', '');
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const CDP_PORT = Number(arg('--cdp-port', '9222'));
// 可选：让模拟器里的 Chrome 走本机代理（10.0.2.2 = 本机回环），如 --proxy 10.0.2.2:7890；被测站点本身不走代理
const PROXY = arg('--proxy', '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', timeout: 60000 }).trim();

// ---------- 静态服务器（改前的正式构建 out/）：MIME 要对，支持 Range ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.ksplat': 'application/octet-stream', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream',
};
function serve(dir, port) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const candidates = [file, path.join(file, 'index.html'), file + '.html'];
      file = candidates.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      let status = 200;
      if (!file) { file = path.join(root, '404.html'); status = 404; if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; } }
      const size = fs.statSync(file).size;
      const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      const range = status === 200 && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(status, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    } catch (error) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(error)); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve(server)); });
}

// ---------- 计数注入（同 phone-load.cjs，去掉了伪装 GPU/核数；另加 rAF 帧间隔采样） ----------
const INSTRUMENT = () => {
  if (window.__phoneLoad) return;
  // 每个 WebGL 画布：画了几帧（同一动画帧内多次 draw 算一帧）、累计填充像素、draw 调用数
  const stats = new Map();
  const label = canvas => canvas.getAttribute('aria-label') || canvas.className || canvas.parentElement?.className || 'canvas';
  const note = canvas => {
    const frame = document.timeline.currentTime;
    let s = stats.get(canvas);
    if (!s) stats.set(canvas, s = { frames: 0, pixels: 0, draws: 0, last: -1 });
    s.draws++;
    if (s.last !== frame) { s.last = frame; s.frames++; s.pixels += canvas.width * canvas.height; }
  };
  const wrap = (gl, canvas) => {
    if (gl.__counted) return; gl.__counted = true;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = gl[name]; if (typeof f !== 'function') continue;
      gl[name] = function () { note(canvas); return f.apply(this, arguments); };
    }
    const ext = gl.getExtension && gl.getExtension('ANGLE_instanced_arrays');
    if (ext) for (const name of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) { const f = ext[name]; ext[name] = function () { note(canvas); return f.apply(this, arguments); }; }
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = getContext.call(this, type, attrs);
    if (ctx && /webgl/.test(type)) wrap(ctx, this);
    return ctx;
  };
  // rAF 回调数（所有组件加起来）；采样器自己用原生 rAF，不计入
  let raf = 0; const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { raf++; return rafOrig(cb); };
  // 帧间隔采样：reset() 起一条 rAF 链，snapshot() 停掉并统计
  let gen = 0, intervals = [], lastTs = 0;
  const startSampler = () => {
    const g = ++gen; intervals = []; lastTs = 0;
    const loop = ts => { if (g !== gen) return; if (lastTs) intervals.push(ts - lastTs); lastTs = ts; rafOrig(loop); };
    rafOrig(loop);
  };
  const frameStats = () => {
    const xs = intervals.slice().sort((a, b) => a - b);
    const q = p => xs.length ? +xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(1) : null;
    return { frames: xs.length, p50: q(.5), p95: q(.95), max: xs.length ? +xs[xs.length - 1].toFixed(1) : null, jank50: xs.filter(x => x > 50).length, jank100: xs.filter(x => x > 100).length };
  };
  let t0 = performance.now();
  window.__phoneLoad = {
    reset() { stats.clear(); raf = 0; t0 = performance.now(); startSampler(); },
    snapshot() {
      const seconds = (performance.now() - t0) / 1000;
      gen++; // 停采样
      const canvases = [...stats.entries()].map(([canvas, s]) => ({
        label: String(label(canvas)).slice(0, 60), size: `${canvas.width}×${canvas.height}`, attached: canvas.isConnected,
        visible: canvas.isConnected && getComputedStyle(canvas).opacity !== '0' && canvas.getBoundingClientRect().height > 0,
        fps: +(s.frames / seconds).toFixed(1), mpixPerSec: +(s.pixels / seconds / 1e6).toFixed(1), draws: s.draws,
        level: canvas.dataset.level, dfps: canvas.dataset.fps,
      })).filter(c => c.fps > 0);
      const anims = document.getAnimations().filter(a => a.playState === 'running');
      const infinite = anims.filter(a => a.effect?.getTiming?.().iterations === Infinity);
      return {
        seconds: +seconds.toFixed(1), rafPerSec: +(raf / seconds).toFixed(1), canvases,
        totalMpixPerSec: +canvases.reduce((a, c) => a + c.mpixPerSec, 0).toFixed(1),
        cssAnimations: anims.length, cssInfinite: infinite.length,
        infiniteTargets: [...new Set(infinite.map(a => (a.effect?.target?.className || a.effect?.target?.tagName || '?').toString().slice(0, 40)))].slice(0, 12),
        frame: frameStats(),
      };
    },
  };
};

// ---------- 安卓 Chrome：清数据、去首次运行页、开远程调试 ----------
async function launchChrome(clear) {
  adb('wait-for-device');
  if (adb('shell', 'getprop', 'sys.boot_completed') !== '1') throw new Error('模拟器还没开机完成');
  adb('shell', 'am', 'force-stop', 'com.android.chrome');
  if (clear) adb('shell', 'pm', 'clear', 'com.android.chrome');
  try { adb('shell', 'pm', 'grant', 'com.android.chrome', 'android.permission.POST_NOTIFICATIONS'); } catch {}
  // http://10.0.2.2 不是安全上下文（navigator.deviceMemory 等会消失），线上是 https——把被测源当安全源，行为才和真机一致
  const origin = new URL(URL_BASE).origin;
  const proxy = PROXY ? ` --proxy-server=http://${PROXY} --proxy-bypass-list=${new URL(URL_BASE).hostname} --disable-quic` : '';
  adb('shell', `echo '_ --disable-fre --no-default-browser-check --no-first-run --disable-signin-promo --unsafely-treat-insecure-origin-as-secure=${origin}${proxy}' > /data/local/tmp/chrome-command-line`);
  adb('shell', 'am', 'set-debug-app', '--persistent', 'com.android.chrome');
  adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-a', 'android.intent.action.VIEW', '-d', 'about:blank');
  adb('forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote');
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(1000);
  }
  throw new Error('Chrome DevTools 端口没起来');
}
function stopChrome() {
  try { adb('shell', 'am', 'force-stop', 'com.android.chrome'); } catch {}
  try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch {}
}
function screencap(file) {
  try { const remote = '/sdcard/__perf.png'; adb('shell', 'screencap', '-p', remote); adb('pull', remote, file); adb('shell', 'rm', remote); return true; } catch { return false; }
}

async function measure(page, cdp, name, seconds, act) {
  await page.evaluate(() => window.__phoneLoad.reset());
  const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const t = Date.now();
  if (act) await act(); else await page.waitForTimeout(seconds * 1000);
  const rest = seconds * 1000 - (Date.now() - t);
  if (rest > 0) await page.waitForTimeout(rest);
  const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const snap = await page.evaluate(() => window.__phoneLoad.snapshot());
  const wall = (Date.now() - t) / 1000;
  const busy = k => +(((after[k] - before[k]) / wall) * 100).toFixed(1);
  const shot = `${SHOTS}-${name}.png`;
  await page.screenshot({ path: shot, timeout: 20000 }).catch(() => screencap(shot));
  const result = { name, ...snap, mainThreadBusyPct: busy('TaskDuration'), scriptPct: busy('ScriptDuration'), stylePct: busy('RecalcStyleDuration'), layoutPct: busy('LayoutDuration'), screenshot: path.relative(process.cwd(), shot).replace(/\\/g, '/') };
  const f = result.frame;
  console.log(`${name.padEnd(15)} gpu ${String(result.totalMpixPerSec).padStart(6)} Mpx/s  rAF ${String(result.rafPerSec).padStart(6)}/s  css∞ ${result.cssInfinite}  ` +
    `frame p50 ${f.p50} p95 ${f.p95} max ${f.max} jank>50 ${f.jank50}  main ${result.mainThreadBusyPct}%  ` +
    result.canvases.map(c => `[${c.label.slice(0, 18)} ${c.size} ${c.fps}fps ${c.mpixPerSec}Mpx/s${c.visible ? '' : ' HIDDEN'}]`).join(' '));
  return result;
}

// 优先真实点击（CDP 鼠标事件），点不到再退回 element.click()
async function press(locator, note) {
  try { await locator.click({ timeout: 10000 }); return 'click'; }
  catch { await locator.evaluate(element => element.click()); note.push(`fallback js click: ${locator}`); return 'js'; }
}
// 触屏手势（CDP Input.dispatchTouchEvent），坐标为 CSS 像素
async function touchDrag(cdp, points, stepMs) {
  const [x0, y0] = points[0];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (const [x, y] of points.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] }); await sleep(stepMs); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
  const task = fs.existsSync('artifacts/world-live-task.json') ? JSON.parse(fs.readFileSync('artifacts/world-live-task.json')) : null;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const server = SERVE ? await serve(SERVE, PORT) : null;
  if (server) console.log(`static ${SERVE} → 0.0.0.0:${PORT}`);
  const errors = [], consoleErrors = [], badResponses = [], notes = [];
  const results = [];
  let browser, env = {}, world = null, studio = null;
  const want = name => !only || only.split(',').some(o => name.startsWith(o));
  try {
    const version = await launchChrome(!flag('--no-clear'));
    console.log('chrome', version.Browser);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 60000 });
    const context = browser.contexts()[0];
    await context.addInitScript(INSTRUMENT);
    await context.addInitScript(({ job, task }) => {
      if (!localStorage.getItem('ruhua-gallery-v1')) localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
      if (task && !localStorage.getItem('ruhua-world-v1')) localStorage.setItem('ruhua-world-v1', JSON.stringify({ [task.jobId]: task }));
    }, { job, task });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('response', r => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().replace(/\?.*/, '').slice(-120)}`); });
    page.on('requestfailed', r => badResponses.push(`FAILED(${r.failure()?.errorText}) ${r.url().replace(/\?.*/, '').slice(-120)}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    const t0 = Date.now();
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const skip = page.getByRole('button', { name: /直接进入/ });
    await skip.waitFor({ state: 'visible', timeout: 120000 }).catch(() => notes.push('「直接进入」120 秒内未出现'));
    env = await page.evaluate(() => {
      let gpu = null;
      try { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch {}
      return { userAgent: navigator.userAgent, dpr: devicePixelRatio, viewport: `${innerWidth}×${innerHeight}`, screen: `${screen.width}×${screen.height}`, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, gpu, touch: navigator.maxTouchPoints, secure: isSecureContext, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    env.firstPaintToSkipSeconds = +((Date.now() - t0) / 1000).toFixed(1);
    console.log('env', env);
    await page.waitForTimeout(6000);
    if (want('landing')) results.push(await measure(page, cdp, 'landing-idle', 8));
    await press(skip, notes);
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (want('home')) {
      results.push(await measure(page, cdp, 'home-idle', 8));
      const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      results.push(await measure(page, cdp, 'home-scroll', 10, async () => {
        for (let i = 0; i < 8; i++) { await cdp.send('Input.synthesizeScrollGesture', { x: w / 2, y: h * .6, yDistance: -480, speed: 1600, gestureSourceType: 'touch' }); await page.waitForTimeout(200); }
        for (let i = 0; i < 8; i++) { await cdp.send('Input.synthesizeScrollGesture', { x: w / 2, y: h * .4, yDistance: 480, speed: 2400, gestureSourceType: 'touch' }); await page.waitForTimeout(100); }
      }));
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight * .55));
      await page.waitForTimeout(2000);
      results.push(await measure(page, cdp, 'home-mid-idle', 6));
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(800);
    }
    if (want('gallery') || want('studio') || want('world')) {
      await press(page.getByRole('button', { name: '作品库', exact: true }).first(), notes);
      await page.waitForTimeout(3000);
      if (want('gallery')) results.push(await measure(page, cdp, 'gallery-idle', 6));
      const disc = page.getByRole('button', { name: /验收场景/ }).first();
      await disc.waitFor({ state: 'attached' });
      await disc.evaluate(element => element.click());
      // 等工作室的场景下完、解析完（载入层里有 “x / y MB” 或「解析与排序」时算没好），最多 300 秒
      const studioT = Date.now();
      await page.waitForTimeout(3000);
      studio = { loadSeconds: null };
      try {
        await page.waitForFunction(() => {
          const text = [...document.querySelectorAll('.stagename')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.textContent).join(' ');
          return !text && document.querySelector('.viewer-mount canvas');
        }, null, { timeout: 300000, polling: 500 });
        studio.loadSeconds = +((Date.now() - studioT) / 1000).toFixed(1);
      } catch { notes.push('studio: 场景 300 秒内没载完，照常测量'); }
      console.log('studio scene loaded in', studio.loadSeconds, 's');
      await page.waitForTimeout(4000);
      if (want('studio')) {
        results.push(await measure(page, cdp, 'studio-idle', 8));
        const viewer = page.locator('.viewer-mount canvas').first();
        const box = await viewer.scrollIntoViewIfNeeded().then(() => viewer.boundingBox()).catch(() => null);
        if (!box) notes.push('studio-drag: 没找到 .viewer-mount canvas，拖的是默认位置');
        results.push(await measure(page, cdp, 'studio-drag', 5, async () => {
          const x = (box?.x ?? 100) + (box?.width ?? 200) / 2, y = (box?.y ?? 200) + (box?.height ?? 200) / 2;
          const pts = Array.from({ length: 41 }, (_, i) => [x + Math.sin(i / 6) * 80, y + Math.cos(i / 8) * 30]);
          await touchDrag(cdp, pts, 60);
        }));
      }
      if (want('world') && task) {
        await page.locator('#world-card').scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(1000);
        const t = Date.now();
        const net = [];
        const onReq = request => { request.__t = Date.now(); };
        const onDone = request => net.push({ url: request.url().replace(/\?.*/, '').slice(-90), start: +(((request.__t || t) - t) / 1000).toFixed(2), end: +((Date.now() - t) / 1000).toFixed(2), failed: !!request.failure() });
        page.on('request', onReq); page.on('requestfinished', onDone); page.on('requestfailed', onDone);
        await press(page.locator('#world-card').getByRole('button', { name: /走进世界/ }).last(), notes);
        const clicked = Date.now();
        let readySeconds = null, worldError = null;
        try {
          const state = await page.waitForFunction(() => {
            const dialog = document.querySelector('[role=dialog][aria-label="走进世界"]');
            if (dialog?.hasAttribute('data-ready')) return 'ready';
            const status = dialog?.querySelector('[role=status]')?.textContent || '';
            return /没能打开/.test(status) ? 'error: ' + status : false;
          }, null, { timeout: 420000, polling: 250 }).then(h => h.jsonValue());
          if (state === 'ready') readySeconds = +((Date.now() - t) / 1000).toFixed(2);
          else { worldError = `${state} @${((Date.now() - t) / 1000).toFixed(1)}s`; errors.push(`world: ${worldError}`); screencap(`${SHOTS}-world-error.png`); }
        } catch (error) {
          worldError = 'timeout 420s';
          errors.push(`world not ready in 420s: ${String(error.message).slice(0, 120)}`);
          screencap(`${SHOTS}-world-timeout.png`);
        }
        page.off('request', onReq); page.off('requestfinished', onDone); page.off('requestfailed', onDone);
        const heavy = net.filter(n => n.end - n.start > .3 || /world|spz|glb|engine/.test(n.url)).sort((a, b) => a.start - b.start);
        world = { readySeconds, error: worldError, clickLatency: +((clicked - t) / 1000).toFixed(2), requests: heavy };
        console.log('world ready in', readySeconds, 's');
        for (const n of heavy) console.log(`  ${String(n.start).padStart(6)} → ${String(n.end).padStart(6)}s  ${n.failed ? 'FAILED ' : ''}${n.url}`);
        if (readySeconds != null) {
          await page.waitForTimeout(3000);
          const r = await measure(page, cdp, 'world-idle', 8);
          r.readySeconds = readySeconds;
          results.push(r);
          const stick = page.locator('[role=dialog][aria-label="走进世界"] [class*="_stick__"]').first();
          const sbox = await stick.boundingBox().catch(() => null);
          results.push(await measure(page, cdp, 'world-walk', 6, async () => {
            if (sbox) {
              // 触屏摇杆：按住往上推 3 秒
              const cx = sbox.x + sbox.width / 2, cy = sbox.y + sbox.height / 2;
              await touchDrag(cdp, [[cx, cy], [cx, cy - 10], [cx, cy - 25], [cx, cy - 40], ...Array(30).fill([cx, cy - 40])], 100);
            } else {
              notes.push('world-walk: 没找到触屏摇杆，改用键盘 W');
              await page.keyboard.down('KeyW'); await page.waitForTimeout(3000); await page.keyboard.up('KeyW');
            }
          }));
        }
      }
    }
  } catch (error) {
    errors.push(String(error.message || error).slice(0, 500));
    screencap(`${SHOTS}-error.png`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!flag('--keep-chrome')) stopChrome();
    if (server) await new Promise(resolve => server.close(resolve));
    const uniq = xs => [...new Map(xs.map(x => [x, 0])).keys()];
    fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, url: URL_BASE, served: SERVE || null, proxy: PROXY || null, time: new Date().toISOString(), env, studio, world, results, errors, consoleErrors: uniq(consoleErrors).slice(0, 40), badResponses: uniq(badResponses).slice(0, 60), notes }, null, 2));
    console.log('wrote', OUT);
    if (errors.length) { console.log('errors:', errors); process.exitCode = 1; }
  }
})();
