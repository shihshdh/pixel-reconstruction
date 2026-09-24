// Exercise native mobile touch hit-testing, rather than desktop mouse emulation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const target = process.env.TEST_URL || 'http://127.0.0.1:3000';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    const retry = process.argv.includes('--retry');
    const slow = process.argv.includes('--slow');
    let failedProbe = false;
    if (retry) await page.route('**/scene/*.ksplat?*', route => {
      if (!failedProbe && route.request().method() === 'HEAD') {
        failedProbe = true;
        return route.fulfill({ status: 503, body: '' });
      }
      return route.continue();
    });
    const cdp = await context.newCDPSession(page);
    if (slow) await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 80, downloadThroughput: 250000, uploadThroughput: 250000,
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    if (retry) {
      await page.getByRole('button', { name: '重新载入 3D' }).click();
      assert(failedProbe, 'An actual failed availability probe triggers recovery');
      await page.getByRole('progressbar', { name: '三维场景载入进度' }).waitFor();
      console.log('Failed scene can be retried in place');
    }
    if (slow) {
      await page.waitForTimeout(36000);
      assert.equal(await page.getByRole('button', { name: '重新载入 3D' }).count(), 0, 'A progressing slow download must not fall back after the old 35s deadline');
      console.log('Slow download remains active after 36 seconds');
    }
    await page.getByText('实时 3D · 拖动探索', { exact: true }).waitFor({ timeout: 90000 });
    console.log('Mobile scene ready');
    await page.waitForTimeout(1600);
    const point = { x: 290, y: 400 };
    const hit = await page.evaluate(point => {
      const el = document.elementFromPoint(point.x, point.y);
      return { tag: el?.tagName, label: el?.getAttribute('aria-label'), className: el?.className };
    }, point);
    console.log('Touch target:', JSON.stringify(hit));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - i * 16, y: point.y }] });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(400);
    const exploring = await page.locator('[data-exploring]').getAttribute('data-exploring');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.screenshot({ path: 'artifacts/landing-touch.png' });
    const result = { target, retry, slow, hit, exploring, errors };
    fs.writeFileSync('artifacts/landing-touch-check.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    assert.equal(exploring, 'true', 'A native horizontal touch drag must reach and move the 3D scene');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
