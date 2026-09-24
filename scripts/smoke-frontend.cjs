// Run against a running dev server or the exported site. Network jobs are mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
const output = path.resolve('artifacts');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const findings = [];
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, reducedMotion: mobile ? 'reduce' : 'no-preference' });
      await context.addInitScript(() => {
        localStorage.setItem('ruhua-backend-v3', 'https://test-api.invalid');
        localStorage.setItem('ruhua-source-url-beam', 'https://test-api.invalid');
      });
      const page = await context.newPage();
      const errors = [], videoRequests = [];
      let submitted = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().includes('.mp4')) videoRequests.push(request.url()); });
      await page.route('https://test-api.invalid/**', route => {
        const url = route.request().url();
        if (url.endsWith('/generate')) submitted++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.endsWith('/healthz') ? { ok: true, device: 'Beam test', enhance: true } : url.endsWith('/generate') ? { call_id: 'a'.repeat(32), job_id: 'a'.repeat(32) } : { status: 'queued', stage: '等待 GPU 唤醒' }) });
      });
      await page.goto(base, { waitUntil: 'networkidle' });
      assert.equal(videoRequests.length, 0, 'Intro should not load demo videos');
      await page.getByRole('button', { name: '直接进入' }).click();
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('三维世界'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No horizontal overflow');
      await page.screenshot({ path: path.join(output, mobile ? 'mobile-overview.png' : 'desktop-overview.png') });
      await page.locator('nav').getByRole('button', { name: '创作', exact: true }).click();
      await page.locator('input[type=file]').setInputFiles('artifacts/reference-original.jpg');
      await page.locator('.develop-painting canvas').waitFor();
      await page.waitForTimeout(2800);
      const portrait = await page.locator('.develop-painting canvas').boundingBox();
      assert(portrait.height > portrait.width * 1.3, 'Portrait processing must preserve portrait aspect ratio');
      assert(portrait.height > (mobile ? 330 : 500), 'Processing image should have a generous frame');
      await page.screenshot({ path: path.join(output, mobile ? 'mobile-processing.png' : 'desktop-processing.png'), fullPage: true });
      await page.locator('nav').getByRole('button', { name: '概览', exact: true }).click();
      await page.locator('nav').getByRole('button', { name: '创作', exact: true }).click();
      assert.equal(await page.locator('.develop-painting canvas').count(), 1, 'In-flight upload survives navigation');
      assert.equal(submitted, 1, 'Navigation must not submit another GPU job');
      assert.deepEqual(errors, [], 'No browser runtime exceptions');
      findings.push({ mobile, processing: portrait, errors, videoRequests: [...new Set(videoRequests)].length, submitted });
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'frontend-smoke.json'), JSON.stringify(findings, null, 2));
    console.log(JSON.stringify(findings, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });


