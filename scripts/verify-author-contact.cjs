// Author-card UI QA only. Does not submit jobs or contact the author.
// TEST_URL defaults to an already-running http://127.0.0.1:3000 site.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.TEST_URL || 'http://127.0.0.1:3000';
const report = { site: new URL(base).origin, results: [] };
const redact = value => String(value).replace(/https?:\/\/[^\s'"<>]+/g, url => {
  try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return '[URL]'; }
});
fs.mkdirSync('artifacts', { recursive: true });
const save = () => fs.writeFileSync('artifacts/author-contact-audit.json', JSON.stringify(report, null, 2));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const mode of ['desktop', 'mobile', 'reduced']) {
      const mobile = mode === 'mobile';
      const findings = { mode, phase: 'setup', requests: [], errors: [], status: 'RUNNING' };
      report.results.push(findings);
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: mobile, hasTouch: mobile,
        reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference',
      });
      await context.addInitScript(() => {
        window.__authorCopies = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async value => { window.__authorCopies.push(value); } },
        });
        // Pause only explicitly requested author-card transitions. Sampling the
        // animation clock avoids a slow CI machine skipping the intermediate
        // frame between a click and the next Playwright evaluation.
        window.__authorMotion = [];
        window.__authorMotionFades = [];
        window.__authorCaptureMotion = null;
        const nativeAnimate = Element.prototype.animate;
        Element.prototype.animate = function(keyframes, options) {
          const phase = window.__authorCaptureMotion;
          const capture = phase && this.matches?.('[role="dialog"][aria-labelledby="author-contact-name"]');
          const resting = capture ? this.getBoundingClientRect() : null;
          const trigger = capture ? document.querySelector('button[aria-label="联系作者"]')?.getBoundingClientRect() : null;
          const animation = nativeAnimate.call(this, keyframes, options);
          if (capture) {
            const duration = Number(typeof options === 'number' ? options : options?.duration);
            const sample = phase === 'exit' ? .5 : phase === 'interrupted-entry' ? .12 : .28;
            animation.pause(); animation.currentTime = duration * sample;
            window.__authorMotion.push({
              phase, animation, element: this, duration,
              expected: resting && trigger ? {
                dx: trigger.left + trigger.width / 2 - resting.left - resting.width / 2,
                dy: trigger.top + trigger.height / 2 - resting.top - resting.height / 2,
                sx: Math.max(.035, trigger.width / resting.width),
                sy: Math.max(.035, trigger.height / resting.height),
              } : null,
            });
          } else if (phase === 'exit' && this.matches?.('[data-author-contact]')) {
            // Keep the parent scrim visible while its child close transform is
            // paused; otherwise its independent 300ms fade can hide the frame.
            const duration = Number(typeof options === 'number' ? options : options?.duration);
            animation.pause(); animation.currentTime = duration / 2;
            window.__authorMotionFades.push({ phase, animation });
          }
          return animation;
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => findings.errors.push({ type: 'pageerror', message: redact(error.message) }));
      page.on('console', message => {
        if (message.type() === 'error') findings.errors.push({ type: 'console', message: redact(message.text()) });
      });
      page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/author/')) findings.requests.push({ phase: findings.phase, path: pathname });
      });
      // Health does not affect this card; keep this UI test independent of GPU
      // startup, credentials and external backend availability.
      await page.route('**/healthz', route => route.fulfill({ json: { ok: true, serverless: true, enhance: true } }));
      try {
        findings.phase = 'before-open';
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        const landing = page.getByRole('dialog', { name: 'Pixel Reconstruction，三维场景体验' });
        await page.getByRole('button', { name: '直接进入' }).click();
        await landing.waitFor({ state: 'detached' });
        const trigger = page.getByRole('button', { name: '联系作者', exact: true });
        await trigger.waitFor({ state: 'visible' });
        await page.waitForTimeout(900);
        assert.deepEqual(findings.requests, [], 'Author images must not be requested before the first open');
        findings.lazyBeforeOpen = true;
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        const triggerBox = await trigger.boundingBox();
        assert(triggerBox && triggerBox.width > 0 && triggerBox.height > 0);
        assert(triggerBox.x >= 0 && triggerBox.x + triggerBox.width <= (mobile ? 390 : 1440) + 1, 'Contact trigger is visible within the viewport');
        if (mobile) assert(triggerBox.width <= 40, 'Mobile contact trigger stays compact');
        await page.evaluate(() => {
          window.scrollTo(0, 160);
          window.__authorBefore = {
            overflow: document.body.style.overflow,
            padding: document.body.style.paddingRight,
            scroll: window.scrollY,
            siblings: Array.from(document.body.children).filter(node => node instanceof HTMLElement).map(node => ({ node, inert: node.inert })),
          };
        });
        await page.waitForTimeout(120);
        findings.phase = 'open';
        if (mode !== 'reduced') await page.evaluate(() => { window.__authorCaptureMotion = 'entry'; });
        await trigger.click();
        const overlay = page.locator('[data-author-contact]');
        const dialog = page.getByRole('dialog', { name: '适合刺猹', exact: true });
        await dialog.waitFor({ state: 'visible' });
        if (mode === 'reduced') {
          const animations = await dialog.evaluate(element => element.getAnimations({ subtree: true }).map(animation => ({
            duration: animation.effect?.getTiming().duration,
            transforms: animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes().map(frame => frame.transform).filter(Boolean) : [],
          })));
          assert(animations.every(animation => typeof animation.duration !== 'number' || animation.duration <= 150), 'Reduced-motion transitions are short');
          assert(animations.every(animation => animation.transforms.every(transform => transform === 'none')), 'Reduced motion fades without travel');
          findings.reducedAnimations = animations;
        }
        await page.waitForFunction(() => {
          const images = Array.from(document.querySelectorAll('[data-author-contact] img'));
          return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
        });
        if (mode !== 'reduced') {
          await page.waitForFunction(() => window.__authorMotion.some(record => record.phase === 'entry'));
          const entry = await page.evaluate(() => {
            const record = window.__authorMotion.find(item => item.phase === 'entry');
            const frames = record.animation.effect.getKeyframes();
            const origin = new DOMMatrixReadOnly(frames[0].transform);
            return {
              duration: record.duration,
              keyframes: frames.map(frame => ({ transform: frame.transform, opacity: frame.opacity, offset: frame.computedOffset })),
              expected: record.expected,
              origin: { dx: origin.m41, dy: origin.m42, sx: origin.m11, sy: origin.m22 },
              sampleTime: record.animation.currentTime,
              sampledTransform: getComputedStyle(record.element).transform,
              playState: record.animation.playState,
            };
          });
          assert(Math.abs(entry.duration - 620) <= 10, 'Normal entry uses the intended ~620ms transition');
          assert.equal(entry.keyframes.at(-1).transform, 'none', 'Entry ends at the card resting transform');
          for (const dimension of ['dx', 'dy', 'sx', 'sy']) assert(Math.abs(entry.origin[dimension] - entry.expected[dimension]) < .002, `Entry ${dimension} comes from the trigger rectangle`);
          assert(entry.sampleTime > 0 && entry.sampleTime < entry.duration && entry.sampledTransform !== 'none', 'Entry sample captures an actual intermediate transform');
          assert.equal(entry.playState, 'paused');
          await page.screenshot({ path: `artifacts/author-${mode}-entry.png` });
          findings.motion = { entry };
          await page.evaluate(() => { window.__authorCaptureMotion = null; window.__authorMotion.find(record => record.phase === 'entry').animation.play(); });
        }
        await page.waitForTimeout(mode === 'reduced' ? 220 : 750);
        const images = await dialog.locator('img').evaluateAll(elements => elements.map(image => ({ path: new URL(image.src).pathname, width: image.naturalWidth, height: image.naturalHeight })));
        assert.deepEqual(images.map(image => image.path).sort(), ['/author/avatar.jpg', '/author/background.jpg']);
        assert.equal(await dialog.locator('h2').innerText(), '适合刺猹');
        assert.equal(await dialog.getByRole('textbox', { name: '作者微信号' }).inputValue(), 'x13307341565');
        const box = await dialog.boundingBox();
        assert(box && box.x >= 15 && box.x + box.width <= (mobile ? 390 : 1440) - 15, 'Card keeps viewport side margins');
        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth > innerWidth,
          overlay: document.querySelector('[data-author-contact]').scrollWidth > innerWidth,
          locked: document.body.style.overflow === 'hidden',
          siblingsInert: window.__authorBefore.siblings.filter(item => item.node.isConnected).every(item => item.node.inert),
        }));
        assert.deepEqual(overflow, { document: false, overlay: false, locked: true, siblingsInert: true });
        await page.screenshot({ path: `artifacts/author-${mode}.png` });
        findings.images = images; findings.cardBounds = box; findings.triggerBounds = triggerBox;

        findings.phase = 'keyboard-and-copy';
        const close = dialog.getByRole('button', { name: '关闭作者卡片' });
        const field = dialog.getByRole('textbox', { name: '作者微信号' });
        const copy = dialog.getByRole('button', { name: '复制微信号' });
        await close.focus();
        await page.keyboard.press('Shift+Tab');
        assert(await copy.evaluate(element => element === document.activeElement), 'Shift+Tab wraps to the final control');
        await page.keyboard.press('Tab');
        assert(await close.evaluate(element => element === document.activeElement), 'Tab wraps to the first control');
        await page.keyboard.press('Tab');
        assert(await field.evaluate(element => element === document.activeElement));
        await copy.click();
        await page.waitForFunction(() => window.__authorCopies.length === 1);
        assert.deepEqual(await page.evaluate(() => window.__authorCopies), ['x13307341565'], 'Clipboard receives the exact WeChat identifier');
        await dialog.getByRole('status').filter({ hasText: '微信号已复制' }).waitFor();
        findings.exactClipboard = true; findings.focusTrap = true;

        // Force both clipboard paths to fail: the UI must offer real selection
        // and manual copying, without claiming clipboard success.
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } });
          window.__authorExecCommand = document.execCommand;
          document.execCommand = () => false;
        });
        await copy.click();
        await dialog.getByRole('status').filter({ hasText: '微信号已选中' }).waitFor();
        const selection = await field.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, length: element.value.length }));
        assert.equal(selection.start, 0); assert.equal(selection.end, selection.length);
        assert(!/已复制/.test(await dialog.getByRole('status').innerText()), 'Denied clipboard must not show copied');
        await page.evaluate(() => { document.execCommand = window.__authorExecCommand; });
        findings.clipboardDeniedFallback = true;

        findings.phase = 'escape-close';
        if (mode !== 'reduced') await page.evaluate(() => { window.__authorCaptureMotion = 'exit'; });
        await page.keyboard.press('Escape');
        if (mode !== 'reduced') {
          await page.waitForFunction(() => window.__authorMotion.some(record => record.phase === 'exit'));
          const exit = await page.evaluate(() => {
            const record = window.__authorMotion.find(item => item.phase === 'exit');
            const frames = record.animation.effect.getKeyframes();
            const target = new DOMMatrixReadOnly(frames.at(-1).transform);
            return {
              duration: record.duration,
              keyframes: frames.map(frame => ({ transform: frame.transform, opacity: frame.opacity, offset: frame.computedOffset })),
              expected: record.expected,
              target: { dx: target.m41, dy: target.m42, sx: target.m11, sy: target.m22 },
              sampleTime: record.animation.currentTime,
              sampledTransform: getComputedStyle(record.element).transform,
              playState: record.animation.playState,
            };
          });
          assert(Math.abs(exit.duration - 330) <= 10, 'Normal close uses the intended reverse transition');
          for (const dimension of ['dx', 'dy', 'sx', 'sy']) assert(Math.abs(exit.target[dimension] - exit.expected[dimension]) < .002, `Close ${dimension} returns to the trigger rectangle`);
          assert(exit.sampleTime > 0 && exit.sampleTime < exit.duration && exit.sampledTransform !== 'none', 'Close sample captures an actual intermediate transform');
          assert.equal(exit.playState, 'paused');
          await page.screenshot({ path: `artifacts/author-${mode}-exit.png` });
          findings.motion.exit = exit;
          await page.evaluate(() => {
            window.__authorCaptureMotion = null;
            window.__authorMotion.find(record => record.phase === 'exit').animation.play();
            window.__authorMotionFades.filter(record => record.phase === 'exit').forEach(record => record.animation.play());
          });
        }
        await overlay.waitFor({ state: 'detached' });
        assert(await trigger.evaluate(element => element === document.activeElement), 'Closing restores trigger focus');
        const restored = await page.evaluate(() => ({
          overflow: document.body.style.overflow === window.__authorBefore.overflow,
          padding: document.body.style.paddingRight === window.__authorBefore.padding,
          inert: window.__authorBefore.siblings.filter(item => item.node.isConnected).every(item => item.node.inert === item.inert),
          scroll: Math.abs(window.scrollY - window.__authorBefore.scroll) < 2,
        }));
        assert.deepEqual(restored, { overflow: true, padding: true, inert: true, scroll: true }, 'Closing restores page state');
        findings.restore = restored;

        findings.phase = 'backdrop-close';
        await trigger.click();
        await dialog.waitFor({ state: 'visible' });
        await page.waitForTimeout(mode === 'reduced' ? 180 : 700);
        await page.mouse.click(5, 5);
        await overlay.waitFor({ state: 'detached' });
        assert(await trigger.evaluate(element => element === document.activeElement));
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        findings.backdropClose = true;
        if (mode !== 'reduced') {
          findings.phase = 'interrupted-entry';
          await page.evaluate(() => { window.__authorCaptureMotion = 'interrupted-entry'; });
          await trigger.click();
          await dialog.waitFor({ state: 'visible' });
          await page.waitForFunction(() => window.__authorMotion.some(record => record.phase === 'interrupted-entry'));
          // The opening card is held 12% into its animation, so Escape always
          // interrupts a genuinely unfinished transition regardless of load.
          await page.evaluate(() => { window.__authorCaptureMotion = null; });
          await page.keyboard.press('Escape');
          await overlay.waitFor({ state: 'detached' });
          const interrupted = await page.evaluate(() => ({
            overlayCount: document.querySelectorAll('[data-author-contact]').length,
            inertRestored: window.__authorBefore.siblings.filter(item => item.node.isConnected).every(item => item.node.inert === item.inert),
            overflowRestored: document.body.style.overflow === window.__authorBefore.overflow,
            paddingRestored: document.body.style.paddingRight === window.__authorBefore.padding,
            focusRestored: document.activeElement?.getAttribute('aria-label') === '联系作者',
            entryCanceled: window.__authorMotion.find(record => record.phase === 'interrupted-entry').animation.playState === 'idle',
          }));
          assert.deepEqual(interrupted, { overlayCount: 0, inertRestored: true, overflowRestored: true, paddingRestored: true, focusRestored: true, entryCanceled: true }, 'Closing during entry cleans up portal, animation, inert state and focus');
          findings.motion.interruptedEntry = interrupted;
        }
        assert.deepEqual(findings.errors, [], 'No page or console errors');
        findings.phase = 'complete'; findings.status = 'PASS';
        save();
        console.log(JSON.stringify({ mode, status: 'PASS', lazyBeforeOpen: true, images: images.map(image => image.path), focusRestore: true, clipboard: true }));
      } catch (error) {
        findings.status = 'FAIL'; findings.failure = redact(error.stack || error.message);
        try {
          await page.screenshot({ path: `artifacts/author-${mode}-failure.png` });
          findings.failureState = await page.evaluate(() => {
            const dialog = document.querySelector('[data-author-contact] [role="dialog"]');
            const bounds = dialog?.getBoundingClientRect();
            const focused = document.activeElement;
            return {
              viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
              bodyOverflow: document.body.style.overflow,
              dialog: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
              focus: { tag: focused?.tagName, label: focused?.getAttribute('aria-label') },
              authorImages: Array.from(document.querySelectorAll('[data-author-contact] img')).map(image => ({ path: new URL(image.src).pathname, complete: image.complete, width: image.naturalWidth })),
              inertSiblings: Array.from(document.body.children).filter(element => element instanceof HTMLElement && element.inert).length,
            };
          });
        } catch { /* Keep the original diagnostic even if the browser closes. */ }
        save();
        console.error(JSON.stringify({ mode, phase: findings.phase, status: 'FAIL', message: redact(error.message), report: 'artifacts/author-contact-audit.json' }));
        process.exitCode = 1;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); save(); }
})().catch(error => { report.failure = redact(error.stack || error.message); save(); console.error(redact(error.message)); process.exitCode = 1; });
