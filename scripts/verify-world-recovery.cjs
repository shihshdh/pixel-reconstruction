// 「走进世界」提交的两种失败：服务明确拒绝 → 回到发起前并显示原因；断网 → 继续等，凭 requestId 找回任务。
// 提交请求全部在浏览器里拦截，不会真的发到网关，不花 World Labs 额度。找回后的进度查询走真实网关，
// 用的是 artifacts/world-live-task.json 里已经生成好的那个任务（先跑过 verify-world-live.cjs）。
//   node scripts/verify-world-recovery.cjs        前提：npm run dev 在 3000 端口
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const report = { errors: [] };
(async () => {
  const job = JSON.parse(fs.readFileSync(process.env.JOB_FILE || 'artifacts/secure-job.json'));
  const known = JSON.parse(fs.readFileSync('artifacts/world-live-task.json'));
  assert.ok(known.operationId, '需要一个已生成的任务（先跑 verify-world-live.cjs）');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(job => {
      localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '验收场景', date: '2026/10/22', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], job.backend_url).href }]));
      localStorage.setItem('ruhua-world-model', 'marble-1.0-draft');
    }, job);
    // 先把提交挡住：任何情况下都不让 /world/generate 真的出去
    let mode = 'refuse', submitted = 0, lookups = 0;
    await context.route('**/world/generate', route => {
      submitted++;
      if (mode === 'refuse') return route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ detail: '世界模型的额度不够这一档（验收用的假回复）' }) });
      return route.abort('connectionreset');
    });
    await context.route('**/world/requests/**', route => {
      lookups++;
      const id = new URL(route.request().url()).pathname.split('/').pop();
      report.requestId = id;
      if (lookups < 3) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: '没有找到这次提交。' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operation_id: known.operationId, model: known.model }) });
    });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));

    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    await page.getByRole('button', { name: /直接进入/ }).click({ timeout: 60000 });
    await page.getByRole('button', { name: '作品库', exact: true }).first().click();
    const disc = page.getByRole('button', { name: /验收场景/ }).first();
    await disc.waitFor({ state: 'attached' });
    await disc.evaluate(element => element.click());
    const card = page.locator('#world-card');
    await card.waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#world-card [class*="demo"]'), null, { timeout: 30000 });
    const task = () => page.evaluate(id => JSON.parse(localStorage.getItem('ruhua-world-v1') || '{}')[id] || null, job.job_id);

    // 1) 服务明确拒绝
    await card.getByRole('button', { name: /创建场景/ }).click();
    await page.waitForFunction(() => /额度不够/.test(document.querySelector('#world-card')?.textContent || ''));
    report.refuse = { state: await card.getAttribute('data-state'), task: await task(), submitted };
    assert.equal(report.refuse.state, 'idle');
    assert.equal(report.refuse.task, null, '被拒绝后不应留下任务');

    // 2) 断网：继续等，找回任务后由真实网关报完成
    mode = 'drop';
    await card.getByRole('button', { name: /创建场景/ }).click();
    await page.waitForFunction(() => document.querySelector('#world-card')?.getAttribute('data-state') === 'pending', null, { timeout: 5000 });
    const pending = await task();
    report.drop = { pendingAfterDrop: pending?.status, operationIdBefore: pending?.operationId, requestId: pending?.requestId };
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.operationId, '');
    assert.match(pending?.requestId || '', /^req_[0-9a-f]{32}$/);
    await page.waitForFunction(() => document.querySelector('#world-card')?.getAttribute('data-state') === 'done', null, { timeout: 90000 });
    const done = await task();
    Object.assign(report.drop, { lookups, lookedUpSameId: report.requestId === pending.requestId, operationId: done?.operationId, worldId: done?.world?.id, status: done?.status });
    assert.equal(done?.operationId, known.operationId);
    assert.ok(lookups >= 3 && report.requestId === pending.requestId);
    assert.equal(submitted, 2, '每次点击只提交一次');
  } catch (error) {
    report.errors.push(error.message);
    if (page) await page.screenshot({ path: 'artifacts/world-recovery-error.png' }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    fs.writeFileSync('artifacts/world-recovery-check.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  }
})();
