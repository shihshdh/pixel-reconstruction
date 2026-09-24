// Real signed file requests, with one deliberately cut stream. No generation.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const api = process.env.BEAM_API_URL || 'https://ruhua-api-aa5d4d3-v16.app.beam.cloud';
const site = process.env.TEST_URL || 'https://gausssharp.netlify.app';
const report = { requests: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

(async () => {
  const job = JSON.parse(fs.readFileSync('artifacts/vectorized-speed-job.json'));
  const grant = await fetch(`${api}/files/${job.job_id}`, {
    headers: { 'X-Ruhua-Token': job.job_token }, signal: AbortSignal.timeout(90000),
  });
  assert.equal(grant.status, 200, 'Authenticated file grant');
  const files = (await grant.json()).file_urls;
  const path = new URL(files[job.viewer_file], api).pathname;
  const query = new URL(files[job.viewer_file], api).search;
  const url = site + path.replace(/^\/file\//, '/scene-file/') + query;
  let cut = false;
  const modules = new Map();
  const context = vm.createContext({
    Blob, Response, Headers, ReadableStream, Uint8Array, ArrayBuffer, DataView,
    DecompressionStream, AbortController, AbortSignal, DOMException, Error, TypeError, URL,
    performance, console,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); if (ms === 15000) timer.unref(); return timer; },
    clearTimeout,
    fetch: async (target, options) => {
      const response = await fetch(target, options);
      const record = { range: options?.headers?.Range || null, status: response.status,
        etagPresent: !!response.headers.get('etag'), contentRange: response.headers.get('content-range'), received: 0 };
      report.requests.push(record);
      if (![200, 206].includes(response.status)) return response;
      const reader = response.body.getReader();
      const interrupt = !cut && response.status === 200;
      const body = new ReadableStream({
        async pull(controller) {
          if (interrupt && record.received >= 1024 * 1024) {
            cut = true; report.interruptedAfterBytes = record.received;
            await reader.cancel();
            controller.error(new TypeError('Deliberate connection interruption'));
            return;
          }
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else { record.received += next.value.byteLength; controller.enqueue(next.value); }
          } catch (error) { controller.error(error); }
        },
        cancel(reason) { return reader.cancel(reason); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} }; modules.set(name, module);
    const source = fs.readFileSync(`lib/${name}.ts`, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const factory = vm.runInContext(`(function(require,module,exports){${code}\n})`, context);
    factory(specifier => load(specifier.replace(/^\.\//, '')), module, module.exports);
    return module.exports;
  }
  const start = performance.now();
  const blob = await load('asset-download').downloadAsset(url);
  const actual = Buffer.from(await blob.arrayBuffer());
  const reference = fs.readFileSync('artifacts/landing-preview.splat');
  assert.equal(actual.length, 37748736);
  assert.equal(digest(actual), digest(reference), 'Resumed scene must equal the full original scene byte for byte');
  assert.ok(report.requests.length <= 3, 'Retries remain bounded');
  const resumed = report.requests.filter(request => request.status === 206);
  assert.equal(resumed.length, 1, 'Exactly one successful resumed response');
  assert.equal(resumed[0].range, `bytes=${report.interruptedAfterBytes}-`);
  Object.assign(report, { restoredBytes: actual.length, sha256: digest(actual), exactFullQuality: true,
    seconds: (performance.now() - start) / 1000, transferredBytes: report.requests.reduce((sum, r) => sum + r.received, 0) });
  fs.writeFileSync('artifacts/full-resume-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => {
  report.error = String(error.message).replace(/https?:\/\/\S+/g, '[private URL omitted]');
  fs.writeFileSync('artifacts/full-resume-check.json', JSON.stringify(report, null, 2));
  console.error(report.error); process.exitCode = 1;
});
