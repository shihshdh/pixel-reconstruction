// 主线程卡顿归因：CPU 采样分析（CDP Profiler），把长任务（>50ms）时间窗里的采样按函数汇总，
// 看首屏载入与概览页滚动时到底是谁占着主线程。
//   node scripts/perf/ux-profile.cjs [--url ...] [--phone] [--phase load|scroll|both]
const { chromium } = require('playwright');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', 'https://pixel-reconstruction.netlify.app');
const phone = process.argv.includes('--phone');
const phase = arg('--phase', 'both');

const PROBE = (phone) => {
  if (phone) {
    const fake = proto => { const get = proto.getParameter; proto.getParameter = function (p) { if (p === 0x9246 || p === 0x1F01) return 'Apple GPU'; if (p === 0x9245 || p === 0x1F00) return 'Apple Inc.'; return get.call(this, p); }; };
    fake(WebGLRenderingContext.prototype); if (self.WebGL2RenderingContext) fake(WebGL2RenderingContext.prototype);
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 6 });
  }
  window.__long = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
};

function attribute(profile, windows, label) {
  // 采样时间（微秒，相对 profile.startTime）→ 节点；只统计落在长任务窗口里的采样
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map(), inclusive = new Map();
  let t = profile.startTime;
  const keyOf = n => { const f = n.callFrame; const file = (f.url || '').split('/').pop().split('?')[0]; return `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`; };
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i];
    const ms = t / 1000;
    if (!windows.some(([s, e]) => ms >= s && ms <= e)) continue;
    let id = profile.samples[i];
    const n = nodes.get(id);
    const k = keyOf(n);
    self.set(k, (self.get(k) || 0) + profile.timeDeltas[i] / 1000);
    const seen = new Set();
    while (id) { const nn = nodes.get(id); const kk = keyOf(nn); if (!seen.has(kk)) { inclusive.set(kk, (inclusive.get(kk) || 0) + profile.timeDeltas[i] / 1000); seen.add(kk); } id = parent.get(id); }
  }
  const top = (m, n) => [...m.entries()].filter(([k]) => !/^\((program|idle|root|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`);
  console.log(`\n=== ${label}: ${windows.length} long tasks, ${windows.reduce((s, [a, b]) => s + b - a, 0).toFixed(0)} ms ===`);
  console.log('-- self time --'); console.log(top(self, 18).join('\n'));
  console.log('-- inclusive (excluding roots) --'); console.log(top(inclusive, 25).join('\n'));
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext(phone ? { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : { viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PROBE, phone);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  if (phone) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // 页面的 performance.now() 零点 = 导航开始；profile 时间用 Profiler 自己的时钟，两者用一次对表换算
  await cdp.send('Profiler.start');
  await page.goto(URL_BASE, { waitUntil: 'commit' });
  if (phase !== 'scroll') {
    try { await page.waitForFunction(() => !!document.querySelector('[class*=readyDot]'), null, { timeout: 90000, polling: 200 }); } catch {}
    await page.waitForTimeout(3000);
  }
  let { profile } = await cdp.send('Profiler.stop');
  // 对表：profile.endTime（μs，单调时钟）≈ 此刻；页面 performance.now() 此刻
  const nowPage = await page.evaluate(() => performance.now());
  const offset = profile.endTime / 1000 - nowPage; // profile 毫秒 = 页面毫秒 + offset
  const longs = await page.evaluate(() => window.__long.splice(0));
  if (phase !== 'scroll') attribute(profile, longs.map(([s, d]) => [s + offset - profile.startTime / 1000 + profile.startTime / 1000, s + d + offset]), 'LOAD');

  if (phase !== 'load') {
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /直接进入/.test(b.textContent))?.click());
    await page.waitForTimeout(3000);
    await cdp.send('Profiler.start');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 600) { await page.mouse.wheel(0, 600); await page.waitForTimeout(150); }
    await page.waitForTimeout(1500);
    ({ profile } = await cdp.send('Profiler.stop'));
    const now2 = await page.evaluate(() => performance.now());
    const off2 = profile.endTime / 1000 - now2;
    const longs2 = await page.evaluate(() => window.__long.splice(0));
    console.log('scroll long tasks (page ms, dur):', longs2.map(([s, d]) => [Math.round(s), Math.round(d)]));
    attribute(profile, longs2.map(([s, d]) => [s + off2, s + d + off2]), 'SCROLL');
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
