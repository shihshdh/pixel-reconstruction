// 手机发热体检：在 iPhone 仿真里数每个页面“在干多少活”——每个画布每秒画了几帧、每帧填多少像素、
// 主线程忙了多久、有多少 CSS 动画一直在跑。数的是工作量，与本机显卡快慢无关，所以改前改后可以直接比。
//   node scripts/perf/phone-load.cjs [--url http://127.0.0.1:3000] [--out artifacts/perf/phone-load.json] [--headed]
// 仿真：iPhone 15 Pro（393×852、DPR 3、触屏、Safari UA），WebGL 报告 "Apple GPU"、6 核——让网站走真机的手机路径
// （不伪装的话仿真里报的是本机 NVIDIA，网站会当成电脑，问题就藏起来了）。
// 作品库/工作室/走进世界用 artifacts/secure-job.json 与 artifacts/world-live-task.json 里的测试作品与世界（不花额度）。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', process.env.TEST_URL || 'http://127.0.0.1:3000');
const OUT = arg('--out', 'artifacts/perf/phone-load.json');
const headed = process.argv.includes('--headed');
const only = arg('--only', '');

const INSTRUMENT = () => {
  // 伪装成 iPhone 的 GPU 与核数
  const fake = proto => {
    const get = proto.getParameter;
    proto.getParameter = function (p) { if (p === 0x9246 || p === 0x1F01) return 'Apple GPU'; if (p === 0x9245 || p === 0x1F00) return 'Apple Inc.'; return get.call(this, p); };
  };
  fake(WebGLRenderingContext.prototype); if (self.WebGL2RenderingContext) fake(WebGL2RenderingContext.prototype);
  Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 6 });
  try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => undefined }); } catch {}

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
  // rAF 回调数（所有组件加起来）
  let raf = 0; const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { raf++; return rafOrig(cb); };
  let t0 = performance.now();
  window.__phoneLoad = {
    reset() { stats.clear(); raf = 0; t0 = performance.now(); },
    snapshot() {
      const seconds = (performance.now() - t0) / 1000;
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
      };
    },
  };
};

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
  const result = { name, ...snap, mainThreadBusyPct: busy('TaskDuration'), scriptPct: busy('ScriptDuration'), stylePct: busy('RecalcStyleDuration'), layoutPct: busy('LayoutDuration') };
  console.log(`${name.padEnd(22)} main ${String(result.mainThreadBusyPct).padStart(5)}%  gpu ${String(result.totalMpixPerSec).padStart(6)} Mpx/s  rAF ${result.rafPerSec}/s  css∞ ${result.cssInfinite}  ` +
    result.canvases.map(c => `[${c.label.slice(0, 18)} ${c.size} ${c.fps}fps ${c.mpixPerSec}Mpx/s${c.visible ? '' : ' HIDDEN'}]`).join(' '));
  return result;
}

(async () => {
  const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
  const task = fs.existsSync('artifacts/world-live-task.json') ? JSON.parse(fs.readFileSync('artifacts/world-live-task.json')) : null;
  const browser = await chromium.launch({ channel: 'msedge', headless: !headed && !process.env.PERF_HEADED, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(INSTRUMENT);
  await context.addInitScript(({ job, task }) => {
    if (!localStorage.getItem('ruhua-gallery-v1')) localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
    if (task && !localStorage.getItem('ruhua-world-v1')) localStorage.setItem('ruhua-world-v1', JSON.stringify({ [task.jobId]: task }));
  }, { job, task });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const results = [];
  const want = name => !only || only.split(',').some(o => name.startsWith(o));
  try {
    await page.goto(URL_BASE);
    await page.waitForTimeout(6000);
    if (want('landing')) results.push(await measure(page, cdp, 'landing-idle', 8));
    await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 60000 });
    await page.locator('[role=dialog]').waitFor({ state: 'detached' }).catch(() => {});
    await page.waitForTimeout(2500);
    if (want('home')) {
      results.push(await measure(page, cdp, 'home-idle', 8));
      results.push(await measure(page, cdp, 'home-scroll', 10, async () => {
        for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 420); await page.waitForTimeout(250); }
        for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -420); await page.waitForTimeout(150); }
      }));
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight * .55));
      await page.waitForTimeout(2000);
      results.push(await measure(page, cdp, 'home-mid-idle', 6));
      await page.evaluate(() => scrollTo(0, 0));
    }
    if (want('gallery') || want('studio') || want('world')) {
      // 手机上底部 dock 与顶部导航都有「作品库」，助手的气泡可能盖住它：点可见的那一个
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '作品库' && b.getBoundingClientRect().width > 0)?.click());
      await page.waitForTimeout(2500);
      if (want('gallery')) results.push(await measure(page, cdp, 'gallery-idle', 6));
      const disc = page.getByRole('button', { name: /验收场景/ }).first();
      await disc.waitFor({ state: 'attached' });
      await disc.evaluate(element => element.click());
      await page.waitForTimeout(12000);
      if (want('studio')) {
        results.push(await measure(page, cdp, 'studio-idle', 8));
        const box = await page.locator('canvas').first().boundingBox().catch(() => null);
        results.push(await measure(page, cdp, 'studio-drag', 5, async () => {
          const x = (box?.x ?? 100) + (box?.width ?? 200) / 2, y = (box?.y ?? 200) + (box?.height ?? 200) / 2;
          await page.mouse.move(x, y); await page.mouse.down();
          for (let i = 0; i < 40; i++) { await page.mouse.move(x + Math.sin(i / 6) * 80, y + Math.cos(i / 8) * 30); await page.waitForTimeout(60); }
          await page.mouse.up();
        }));
      }
      if (want('world') && task) {
        await page.locator('#world-card').scrollIntoViewIfNeeded().catch(() => {});
        const t = Date.now();
        const net = [];
        const onReq = request => { request.__t = Date.now(); };
        const onDone = request => { const timing = request.timing(); net.push({ url: request.url().replace(/\?.*/, '').slice(-80), start: +((request.__t - t) / 1000).toFixed(2), end: +((Date.now() - t) / 1000).toFixed(2), size: 0 }); };
        page.on('request', onReq); page.on('requestfinished', onDone); page.on('requestfailed', onDone);
        await page.evaluate(() => { window.__worldT0 = performance.now(); });
        // 鲸鱼娘的聊天气泡可能正好盖在按钮上：直接触发按钮的 click
        await page.locator('#world-card').getByRole('button', { name: /走进世界/ }).last().evaluate(element => element.click());
        await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label="走进世界"]')?.hasAttribute('data-ready'), null, { timeout: 180000 });
        const readySeconds = (Date.now() - t) / 1000;
        console.log('world ready in', readySeconds, 's');
        page.off('request', onReq); page.off('requestfinished', onDone); page.off('requestfailed', onDone);
        for (const n of net.filter(n => n.end - n.start > .3 || /world|spz|glb|engine/.test(n.url))) console.log(`  ${String(n.start).padStart(6)} → ${String(n.end).padStart(6)}s  ${n.url}`);
        await page.waitForTimeout(3000);
        const r = await measure(page, cdp, 'world-idle', 8);
        r.readySeconds = readySeconds;
        results.push(r);
        results.push(await measure(page, cdp, 'world-walk', 6, async () => {
          await page.keyboard.down('KeyW'); await page.waitForTimeout(3000); await page.keyboard.up('KeyW');
        }));
      }
    }
  } catch (error) {
    errors.push(String(error.message || error));
    await page.screenshot({ path: OUT.replace(/\.json$/, '-error.png') }).catch(() => {});
  } finally {
    await browser.close();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ url: URL_BASE, time: new Date().toISOString(), results, errors }, null, 2));
    if (errors.length) { console.log('errors:', errors); process.exitCode = 1; }
  }
})();
