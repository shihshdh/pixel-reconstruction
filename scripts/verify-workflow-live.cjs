const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://gausssharp.netlify.app');
    await page.getByRole('button', { name: '直接进入' }).click();
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    const figure = page.locator('.workflow-preview');
    await figure.scrollIntoViewIfNeeded();
    const stages = [];
    for (let i = 0; i < 7; i++) { stages.push(await figure.getAttribute('data-stage')); await page.waitForTimeout(1000); }
    assert.equal(new Set(stages).size, 3, 'Visible mobile workflow must automatically show all stages');
    await page.locator('.workflow-preview-controls').getByRole('button', { name: '场景', exact: true }).tap();
    await page.waitForTimeout(2400);
    assert.equal(await figure.getAttribute('data-stage'), '1');
    assert.equal(await figure.getAttribute('data-playing'), 'false');
    assert.deepEqual(errors, []);
    const report = { site: 'https://gausssharp.netlify.app', mobileAutoplay: true, stages, manualPause: true, errors };
    fs.writeFileSync('artifacts/live-workflow-check.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
