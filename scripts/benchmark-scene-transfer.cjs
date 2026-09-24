// Read an existing private work in both representations; never submit a GPU job.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { chromium } = require('playwright');
const job = JSON.parse(fs.readFileSync('artifacts/speed-job.json', 'utf8'));
const base = process.env.BEAM_API_URL || job.backend_url;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // HTTPS document without a 3D scene or videos competing for the test link.
    await page.goto('https://gausssharp.netlify.app/404.html');
    const compiled = ts.transpileModule(fs.readFileSync('lib/scene-transfer.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    await page.addScriptTag({ content: '(()=>{const exports={};' + compiled + ';window.unpackSceneTransfer=exports.unpackSceneTransfer;})();' });
    const url = await page.evaluate(async ({ base, job }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(base + '/files/' + job.job_id, { headers: { 'X-Ruhua-Token': job.job_token }, signal: AbortSignal.timeout(60000) });
        if ([502, 503, 504].includes(response.status) && attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        if (!response.ok) throw new Error('File listing HTTP ' + response.status);
        const files = await response.json();
        return new URL(files.file_urls[job.viewer_file], base).href;
      }
    }, { base, job });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 1000000, uploadThroughput: 1000000 });
    const results = [];
    for (const packed of [false, true]) {
      const sample = await page.evaluate(async ({ url, packed }) => {
        const start = performance.now();
        let response, retries = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetch(url, { ...(packed ? { headers: { Accept: 'application/vnd.pixel-reconstruction.splat+gzip' } } : {}), signal: AbortSignal.timeout(180000) });
          if (![502, 503, 504].includes(response.status) || attempt === 2) break;
          retries++;
          await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
        }
        const headersAt = performance.now();
        if (!response.ok) throw new Error('Scene download HTTP ' + response.status);
        const wire = await response.blob();
        const downloadedAt = performance.now();
        const scene = await window.unpackSceneTransfer(wire);
        const readyAt = performance.now();
        const digest = await crypto.subtle.digest('SHA-256', await scene.arrayBuffer());
        return { packed, retries, wireBytes: wire.size, sceneBytes: scene.size, contentType: response.headers.get('content-type'), ttfbSeconds: (headersAt - start) / 1000, bodySeconds: (downloadedAt - headersAt) / 1000, unpackSeconds: (readyAt - downloadedAt) / 1000, totalSeconds: (readyAt - start) / 1000, hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
      }, { url, packed });
      results.push(sample);
      console.log(JSON.stringify({ ...sample, hash: undefined }));
    }
    assert.equal(results[0].hash, results[1].hash, 'Both representations must restore identical scene bytes');
    assert(results[1].wireBytes < results[0].wireBytes * .95, 'Negotiated response must reduce traffic');
    const report = { network: '8 Mbps, 80 ms simulated latency', api: new URL(base).hostname, identical: true, savedFraction: 1 - results[1].wireBytes / results[0].wireBytes, results };
    fs.writeFileSync('artifacts/scene-transfer-live-benchmark.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ identical: true, savedFraction: report.savedFraction }));
  } finally { await browser.close(); }
})().catch(error => { console.error(String(error.message).replace(/https?:\/\/\S+/g, '[URL redacted]')); process.exitCode = 1; });
