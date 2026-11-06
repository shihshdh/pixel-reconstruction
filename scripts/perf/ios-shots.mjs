// 答辩 PPT 用的 iPhone 截图：在 iOS 模拟器的 Safari 里打开网站，逐个功能截原生屏幕（含状态栏和 Safari 界面）。
// 在 GitHub Actions 的 macOS 机器上运行（.github/workflows/ios-shots.yml），不需要任何私有数据：
// 先用仓库里的 public/scene/louvre.jpg 经公开网关重建一个作品（一次 GPU 任务），再把它写进作品库。
// 不调用世界生成（World Labs 计费）；大肥鱼只问一句。
//   node scripts/perf/ios-shots.mjs --url https://pixel-reconstruction.netlify.app --api https://...beam.cloud
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (key, fallback) => { const n = process.argv.indexOf(key); return n < 0 ? fallback : process.argv[n + 1]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SITE = arg('--url', 'https://pixel-reconstruction.netlify.app').replace(/\/$/, '');
const API = arg('--api', process.env.BEAM_API || '').replace(/\/$/, '');
const OUT = path.resolve(arg('--out', 'artifacts/perf/ios-shots'));
const UDID = process.env.SIMULATOR_UDID || 'booted';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function reconstruct() {
  // 与网页 submitPhoto 相同：POST /generate（multipart），再带作品令牌轮询 /status
  const photo = await fs.readFile('public/scene/louvre.jpg');
  const fd = new FormData();
  fd.append('image', new Blob([photo], { type: 'image/jpeg' }), 'louvre.jpg');
  fd.append('render_video', 'false'); fd.append('enhance', 'false');
  const res = await fetch(API + '/generate', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('generate HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const accepted = await res.json();
  log('accepted job', accepted.job_id ? 'ok' : 'missing id');
  const started = Date.now();
  while (Date.now() - started < 9 * 60 * 1000) {
    await sleep(5000);
    const s = await fetch(API + '/status/' + encodeURIComponent(accepted.call_id), { headers: { 'X-Ruhua-Token': accepted.job_token } }).then(r => r.json()).catch(() => null);
    if (!s) continue;
    if (s.status === 'done') {
      log('reconstruction done in', Math.round((Date.now() - started) / 1000), 's');
      return { ...s, call_id: accepted.call_id, job_token: accepted.job_token, file_urls: { ...(accepted.file_urls || {}), ...(s.file_urls || {}) }, backend_url: API, submitted_at: new Date().toISOString() };
    }
    if (s.status === 'error' || s.status === 'failed') throw new Error('reconstruction failed: ' + (s.error || s.status));
  }
  throw new Error('reconstruction timed out');
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const report = { site: SITE, shots: [], errors: [] };
  const save = () => fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  let job = null;
  try { job = await reconstruct(); } catch (e) { report.errors.push({ step: 'reconstruct', message: String(e.message || e) }); log('reconstruct failed', e.message); }
  await save();

  const { Builder } = await import('selenium-webdriver');
  let session;
  for (let attempt = 1; attempt <= 3 && !session; attempt++) {
    try {
      session = await new Builder().usingServer('http://127.0.0.1:4444').withCapabilities({ browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true, 'safari:deviceType': 'iPhone', ...(process.env.SIMULATOR_UDID ? { 'safari:deviceUDID': process.env.SIMULATOR_UDID } : {}) }).build();
    } catch (error) {
      log('session attempt', attempt, 'failed', error.name);
      if (attempt === 3) throw error;
      try { execFileSync('xcrun', ['simctl', 'terminate', UDID, 'com.apple.mobilesafari'], { timeout: 20000, stdio: 'inherit' }); } catch {}
      execFileSync('xcrun', ['simctl', 'launch', UDID, 'com.apple.mobilesafari'], { timeout: 30000, stdio: 'inherit' });
      await sleep(5000);
    }
  }
  await session.manage().setTimeouts({ pageLoad: 120000, script: 30000, implicit: 0 });
  const js = (fn, ...a) => session.executeScript(fn, ...a);
  const waitFor = async (fn, ms = 60000, ...a) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(fn, ...a).catch(() => false)) return true; await sleep(400); } return false; };
  const clickText = (text) => js(t => { const b = [...document.querySelectorAll('button, [role=tab]')].find(x => x.textContent.replace(/\s+/g, '').includes(t) && x.getBoundingClientRect().width); if (b) b.click(); return !!b; }, text);
  const shot = async (name, note) => {
    await js(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()).catch(() => {});
    await sleep(900);
    const file = path.join(OUT, name + '.png');
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { execFileSync('xcrun', ['simctl', 'io', UDID, 'screenshot', file], { stdio: 'inherit', timeout: 120000 }); break; }
      catch (e) { if (attempt === 2) throw e; await sleep(3000); }
    }
    report.shots.push({ name, note }); await save(); log('shot', name);
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { report.errors.push({ step: name, message: String(e.message || e).slice(0, 300) }); await save(); log('step failed', name, e.message); } };

  // 深色主题；作品库里放刚重建的作品
  await session.get(SITE + '/?shots=1');
  await js((job, api) => {
    localStorage.setItem('ruhua-theme-v2', 'dark');
    if (job) localStorage.setItem('ruhua-gallery-v1', JSON.stringify([{ ...job, title: '卢浮宫', date: '2026/11/06', meta: 'Beam', thumb: new URL(job.file_urls['original.jpg'], api).href }]));
  }, job, API);
  await session.get(SITE + '/');

  await step('landing', async () => {
    await waitFor(() => !!document.querySelector('[class*=readyDot]'), 90000);
    await sleep(6000);
    await shot('01-landing', '展示页：单张照片重建的三维场景');
  });
  await step('enter', async () => {
    await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('直接进入')), 60000);
    await clickText('直接进入');
    await sleep(4000);
    await shot('02-home', '概览页');
  });
  if (job) {
    await step('gallery', async () => {
      await clickText('作品库'); await sleep(4000);
      await shot('03-gallery', '作品库');
    });
    await step('studio', async () => {
      await js(() => { const b = [...document.querySelectorAll('button')].find(x => /卢浮宫/.test(x.getAttribute('aria-label') || x.textContent)); if (b) b.click(); });
      await sleep(1500);
      await js(() => { const b = [...document.querySelectorAll('button')].find(x => /打开场景/.test(x.getAttribute('aria-label') || x.textContent)); if (b) b.click(); });
      await waitFor(() => !!document.querySelector('[class*=viewer-mount] canvas'), 90000);
      // 运镜按钮在场景载入完成前是禁用的：等它可用，说明三维场景已就绪
      const ready = await waitFor(() => { const b = document.querySelector('.rig-deck button'); return !!b && !b.disabled; }, 180000);
      report.sceneReady = ready; await save();
      await sleep(4000);
      await js(() => scrollTo(0, 0));
      await sleep(1500);
      await shot('04-studio', '工作室：三维场景');
    });
    await step('camera', async () => {
      const pick = name => js(n => { const b = [...document.querySelectorAll('.rig-deck button')].find(x => x.textContent.trim() === n); if (b && !b.disabled) { b.click(); return true; } return false; }, name);
      await js(() => { const d = document.querySelector('.rig-deck'); if (d) { d.scrollIntoView({ block: 'start' }); scrollBy(0, -150); } });
      await sleep(1500);
      report.picked = [await pick('环绕'), await pick('弧推'), await pick('螺旋')]; await save();
      await sleep(2500);
      await shot('05-camera', '工作室：运镜与序列');
      await js(() => { const b = document.querySelector('.pick-add'); if (b && !b.disabled) b.click(); });
      await sleep(2500);
      await js(() => { const e = document.querySelector('.pick-actions'); if (e) { e.scrollIntoView({ block: 'start' }); scrollBy(0, -60); } });
      await sleep(1800);
      await shot('06-sequence', '工作室：运镜序列与导出');
    });
    await step('world-card', async () => {
      await js(() => { const c = document.getElementById('world-card'); if (c) { c.scrollIntoView({ block: 'start' }); scrollBy(0, -70); } });
      await sleep(2000);
      await shot('07-world-card', '工作室：走进世界');
    });
  }
  await step('enhance', async () => {
    await clickText('修图'); await sleep(3500);
    await js(() => scrollTo(0, 0)); await sleep(800);
    await shot('08-enhance', '修图');
    await js(() => scrollBy(0, innerHeight * 0.75)); await sleep(1500);
    await shot('09-enhance-presets', '修图：预设');
  });
  await step('assist', async () => {
    if (job) { await clickText('工作室'); await sleep(3000); await js(() => scrollTo(0, 0)); }
    await js(() => { const c = document.querySelector('[aria-label="展开大肥鱼并聊天"], [aria-label="和大肥鱼聊天"]'); if (c) c.click(); });
    await waitFor(() => !!document.querySelector('textarea[aria-label="给大肥鱼的消息"]'), 20000);
    await sleep(2500);
    await shot('10-assist-open', '大肥鱼：对话框');
    // React 受控输入：用原生 setter 写值再派发 input 事件，然后点发送
    await js(text => {
      const t = document.querySelector('textarea[aria-label="给大肥鱼的消息"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, text);
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }, '导出视频要怎么操作？');
    await sleep(500);
    await js(() => { const f = document.querySelector('[data-assist-private] form'); const b = f && f.querySelector('button[type=submit]'); if (b) b.click(); });
    await waitFor(() => { const ps = [...document.querySelectorAll('[data-assist-private] [aria-live] p')]; return ps.length >= 2 && !document.querySelector('[data-assist-private] [role=status][aria-label="大肥鱼正在输入"]'); }, 90000);
    await sleep(16000); // 回答逐字显示完
    await shot('11-assist-reply', '大肥鱼：回答');
  });
  await session.quit().catch(() => {});
  log('done', report.shots.length, 'shots,', report.errors.length, 'errors');
  await save();
}
main().catch(async e => { console.error(e); process.exitCode = 1; });
