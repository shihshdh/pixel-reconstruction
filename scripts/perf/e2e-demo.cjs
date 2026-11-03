// 现场演示前的端到端验收：按演示顺序把每个功能真实跑一遍，逐项判定通过 / 失败，记录耗时、截图和页面报错。
//   node scripts/perf/e2e-demo.cjs --url <站点> [--phone] [--skip-upload] [--skip-export] [--out artifacts/perf/e2e]
// 会真的花一点钱：上传一张照片走云端重建（GPU 十几秒），鲸鱼娘问一句（DeepSeek）。不花 World Labs 额度：
// 走进世界用 artifacts/world-live-task.json 里已有的世界；修图不实际提交。
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', 'https://pixel-reconstruction.netlify.app');
const phone = process.argv.includes('--phone');
const skipUpload = process.argv.includes('--skip-upload');
const skipExport = process.argv.includes('--skip-export') || phone;
const onlyUpload = process.argv.includes('--only-upload');
const OUT = arg('--out', `artifacts/perf/e2e-${phone ? 'phone' : 'desktop'}`);
const PHOTO = arg('--photo', 'public/scene/london.jpg');

const results = [];
const log = (step, ok, detail = '') => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? '  — ' + detail : ''}`); };
const visibleButton = (page, text) => page.evaluate(t => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === t && x.getBoundingClientRect().width > 0);
  if (b) b.click(); return !!b;
}, text);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));
  const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
  const task = JSON.parse(fs.readFileSync('artifacts/world-live-task.json'));
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    ...(phone ? { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
      : { viewport: { width: 1440, height: 900 } }),
  });
  await context.addInitScript(([job, task, phone]) => {
    if (phone) {
      const fake = proto => { const get = proto.getParameter; proto.getParameter = function (p) { if (p === 0x9246 || p === 0x1F01) return 'Apple GPU'; if (p === 0x9245 || p === 0x1F00) return 'Apple Inc.'; return get.call(this, p); }; };
      fake(WebGLRenderingContext.prototype); if (self.WebGL2RenderingContext) fake(WebGL2RenderingContext.prototype);
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 6 });
    }
    // 预置一件已有作品和它的世界（不花额度）
    if (!localStorage.getItem('ruhua-gallery-v1')) localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
    if (!localStorage.getItem('ruhua-world-v1')) localStorage.setItem('ruhua-world-v1', JSON.stringify({ [task.jobId]: task }));
  }, [job, task, phone]);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
  // 失败的 HTTP 响应记下地址（签名参数脱敏），便于定位是哪一步出错
  page.on('response', r => { if (r.status() >= 400 && !/\/warm$/.test(r.url())) errors.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(/(sig|expires)=[^&]+/g, '$1=…').slice(0, 160)}`); });
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|favicon/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
  // ERR_ABORTED 是页面主动取消的请求（切换页面、换场景时中止下载），不算故障
  page.on('requestfailed', r => { const why = r.failure()?.errorText || ''; if (!/\/warm$/.test(r.url()) && !/ERR_ABORTED/.test(why)) errors.push('requestfailed: ' + r.url().slice(0, 120) + ' ' + why); });
  const shot = name => page.screenshot({ path: path.join(OUT, name + '.png') }).catch(() => {});
  const t0 = Date.now();

  try {
    // 1 展示页
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction(() => !!document.querySelector('[class*=readyDot]'), null, { timeout: 120000 }); log('展示页 3D 场景就绪', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`); }
    catch { log('展示页 3D 场景就绪', false, '120 s 内没有就绪'); }
    await shot('01-landing');
    await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 30000 });
    await page.waitForTimeout(2500);
    log('直接进入主界面', await page.evaluate(() => !!document.querySelector('.nav-bar, nav')));
    await shot('02-home');

    // 2 概览页滚到底（各卡片渲染、无报错）
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 600) { await page.mouse.wheel(0, 600); await page.waitForTimeout(200); }
    await page.waitForTimeout(2500);
    await shot('03-home-bottom');
    await page.evaluate(() => scrollTo(0, 0));
    log('概览页滚动到底', true, `页面高 ${h}px`);

    // 3 上传照片 → 云端重建 → 工作室
    if (!skipUpload) {
      await visibleButton(page, '创作'); await page.waitForTimeout(1500);
      const cloud = page.getByRole('radio', { name: /云端/ });
      if (await cloud.count()) await cloud.first().click({ force: true }).catch(() => {});
      const start = Date.now();
      await page.setInputFiles('input[type=file]', PHOTO);
      const stages = new Set();
      let ok = false;
      while (Date.now() - start < 300000) {
        const s = await page.evaluate(() => ({
          studio: !!document.querySelector('[class*=viewer-mount] canvas') && /查看与编排场景/.test(document.body.innerText),
          stage: document.body.innerText.match(/(已排队[^\n]*|云端 GPU[^\n]*|正在[^\n]{2,24}|照片上传中[^\n]*|已接收[^\n]*)/)?.[0] || '',
          error: document.body.innerText.match(/(失败|出错|错误)[^\n]{0,40}/)?.[0] || '',
        }));
        if (s.stage) stages.add(s.stage);
        if (s.error && !s.studio) { log('上传与云端重建', false, s.error); break; }
        if (s.studio) { ok = true; break; }
        await page.waitForTimeout(1000);
      }
      if (ok) log('上传与云端重建', true, `${((Date.now() - start) / 1000).toFixed(1)} s；阶段：${[...stages].slice(0, 6).join(' / ')}`);
      else if (!results.find(r => r.step === '上传与云端重建')) log('上传与云端重建', false, `300 s 未进入工作室；阶段：${[...stages].join(' / ')}`);
      await page.waitForTimeout(5000);
      await shot('04-studio-new');
    }

    if (onlyUpload) return;
    // 4 工作室：打开预置作品，拖动、选运镜、（电脑）导出
    await visibleButton(page, '作品库'); await page.waitForTimeout(2500);
    const disc = page.getByRole('button', { name: /验收场景/ }).first();
    await disc.waitFor({ state: 'attached', timeout: 20000 });
    await disc.evaluate(el => el.click());
    await page.waitForTimeout(1200);
    // 选中光盘后出现「打开场景」
    const open = page.getByRole('button', { name: /打开场景/ }).first();
    await open.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await open.evaluate(el => el.click()).catch(() => {});
    try { await page.waitForFunction(() => !!document.querySelector('[class*=viewer-mount] canvas'), null, { timeout: 90000 }); log('作品库打开作品进入工作室', true); }
    catch { log('作品库打开作品进入工作室', false); }
    await page.waitForTimeout(8000);
    const canvas = page.locator('[class*=viewer-mount] canvas').first();
    const box = await canvas.boundingBox().catch(() => null);
    if (box) {
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 0; i < 20; i++) { await page.mouse.move(x + Math.sin(i / 4) * 60, y + Math.cos(i / 5) * 20); await page.waitForTimeout(40); }
      await page.mouse.up();
      log('工作室拖动视角', true);
    } else log('工作室拖动视角', false, '找不到画布');
    const preset = page.getByRole('button', { name: '缓推', exact: true });
    if (await preset.count()) { await preset.first().click({ force: true }); await page.waitForTimeout(3000); log('运镜预览（缓推）', await preset.first().getAttribute('aria-pressed') === 'true'); }
    else log('运镜预览（缓推）', false, '没有找到运镜按钮');
    await shot('05-studio');
    if (!skipExport) {
      const exp = page.getByRole('button', { name: /导出 mp4/ });
      if (await exp.count()) {
        const start = Date.now();
        const download = page.waitForEvent('download', { timeout: 240000 }).catch(() => null);
        await exp.first().click({ force: true });
        const d = await download;
        if (d) { const file = path.join(OUT, 'export.mp4'); await d.saveAs(file); log('导出 mp4', fs.statSync(file).size > 100000, `${((Date.now() - start) / 1000).toFixed(1)} s，${(fs.statSync(file).size / 1048576).toFixed(1)} MB`); }
        else log('导出 mp4', false, '240 s 内没有下载');
      } else log('导出 mp4', false, '没有找到导出按钮');
    }

    // 5 走进世界（已有世界，不花额度）
    await page.locator('#world-card').scrollIntoViewIfNeeded().catch(() => {});
    const ws = Date.now();
    const enter = page.locator('#world-card').getByRole('button', { name: /走进世界/ }).last();
    if (await enter.count()) {
      await enter.evaluate(el => el.click());
      try {
        await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label="走进世界"]')?.hasAttribute('data-ready'), null, { timeout: 120000 });
        log('走进世界（已有世界）', true, `${((Date.now() - ws) / 1000).toFixed(1)} s`);
        await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
        await page.waitForTimeout(1500); await shot('06-world');
        await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
        log('退出世界', !(await page.evaluate(() => !!document.querySelector('[role=dialog][aria-label="走进世界"]'))));
      } catch { log('走进世界（已有世界）', false, '120 s 内没有就绪'); await shot('06-world-fail'); }
    } else log('走进世界（已有世界）', false, '没有找到「走进世界」按钮');

    // 6 修图页能打开（不实际提交）
    await visibleButton(page, '修图'); await page.waitForTimeout(2500);
    log('修图页打开', await page.evaluate(() => /豆包修图|修图/.test(document.body.innerText) && !!document.querySelector('textarea, input[type=text]')));
    await shot('07-edit');

    // 7 鲸鱼娘问答（DeepSeek）
    const chip = page.locator('[aria-label="展开鲸鱼娘并聊天"], [aria-label*="鲸鱼娘"]').first();
    await chip.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
    if (await chip.count()) {
      await chip.evaluate(el => el.click()); await page.waitForTimeout(1500);
      const box2 = page.getByRole('textbox', { name: '给鲸鱼娘的消息' });
      await box2.fill('怎么把场景导出成视频？'); await box2.press('Enter');
      const qs = Date.now();
      try {
        // 对话记录里出现一条不是提问本身、且提到导出相关内容的回复
        await page.waitForFunction(() => {
          const log = document.querySelector('[aria-labelledby="whale-title"] [aria-live="polite"]');
          if (!log || log.querySelector('[aria-label="鲸鱼娘正在输入"]')) return false;
          const lines = [...log.querySelectorAll('p')].map(p => p.textContent || '').filter(t => t && t !== '怎么把场景导出成视频？');
          return lines.some(t => /导出|mp4|运镜|序列|WebCodecs/.test(t) && t.length > 12);
        }, null, { timeout: 90000 });
        log('鲸鱼娘回答', true, `${((Date.now() - qs) / 1000).toFixed(1)} s`);
      } catch { log('鲸鱼娘回答', false, '90 s 内没有相关回答'); }
      await page.waitForTimeout(2000); await shot('08-assistant');
    } else log('鲸鱼娘回答', false, '没有找到鲸鱼娘入口');
  } catch (error) {
    log('脚本异常', false, String(error.message || error).slice(0, 200));
    await shot('99-error');
  } finally {
    const failed = results.filter(r => !r.ok).length;
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ url: URL_BASE, phone, time: new Date().toISOString(), results, errors }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} passed; page errors: ${errors.length}`);
    for (const e of errors.slice(0, 15)) console.log('  ' + e);
    await browser.close();
    if (failed) process.exitCode = 1;
  }
})();
