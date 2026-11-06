// 全流程手机 CPU/合成轨迹；付费接口全部 mock。原始文件仅落 artifacts。
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PROBE, summarizeFrames } = require('./ux-audit.cjs');
const { attribute } = require('./ux-profile.cjs');
const arg = (k, d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d;
const out = arg('--out', 'artifacts/task-k/scenarios');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await context.addInitScript(PROBE, true);
    await context.addInitScript(job => localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }])), JSON.parse(fs.readFileSync('artifacts/secure-job.json')));
    await require('./mock-paid.cjs')(context);
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    const results = [];
    const phase = async (name, action) => {
      if (process.argv.includes('--studio-only') && !name.startsWith('studio') && name !== 'edit-scroll') { await action(); return; }
      const trace = [];
      const collect = e => trace.push(...e.value.filter(x => x.ph === 'X' && x.dur && /^(FunctionCall|FireAnimationFrame|Layout|UpdateLayoutTree|Paint|PrePaint|Layerize|CompositeLayers|RasterTask|DrawFrame|GPUTask|ProxyImpl::ScheduledActionDraw|MainFrame.Draw)$/.test(x.name)));
      cdp.on('Tracing.dataCollected', collect);
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink,cc,gpu', options: 'record-as-much-as-possible' });
      await cdp.send('Profiler.start');
      const from = await page.evaluate(() => performance.now());
      await action();
      const to = await page.evaluate(() => performance.now());
      const { profile } = await cdp.send('Profiler.stop');
      const now = await page.evaluate(() => performance.now());
      const offset = profile.endTime / 1000 - now;
      const data = await page.evaluate(() => window.__ux);
      const longs = data.longTasks.filter(([s]) => s >= from && s <= to);
      attribute(profile, longs.map(([s, d]) => [s + offset, s + d + offset]), name);
      const ended = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end'); await ended;
      cdp.off('Tracing.dataCollected', collect);
      fs.writeFileSync(`${out}/${name}.cpuprofile`, JSON.stringify(profile));
      fs.writeFileSync(`${out}/${name}.trace.json`, JSON.stringify({ traceEvents: trace }));
      const costs = {};
      for (const e of trace) if (e.ph === 'X' && e.dur) costs[e.name] = (costs[e.name] || 0) + e.dur / 1000;
      const result = { name, frames: summarizeFrames(data.frames, from, to), longTasks: { count: longs.length, totalMs: longs.reduce((s, [, d]) => s + d, 0), worst: longs.sort((a,b) => b[1]-a[1]).slice(0,5) }, traceCosts: Object.entries(costs).sort((a,b) => b[1]-a[1]).slice(0,25) };
      results.push(result); console.log(JSON.stringify(result));
      fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
    };
    const click = text => page.evaluate(t => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === t && x.getBoundingClientRect().width); if (!b) throw Error('missing '+t); b.click(); }, text);
    const scroll = async () => {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      for (const dir of [1,-1]) for (let y = 0; y < Math.min(h,12000); y += 500) { await page.mouse.wheel(0, dir * 500); await page.waitForTimeout(120); }
      await page.waitForTimeout(800);
    };
    await page.goto(arg('--url', 'http://127.0.0.1:3207'), { waitUntil: 'domcontentloaded' });
    await phase('landing', async () => { await page.waitForSelector('[class*=readyDot]', { timeout: 90000 }); await page.waitForTimeout(3000); });
    await phase('enter', async () => { await page.getByRole('button', { name: /直接进入/ }).click(); await page.waitForTimeout(4000); });
    await phase('overview-scroll', scroll);
    await phase('create', async () => { await click('创作'); await page.waitForTimeout(3000); });
    await click('作品库'); await page.waitForTimeout(3000);
    await phase('gallery-drag', async () => {
      const disc = page.getByRole('button', { name: /验收场景/ }).first();
      const b = await disc.boundingBox();
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
      for (let i=0;i<20;i++) { await page.mouse.move(b.x+b.width/2-i*5,b.y+b.height/2); await page.waitForTimeout(40); }
      await page.mouse.up(); await page.waitForTimeout(2000);
    });
    await page.getByRole('button', { name: /验收场景/ }).first().evaluate(el => el.click());
    await page.waitForTimeout(1200);
    await phase('studio-load', async () => { await page.getByRole('button', { name: /打开场景/ }).first().evaluate(el => el.click()); await page.waitForSelector('[class*=viewer-mount] canvas', { timeout: 90000 }); await page.waitForTimeout(10000); });
    await phase('studio-drag', async () => {
      const b = await page.locator('[class*=viewer-mount] canvas').first().boundingBox();
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
      for(let i=0;i<30;i++) { await page.mouse.move(b.x+b.width/2+Math.sin(i/5)*60,b.y+b.height/2); await page.waitForTimeout(40); }
      await page.mouse.up(); await page.waitForTimeout(1000);
    });
    await phase('studio-scroll', scroll);
    await phase('studio-idle', () => page.waitForTimeout(3000));
    await click('修图'); await page.waitForTimeout(3000);
    await phase('edit-scroll', scroll);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
