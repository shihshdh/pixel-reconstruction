// 截图巡检：按手机（或电脑）尺寸把每个页面、每一屏截下来，人工看排版问题（遮挡、溢出、截断、空白卡片）。
//   node scripts/perf/ux-tour.cjs [--url ...] [--width 393 --height 852] [--desktop] [--theme dark] [--out artifacts/perf/tour]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', 'https://pixel-reconstruction.netlify.app');
const desktop = process.argv.includes('--desktop');
const W = Number(arg('--width', desktop ? 1440 : 393)), H = Number(arg('--height', desktop ? 900 : 852));
const theme = arg('--theme', 'light');
const OUT = arg('--out', `artifacts/perf/tour-${desktop ? 'desktop' : W}-${theme}`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext(desktop ? { viewport: { width: W, height: H } } : {
    viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(([phone, theme]) => {
    try { localStorage.setItem('ruhua-theme-v2', theme); } catch {}
    if (!phone) return;
    const fake = proto => { const get = proto.getParameter; proto.getParameter = function (p) { if (p === 0x9246 || p === 0x1F01) return 'Apple GPU'; if (p === 0x9245 || p === 0x1F00) return 'Apple Inc.'; return get.call(this, p); }; };
    fake(WebGLRenderingContext.prototype); if (self.WebGL2RenderingContext) fake(WebGL2RenderingContext.prototype);
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 6 });
  }, [!desktop, theme]);
  // 巡检不唤醒线上 GPU：创作页进入时的预热请求直接拦掉
  await context.route('**/warm', route => route.abort());
  const page = await context.newPage();
  let n = 0;
  const shot = async name => { await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) }); };
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500); await shot('landing-early');
  try { await page.waitForFunction(() => !!document.querySelector('[class*=readyDot]'), null, { timeout: 60000 }); } catch {}
  await page.waitForTimeout(1500); await shot('landing-ready');
  // 展示页往下滚（邀请段落）
  await page.mouse.wheel(0, H); await page.waitForTimeout(1500); await shot('landing-scrolled');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /直接进入/.test(b.textContent))?.click());
  await page.waitForTimeout(2500);
  // 概览页逐屏
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0, i = 0; y < height && i < 14; y += H * 0.85, i++) {
    await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), y);
    await page.waitForTimeout(1800);
    await shot(`home-${i}`);
  }
  for (const tab of ['创作', '工作室', '修图', '作品库']) {
    await page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t && b.getBoundingClientRect().width > 0)?.click(), tab);
    await page.waitForTimeout(2200);
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(400);
    await shot(`tab-${['create', 'studio', 'edit', 'gallery'][['创作', '工作室', '修图', '作品库'].indexOf(tab)]}`);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h > H * 1.3) { await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), h); await page.waitForTimeout(1200); await shot(`tab-${tab}-bottom`.replace(/[^\w-]/g, '')); }
  }
  // 大肥鱼面板
  await page.evaluate(() => document.querySelector('[aria-label*="大肥鱼"]')?.click());
  await page.waitForTimeout(2000); await shot('whale-open');
  // 横向溢出检查
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log('saved', n, 'shots to', OUT, 'horizontal overflow px:', overflow);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
