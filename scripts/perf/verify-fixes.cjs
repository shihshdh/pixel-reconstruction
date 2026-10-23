// 修复验收（不花 World Labs 额度；会花一次云端 GPU，约一分钱）：
//  1) 生成中的世界任务，operation 早已过期（>3 小时）：应当很快变成“已完成”，而不是停在最后一步
//  2) 走进世界：从点击到可走动的秒数；键盘 W 走动时画面在更新，停下后不再画
//  3) 上传一张照片：阶段文字、从上传到完成的秒数
//   node scripts/perf/verify-fixes.cjs [--url http://127.0.0.1:3202] [--photo <png>] [--no-upload]
const fs = require('node:fs');
const { chromium } = require('playwright');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const URL_BASE = arg('--url', 'http://127.0.0.1:3202');
const PHOTO = arg('--photo', 'C:/Users/ys221/Desktop/六张风景图_16比10/02_卢浮宫夜景.png');
const report = { url: URL_BASE, steps: {} };
(async () => {
  const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
  const done = JSON.parse(fs.readFileSync('artifacts/world-live-task.json'));
  // 同一个 operation，但记成“生成中”、5 小时前发起：operation 已过期
  const pending = { ...done, status: 'pending', world: undefined, started: Date.now() - 5 * 3600e3, checkedAt: undefined };
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--use-angle=d3d11'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ job, pending }) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
    localStorage.setItem('ruhua-world-v1', JSON.stringify({ [pending.jobId]: pending }));
  }, { job, pending });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(URL_BASE);
    await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '作品库' && b.getBoundingClientRect().width > 0)?.click());
    const disc = page.getByRole('button', { name: /验收场景/ }).first();
    await disc.waitFor({ state: 'attached' }); await disc.evaluate(e => e.click());
    const card = page.locator('#world-card'); await card.waitFor({ timeout: 60000 });
    let t = Date.now();
    await page.waitForFunction(() => document.querySelector('#world-card')?.getAttribute('data-state') !== 'pending', null, { timeout: 120000 });
    report.steps.expiredOperation = { state: await card.getAttribute('data-state'), seconds: (Date.now() - t) / 1000, text: (await card.innerText()).replace(/\s+/g, ' ').slice(0, 120) };
    console.log('expired operation →', report.steps.expiredOperation);
    await page.screenshot({ path: 'artifacts/perf/verify-world-card.png' });
    t = Date.now();
    await card.getByRole('button', { name: /走进世界/ }).last().evaluate(e => e.click());
    await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label="走进世界"]')?.hasAttribute('data-ready'), null, { timeout: 120000 });
    const ready = (Date.now() - t) / 1000;
    await page.waitForTimeout(2500);
    const canvas = page.locator('[role=dialog][aria-label="走进世界"] canvas').first();
    const frames = async ms => page.evaluate(ms => new Promise(resolve => {
      const c = document.querySelector('[role=dialog][aria-label="走进世界"] canvas'); const gl = c.getContext('webgl2'); let n = 0, last = -1;
      const draw = gl.drawArrays; gl.drawArrays = function () { const f = document.timeline.currentTime; if (f !== last) { last = f; n++; } return draw.apply(this, arguments); };
      const drawE = gl.drawElements; gl.drawElements = function () { const f = document.timeline.currentTime; if (f !== last) { last = f; n++; } return drawE.apply(this, arguments); };
      setTimeout(() => { gl.drawArrays = draw; gl.drawElements = drawE; resolve(n); }, ms);
    }), ms);
    const idle = await frames(2000);
    await canvas.click({ position: { x: 700, y: 450 } }).catch(() => {});
    await page.keyboard.down('KeyW');
    const walking = await frames(2000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(1500);
    const after = await frames(2000);
    const debug = await page.evaluate(() => document.querySelector('[role=dialog][aria-label="走进世界"]')?.innerText.replace(/\s+/g, ' ').slice(0, 160));
    report.steps.walk = { readySeconds: ready, framesIdle2s: idle, framesWalking2s: walking, framesAfterStop2s: after, ui: debug };
    console.log('walk →', report.steps.walk);
    await page.screenshot({ path: 'artifacts/perf/verify-walk.png' });
    await page.keyboard.press('Escape'); await page.waitForTimeout(800);
    if (!process.argv.includes('--no-upload')) {
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创作' && b.getBoundingClientRect().width > 0)?.click());
      await page.waitForTimeout(2000);
      const input = page.locator('input[type=file]').first();
      t = Date.now();
      await input.setInputFiles(PHOTO);
      const stages = []; let last = '';
      for (;;) {
        const text = await page.evaluate(() => document.querySelector('.develop-stage, [class*=stage]')?.textContent?.trim() || document.body.innerText.match(/(已排队[^\n]*|云端 GPU[^\n]*|正在[^\n]{2,20})/)?.[0] || '');
        if (text && text !== last) { stages.push([((Date.now() - t) / 1000).toFixed(1), text.slice(0, 60)]); last = text; }
        const doneNow = await page.evaluate(() => !!document.querySelector('#world-card') || /显影完成|作品已保存|进入工作室/.test(document.body.innerText));
        if (doneNow || Date.now() - t > 240000) break;
        await page.waitForTimeout(700);
      }
      report.steps.upload = { seconds: (Date.now() - t) / 1000, stages };
      console.log('upload →', report.steps.upload);
      await page.screenshot({ path: 'artifacts/perf/verify-upload.png' });
    }
  } catch (error) { report.error = String(error.message || error).slice(0, 500); console.log('ERROR', report.error); }
  report.pageErrors = errors;
  fs.writeFileSync('artifacts/perf/verify-fixes.json', JSON.stringify(report, null, 2));
  await browser.close();
})();
