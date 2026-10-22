// 「走进世界」线上验收：真实网关 + 真实 World Labs。默认不花额度：只复用 artifacts/world-live-task.json
// 里上次生成好的世界；第一次要加 --generate 才会在工作室里点「创建场景」（速写，约 230 credits）。
//   node scripts/verify-world-live.cjs [--generate] [--headed]
// 前提：npm run dev 在 3000 端口（.env.local 指向带 world 的网关）；测试作品见 artifacts/secure-job.json。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const generate = process.argv.includes('--generate');
const headed = process.argv.includes('--headed');
const TASK_FILE = 'artifacts/world-live-task.json';
const strip = value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return value; } };
const report = { generated: false, errors: [], console: [] };

(async () => {
  const job = JSON.parse(fs.readFileSync(process.env.JOB_FILE || 'artifacts/secure-job.json'));
  const saved = fs.existsSync(TASK_FILE) ? JSON.parse(fs.readFileSync(TASK_FILE)) : null;
  assert.ok(saved || generate, `没有 ${TASK_FILE}：第一次请加 --generate（会花一次速写的额度）`);
  assert.ok(!(saved && generate), `已有 ${TASK_FILE}，复用它即可；真要再生成一次，先删掉这个文件`);
  const browser = await chromium.launch({ channel: 'msedge', headless: !headed, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const watchdog = setTimeout(() => { report.errors.push('超过 15 分钟总时限'); void browser.close(); }, 900000);
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(({ job, saved }) => {
      localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
      if (saved && !localStorage.getItem('ruhua-world-v1')) localStorage.setItem('ruhua-world-v1', JSON.stringify({ [saved.jobId]: saved }));
    }, { job, saved });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || message.text().includes('[world]')) report.console.push(message.type() + ': ' + message.text().slice(0, 300)); });
    page.on('response', response => { if (response.status() >= 400) report.console.push(`HTTP ${response.status()} ${strip(response.url())}`); });

    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    const skip = page.getByRole('button', { name: /直接进入/ });
    await skip.click({ timeout: 60000 });
    await page.locator('[role=dialog]').waitFor({ state: 'detached' }).catch(() => {});
    await page.getByRole('button', { name: '作品库', exact: true }).first().click();
    // 作品库默认是光盘架，光盘一直在转，Playwright 等不到“稳定”
    const disc = page.getByRole('button', { name: /验收场景/ }).first();
    await disc.waitFor({ state: 'attached' });
    await disc.evaluate(element => element.click());
    const card = page.locator('#world-card');
    await card.waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#world-card [class*="demo"]'), null, { timeout: 30000 })
      .catch(() => { throw new Error('卡片显示「演示模式」：网关的 /healthz 没有 world: true'); });

    if (!saved) {
      assert.equal(await card.getAttribute('data-state'), 'idle');
      const draft = card.getByRole('radio', { name: /速写/ });
      await draft.click();
      // 默认是「标准」（约 1580 credits）：确认真的选中了速写才提交
      await page.waitForFunction(() => localStorage.getItem('ruhua-world-model') === 'marble-1.0-draft');
      assert.equal(await draft.getAttribute('aria-checked'), 'true', '没能选中「速写」，不提交');
      await card.getByRole('button', { name: /创建场景/ }).click();
      report.generated = true;
      // 点下去界面应当立刻进入等待（任务先记下，提交在后台进行）
      await page.waitForFunction(() => document.querySelector('#world-card')?.getAttribute('data-state') !== 'idle', null, { timeout: 5000 });
      const pendingTask = await page.evaluate(id => JSON.parse(localStorage.getItem('ruhua-world-v1') || '{}')[id], job.job_id);
      fs.writeFileSync(TASK_FILE, JSON.stringify(pendingTask, null, 2));  // 中途出错也能凭它接着等，不再花额度
    }
    // 新生成的，或复用的（可能还在生成中，或只有 requestId 待找回）：等到完成
    const started = Date.now();
    for (;;) {
      const state = await card.getAttribute('data-state');
      if (state === 'done' || state === 'failed') break;
      if (state === 'idle') throw new Error('任务不见了：' + (await card.innerText()).replace(/\s+/g, ' ').slice(0, 200));
      if (Date.now() - started > 600000) throw new Error('10 分钟仍未生成完');
      await page.waitForTimeout(5000);
      console.log(`  ${Math.round((Date.now() - started) / 1000)}s · ${state}`);
    }
    report.waitSeconds = Math.round((Date.now() - started) / 1000);
    const task = await page.evaluate(id => JSON.parse(localStorage.getItem('ruhua-world-v1') || '{}')[id], job.job_id);
    if (task?.status === 'done' && !task.demo) fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2));
    report.task = task && { status: task.status, error: task.error, model: task.model, operationId: task.operationId, worldId: task.world?.id, caption: task.world?.caption,
      splats: Object.fromEntries(Object.entries(task.world?.splats || {}).map(([k, v]) => [k, strip(v)])), collider: task.world?.collider && strip(task.world.collider),
      metricScale: task.world?.metricScale, groundOffset: task.world?.groundOffset, marbleUrl: task.world?.marbleUrl };
    assert.equal(task?.status, 'done', '生成失败：' + (task?.error || '没有任务记录'));

    // 资源地址带签名会过期：走进世界时页面会重新取；这里先用缓存的地址试跨域
    report.cors = await page.evaluate(async world => {
      const probe = async url => {
        if (!url) return null;
        try { const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } }); return { status: r.status, bytes: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') }; }
        catch (error) { return { error: String(error.message || error) }; }
      };
      return { splat100k: await probe(world.splats['100k']), splat500k: await probe(world.splats['500k']), collider: await probe(world.collider), thumbnail: await probe(world.thumbnail) };
    }, task.world);

    await card.getByRole('button', { name: /走进世界/ }).last().click();
    const dialog = page.getByRole('dialog', { name: '走进世界' });
    await dialog.waitFor();
    const opened = Date.now();
    await page.waitForFunction(() => {
      const d = document.querySelector('[role=dialog][aria-label="走进世界"]');
      return d?.hasAttribute('data-ready') || /没能载入|失败|返回工作室/.test(d?.innerText || '');
    }, null, { timeout: 180000 });
    report.walk = { ready: await dialog.getAttribute('data-ready') !== null, seconds: (Date.now() - opened) / 1000, text: (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200) };
    if (report.walk.ready) {
      await page.waitForTimeout(2500);
      await page.screenshot({ path: 'artifacts/world-live-spawn.png' });
      // 往前走两秒，看碰撞与画面是否正常
      await page.mouse.move(720, 450); await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.up('KeyW');
      await page.waitForTimeout(800);
      await page.screenshot({ path: 'artifacts/world-live-walk.png' });
    } else {
      await page.screenshot({ path: 'artifacts/world-live-error.png' });
    }
    assert.ok(report.walk.ready, '漫游没有载入：' + report.walk.text);
  } catch (error) {
    report.errors.push(error.message);
    if (page) await page.screenshot({ path: 'artifacts/world-live-error.png' }).catch(() => {});
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
    fs.writeFileSync('artifacts/world-live-check.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  }
})();
