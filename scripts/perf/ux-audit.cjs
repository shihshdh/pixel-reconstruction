// 网页体验体检：用户能感觉到的指标——多久看到东西、展示场景多久就绪、首屏下了多少字节、主线程卡了多久、
// 点导航后多久有反应、滚动时掉没掉帧、布局有没有跳。电脑与手机（iPhone 仿真 + CPU 降速 4 倍 + 4G 网络）各跑一遍。
//   node scripts/perf/ux-audit.cjs [--url https://pixel-reconstruction.netlify.app] [--only desktop|phone] [--out artifacts/perf/ux-audit.json]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', 'https://pixel-reconstruction.netlify.app');
const OUT = arg('--out', 'artifacts/perf/ux-audit.json');
const only = arg('--only', '');

// 页面里装的探针：LCP、CLS、长任务、交互延迟、帧间隔
const PROBE = (phone) => {
  if (phone) {
    const fake = proto => {
      const get = proto.getParameter;
      proto.getParameter = function (p) { if (p === 0x9246 || p === 0x1F01) return 'Apple GPU'; if (p === 0x9245 || p === 0x1F00) return 'Apple Inc.'; return get.call(this, p); };
    };
    fake(WebGLRenderingContext.prototype); if (self.WebGL2RenderingContext) fake(WebGL2RenderingContext.prototype);
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 6 });
  }
  const m = window.__ux = { lcp: 0, lcpEl: '', cls: 0, longTasks: [], events: [], frames: [], errors: [] };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { m.lcp = e.startTime; m.lcpEl = (e.element?.tagName || '') + '.' + (e.element?.className?.toString?.().slice(0, 40) || ''); } }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) m.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) m.events.push({ t: Math.round(e.startTime), name: e.name, dur: Math.round(e.duration), input: Math.round(e.processingStart - e.startTime), proc: Math.round(e.processingEnd - e.processingStart) }); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
  let last = 0;
  const tick = t => { if (last) m.frames.push([Math.round(t), Math.round((t - last) * 10) / 10]); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  addEventListener('error', e => m.errors.push(String(e.message).slice(0, 200)));
};

const summarizeFrames = (frames, from, to) => {
  const f = frames.filter(([t]) => t >= from && t <= to).map(([, d]) => d);
  if (!f.length) return null;
  const sorted = [...f].sort((a, b) => a - b);
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const span = (to - from) / 1000;
  return { fps: Math.round(f.length / span), p50: pct(.5), p95: pct(.95), max: sorted[sorted.length - 1], over50ms: f.filter(d => d > 50).length, over100ms: f.filter(d => d > 100).length };
};

async function run(kind) {
  const phone = kind === 'phone';
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-position=0,0'] });
  const context = await browser.newContext(phone ? {
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(PROBE, phone);
  // 巡检不唤醒线上 GPU：创作页进入时的预热请求直接拦掉
  await context.route('**/warm', route => route.abort());
  await require('./mock-paid.cjs')(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (phone) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // 4G：下行 9 Mbps、上行 1.5 Mbps、往返 150 ms（接近国内访问海外 CDN 的情况）
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
  }
  const requests = new Map();
  cdp.on('Network.responseReceived', e => { const r = requests.get(e.requestId) || {}; Object.assign(r, { url: e.response.url, type: e.type, status: e.response.status, mime: e.response.mimeType }); requests.set(e.requestId, r); });
  cdp.on('Network.loadingFinished', e => { const r = requests.get(e.requestId) || {}; r.bytes = e.encodedDataLength; r.done = Date.now(); requests.set(e.requestId, r); });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

  const t0 = Date.now();
  await page.goto(URL_BASE, { waitUntil: 'commit' });
  const marks = {};
  // 首次有内容、展示场景就绪
  const waitFor = async (name, fn, timeout) => { try { await page.waitForFunction(fn, null, { timeout, polling: 100 }); marks[name] = Date.now() - t0; } catch { marks[name] = null; } };
  await waitFor('firstText', () => document.body && document.body.innerText.trim().length > 20, 30000);
  await waitFor('sceneReady', () => !!document.querySelector('[class*=readyDot]') || /场景已就绪|拖动/.test(document.body.innerText), 60000);
  await page.waitForTimeout(4000);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint'); return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: Math.round(p.find(x => x.name === 'first-contentful-paint')?.startTime || 0) }; });
  const bytesAtReady = [...requests.values()].filter(r => r.bytes && r.done && r.done - t0 <= (marks.sceneReady || 60000) + 4000);
  const byType = {};
  for (const r of bytesAtReady) { const k = /\.(ksplat|splat|spz|ply)(\?|$)/.test(r.url) ? 'scene' : (r.type || 'other'); byType[k] = (byType[k] || 0) + r.bytes; }
  const biggest = [...requests.values()].filter(r => r.bytes).sort((a, b) => b.bytes - a.bytes).slice(0, 8).map(r => ({ kb: Math.round(r.bytes / 1024), url: r.url.replace(URL_BASE, '').slice(0, 90) }));

  // 首屏空闲时的帧
  const idleFrom = await page.evaluate(() => performance.now());
  await page.waitForTimeout(3000);
  const idleTo = await page.evaluate(() => performance.now());

  // 点「直接进入」→ 概览；再依次点导航
  const clickTimes = {};
  const timedClick = async (label, fn, settle) => {
    const s = Date.now();
    try { await fn(); await page.waitForFunction(settle, null, { timeout: 15000, polling: 50 }); clickTimes[label] = Date.now() - s; } catch (e) { clickTimes[label] = 'fail: ' + String(e.message).slice(0, 60); }
    await page.waitForTimeout(1500);
  };
  await timedClick('enter', () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => /直接进入/.test(b.textContent))?.click()), () => !!document.querySelector('nav, .nav-tabbar'));
  for (const tab of ['创作', '工作室', '修图', '作品库', '概览']) {
    await timedClick('tab:' + tab, () => page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t && b.getBoundingClientRect().width > 0)?.click(), tab),
      () => true);
  }
  // 概览页滚动到底再回来，量滚动时的帧
  const scrollFrom = await page.evaluate(() => performance.now());
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(height, 12000); y += phone ? 500 : 700) { await page.mouse.wheel(0, phone ? 500 : 700); await page.waitForTimeout(120); }
  await page.waitForTimeout(800);
  const scrollTo = await page.evaluate(() => performance.now());

  const ux = await page.evaluate(() => window.__ux);
  const longTotal = ux.longTasks.reduce((s, [, d]) => s + d, 0);
  const result = {
    kind, url: URL_BASE, nav, marks, lcp: Math.round(ux.lcp), lcpEl: ux.lcpEl, cls: Math.round(ux.cls * 1000) / 1000,
    longTasks: { count: ux.longTasks.length, totalMs: longTotal, worst: ux.longTasks.sort((a, b) => b[1] - a[1]).slice(0, 6) },
    bytesUntilReadyKB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v / 1024)])), totalRequests: requests.size, biggest,
    idleFrames: summarizeFrames(ux.frames, idleFrom, idleTo), scrollFrames: summarizeFrames(ux.frames, scrollFrom, scrollTo), pageHeight: height,
    clickToSettledMs: clickTimes, slowInteractions: ux.events.filter(e => e.dur >= 100).slice(0, 12),
    errors: [...ux.errors, ...consoleErrors].slice(0, 12),
  };
  await page.screenshot({ path: path.join(path.dirname(OUT), `ux-${kind}.png`) });
  await browser.close();
  return result;
}

module.exports = { PROBE, summarizeFrames };

if (require.main === module) (async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const results = [];
  for (const kind of ['desktop', 'phone']) if (!only || only === kind) { const r = await run(kind); results.push(r); console.log(JSON.stringify(r, null, 1)); }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
