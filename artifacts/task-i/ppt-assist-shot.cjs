// 答辩 PPT 第 7 页配图：深色主题工作室，向大肥鱼提问导出视频，截下回答与按钮标注。
//   node artifacts/task-i/ppt-assist-shot.cjs [url] [out.png] [question]
// 只放行 /assist（真实 DeepSeek 回答，一次调用）；warm/generate/edit 等付费接口全部 mock。
const fs = require('node:fs');
const { chromium } = require('playwright');
const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
const gateway = fs.readFileSync('.env.local', 'utf8').match(/^NEXT_PUBLIC_BEAM_API\s*=\s*["']?([^\r\n"']+)/m)[1].replace(/\/$/, '');
const URL_ = process.argv[2] || 'https://pixel-reconstruction.netlify.app';
const OUT = process.argv[3] || 'C:/Users/ys221/Desktop/pixel-promo/ppt/shots/N6-assist-dfy.png';
const Q = process.argv[4] || '导出 mp4 按钮在哪？帮我标出来';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1.5 });
  await context.addInitScript(job => {
    localStorage.setItem('ruhua-theme-v2', 'dark');
    localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '香港街景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
  }, job);
  await context.route(gateway + '/**', r => {
    const p = new URL(r.request().url()).pathname;
    if (/^\/(warm|generate|edit|edit-image|rerender|report|world\/generate)/.test(p)) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"warming":true}' });
    return r.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('response', async res => { if (res.url().endsWith('/assist')) console.log('assist', res.status(), (await res.text().catch(() => '')).slice(0, 600)); });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 60000 });
  await page.locator('[role=dialog]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '作品库' && b.getBoundingClientRect().width)?.click());
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3 && !(await page.getByRole('button', { name: /香港街景/ }).count()); i++) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '作品库' && b.getBoundingClientRect().width)?.click());
    await page.waitForTimeout(3000);
  }
  await page.getByRole('button', { name: /香港街景/ }).first().evaluate(el => el.click(), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /打开场景/ }).first().evaluate(el => el.click()).catch(() => {});
  await page.waitForFunction(() => !!document.querySelector('[class*=viewer-mount] canvas'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  // 导出卡片滚到视口中间偏下
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2, h3, h4')].find(e => e.textContent.trim() === '导出');
    if (h) { h.scrollIntoView({ block: 'start' }); scrollBy(0, -innerHeight * 0.3); }
  });
  await page.waitForTimeout(1500);
  const chip = page.locator('[aria-label="和大肥鱼聊天"], [aria-label="展开大肥鱼并聊天"]').first();
  await chip.evaluate(el => el.click());
  const box = page.getByRole('textbox', { name: '给大肥鱼的消息' });
  await box.waitFor({ state: 'visible', timeout: 8000 });
  await box.fill(Q); await box.press('Enter');
  const marked = await page.waitForFunction(() => /已标出|已高亮|已滚到/.test(document.querySelector('[data-assist-private]')?.textContent || ''), null, { timeout: 60000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1800);
  console.log('marked', marked);
  await page.screenshot({ path: OUT });
  console.log('saved', OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
