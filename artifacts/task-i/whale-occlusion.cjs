// 大肥鱼对话框遮挡检查：各视口打开工作室，向大肥鱼提问导出视频（/assist mock：回复并标出「导出 mp4」），
// 检查 ① 对话框完整在屏幕内、不盖顶栏 ② 标题和输入框可见 ③ 标出的按钮没有被对话框/形象/气泡挡住。
//   node artifacts/task-i/whale-occlusion.cjs [url] [outDir] [only-viewport-name]
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
const gateway = fs.readFileSync('.env.local', 'utf8').match(/^NEXT_PUBLIC_BEAM_API\s*=\s*["']?([^\r\n"']+)/m)[1].replace(/\/$/, '');
const BASE = process.argv[2] || 'http://127.0.0.1:3108';
const OUT = process.argv[3] || 'artifacts/task-i/occlusion';
const ONLY = process.argv[4];
fs.mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { name: 'desktop-1280x720', viewport: { width: 1280, height: 720 } },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 } },
  { name: 'laptop-1366x768', viewport: { width: 1366, height: 768 } },
  { name: 'tablet-820', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  { name: 'phone-393', ...devices['iPhone 15 Pro'] },
  { name: 'phone-land', ...devices['iPhone 15 Pro landscape'] },
].filter(v => !ONLY || ONLY.split(',').includes(v.name));

async function run(browser, vp) {
  const { name, ...options } = vp;
  const context = await browser.newContext(options);
  await context.addInitScript(job => {
    localStorage.setItem('ruhua-theme-v2', 'dark');
    localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
    // 手机默认收起，这里展开形象，检查形象 + 对话框的完整情况
    localStorage.setItem('ruhua-companion-v1', JSON.stringify({ collapsed: false, right: 18, bottom: 16, known: true }));
  }, job);
  await context.route(gateway + '/**', route => {
    const req = route.request(), p = new URL(req.url()).pathname;
    if (p === '/assist') {
      const body = req.postData() || '';
      const ref = (body.match(/\[(c\d+)\][^\\]*?导出 ?mp4/i) || [])[1];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        reply: '先在下方勾选一种运镜并加入序列，再点「导出 mp4」。导出时保持标签页在前台。', mood: 'happy',
        actions: ref ? [{ type: 'highlight', ref }] : [] }) });
    }
    if (/^\/(warm|generate|edit|edit-image|rerender|report|world\/generate)/.test(p)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"warming":true}' });
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  const result = { name };
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 60000 });
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '作品库' && b.getBoundingClientRect().width)?.click());
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: /验收场景/ }).first().evaluate(el => el.click());
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /打开场景/ }).first().evaluate(el => el.click()).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('[class*=viewer-mount] canvas'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const chip = page.locator('[aria-label="和大肥鱼聊天"], [aria-label="展开大肥鱼并聊天"]').first();
    await chip.waitFor({ state: 'attached', timeout: 20000 });
    await chip.evaluate(el => el.click());
    const box = page.getByRole('textbox', { name: '给大肥鱼的消息' });
    await box.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(800);
    result.open = await measure(page);
    await page.screenshot({ path: path.join(OUT, `${name}-open.png`) });
    await box.fill('导出视频怎么操作？'); await box.press('Enter');
    await page.waitForFunction(() => /已标出/.test(document.querySelector('[data-assist-private]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1400);
    result.after = await measure(page);
    await page.screenshot({ path: path.join(OUT, `${name}-after.png`) });
  } catch (e) { result.error = String(e.message || e).slice(0, 200); }
  result.errors = errors;
  await context.close();
  return result;
}

function measure(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-assist-private]');
    const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null; };
    const hit = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const panel = rect(root?.querySelector('[role=dialog]'));
    const title = rect(document.getElementById('whale-title'));
    const input = rect(root?.querySelector('textarea'));
    const nav = rect(document.querySelector('.nav-right'));
    const target = rect(document.querySelector('[data-assist-highlight]'));
    const parts = root ? [...root.children].map(rect).filter(Boolean) : [];
    const W = innerWidth, H = innerHeight;
    const core = r => { const i = r.r - r.l > 200 ? (r.r - r.l) * 0.2 : 0; return { l: r.l + i, r: r.r - i, t: r.t, b: r.b }; }; // 宽按钮只看中间 60%
    const inside = r => !r || (r.l >= 0 && r.t >= 0 && r.r <= W && r.b <= H);
    return {
      layout: root?.getAttribute('data-layout') || 'closed', panel, target,
      panelInside: inside(panel), titleVisible: !!title && inside(title), inputVisible: !!input && inside(input),
      coversNav: hit(panel, nav), targetCovered: !!target && parts.some(p => hit(p, core(target))), targetEdgeCovered: !!target && parts.some(p => hit(p, target)), targetFound: !!target,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const all = [];
  for (const vp of VIEWPORTS) {
    const r = await run(browser, vp);
    all.push(r);
    const o = r.open || {}, a = r.after || {};
    console.log(`${r.name.padEnd(17)} open: ${o.layout} inside=${o.panelInside} title=${o.titleVisible} input=${o.inputVisible} nav=${o.coversNav ? 'COVERED' : 'ok'} | after: ${a.layout} target=${a.targetFound ? (a.targetCovered ? 'COVERED' : a.targetEdgeCovered ? 'visible(edge)' : 'visible') : 'none'}${r.error ? ' ERROR ' + r.error : ''}${r.errors.length ? ' pageerrors ' + r.errors.length : ''}`);
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(all, null, 1));
  await browser.close();
})();
