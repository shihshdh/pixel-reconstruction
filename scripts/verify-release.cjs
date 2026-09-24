const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const target = process.env.TEST_URL || 'https://gausssharp.netlify.app';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const findings = [];
  try {
    for (const mobile of [false, true]) {
      const initial = await browser.newContext({ javaScriptEnabled: false, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
      const initialPage = await initial.newPage();
      await initialPage.goto(target);
      assert(await initialPage.locator('.landing-fallback img').isVisible(), 'Server-rendered scene poster is present before JavaScript');
      assert(!(await initialPage.locator('.showcase-workspace').isVisible()), 'Overview never flashes before scene hydration');
      await initial.close();
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, reducedMotion: mobile ? 'reduce' : 'no-preference' });
      const page = await context.newPage();
      const errors = [], blocked = [], videos = [], scenes = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) blocked.push(message.text()); });
      page.on('request', request => {
        if (request.url().includes('.mp4')) videos.push(request.url());
        if (request.url().includes('.ksplat') && request.method() === 'GET') scenes.push(request.url());
      });
      const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      assert((await page.title()).includes('Pixel Reconstruction'));
      if (target.startsWith('https:')) assert.equal(response.headers()['referrer-policy'], 'no-referrer');
      await page.getByText('实时 3D · 拖动探索', { exact: true }).waitFor({ timeout: 60000 });
      await page.waitForTimeout(1600);
      assert.equal(videos.length, 0, 'Intro must not download the four videos');
      assert(scenes.some(url => new URL(url).pathname.endsWith(mobile ? 'landing-lo.ksplat' : 'landing.ksplat')));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: mobile ? 'artifacts/live-mobile.png' : 'artifacts/live-home.png' });
      const introCopy = page.locator('[data-scene-copy="intro"]');
      const viewport = page.viewportSize();
      await page.mouse.move(viewport.width * .72, viewport.height * .6);
      await page.mouse.down();
      await page.mouse.move(viewport.width * .52, viewport.height * .6, { steps: 8 });
      await page.waitForTimeout(420);
      assert(Number(await introCopy.evaluate(el => getComputedStyle(el).opacity)) < .01, 'Scene movement hides central copy');
      await page.mouse.up();
      await page.waitForTimeout(1700);
      assert(Number(await introCopy.evaluate(el => getComputedStyle(el).opacity)) > .99, 'Idle scene restores central copy');
      await page.getByRole('button', { name: '向下探索，显示开始构建' }).click();
      await page.getByRole('button', { name: '开始构建，进入 Pixel Reconstruction 工作室' }).click();
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: mobile ? 'artifacts/live-mobile-overview.png' : 'artifacts/live-overview.png', fullPage: false });
      const workflowStages = [];
      for (let i = 0; i < 3; i++) {
        await page.locator('.workflow-step').nth(i).click();
        workflowStages.push(await page.locator('.workflow-preview').getAttribute('data-stage'));
      }
      assert.deepEqual(workflowStages, ['0', '1', '2']);
      await page.locator('nav').getByRole('button', { name: '创作', exact: true }).click();
      if (target.startsWith('https:')) assert.equal(await page.locator('#backend-url').count(), 0, 'Production must not expose backend configuration');
      await page.locator('nav').getByRole('button', { name: '修图', exact: true }).click();
      await page.getByRole('button', { name: /豆包修图服务/ }).click();
      await page.getByLabel('使用我的 API', { exact: true }).check();
      assert.equal(await page.locator('input[type=password]').count(), 1);
      await page.locator('#ruhua-nav-logo').click();
      await page.locator('[role=dialog]').waitFor({ state: 'visible' });
      await page.waitForTimeout(1100);
      await page.getByRole('button', { name: '直接进入' }).click();
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
      assert(await page.getByLabel('使用我的 API', { exact: true }).isChecked(), 'Logo round trip preserves settings');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      findings.push({ mobile, sceneLoaded: true, sceneCopyFade: true, workflowStages, logoRoundTrip: true, runtimeErrors: errors, cspErrors: blocked, overviewVideoRequests: [...new Set(videos)].length });
      await context.close();
    }
    fs.writeFileSync('artifacts/live-release-check.json', JSON.stringify(findings, null, 2));
    console.log(JSON.stringify(findings, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
