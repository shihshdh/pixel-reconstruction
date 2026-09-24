// Read-only live validation. Tokens/signatures stay in ignored artifacts, never logs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const vm = require('node:vm');
const api = process.env.BEAM_API_URL || 'https://ruhua-api-aa5d4d3-v10.app.beam.cloud';
const site = process.env.TEST_URL || 'https://gausssharp.netlify.app';
const sourceFile = process.env.JOB_FILE || 'artifacts/vectorized-speed-job.json';
const MIME = 'application/vnd.pixel-reconstruction.splat+gzip';
async function get(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetch(url, { ...options, signal: AbortSignal.timeout(90000) });
    if (![502, 503, 504].includes(result.status) || attempt === 2) return result;
    await result.body?.cancel();
  }
}
(async () => {
  const job = JSON.parse(fs.readFileSync(sourceFile));
  const started = performance.now();
  const query = '?preview=mobile&source=' + encodeURIComponent(job.viewer_file);
  const denied = await get(`${api}/files/${job.job_id}${query}`);
  assert.equal(denied.status, 403);
  const response = await get(`${api}/files/${job.job_id}${query}`, { headers: { 'X-Ruhua-Token': job.job_token } });
  assert.equal(response.status, 200);
  const prepared = await response.json();
  const preview = prepared.mobile_preview;
  assert(preview.splat_count <= 147456 && preview.viewer_bytes === preview.splat_count * 32);
  assert.equal(preview.source_file, job.viewer_file);
  const mobileJob = { ...job, backend_url: api, mobile_viewer_file: prepared.mobile_viewer_file, file_urls: prepared.file_urls };
  fs.writeFileSync('artifacts/mobile-ready-job.json', JSON.stringify(mobileJob, null, 2));
  const prepareSeconds = (performance.now() - started) / 1000;
  if (process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({ prepareSeconds, preview, unauthorized: denied.status })); return;
  }
  const relative = prepared.file_urls[prepared.mobile_viewer_file].replace(/^\/file\//, '/scene-file/');
  const relay = site + relative;
  const range = await get(relay, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  assert.match(range.headers.get('cache-control'), /private.*no-store/);
  const downloadStarted = performance.now();
  const packed = await get(relay, { headers: { Accept: MIME } });
  assert.equal(packed.status, 200); assert.equal(packed.headers.get('content-type'), MIME);
  const headersSeconds = (performance.now() - downloadStarted) / 1000;
  const packet = await packed.blob();
  const downloadSeconds = (performance.now() - downloadStarted) / 1000;
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('lib/scene-transfer.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports: module.exports, module, Blob, Response, DecompressionStream, Uint8Array, DataView, ArrayBuffer, DOMException, performance, setTimeout, clearTimeout });
  const decoded = await module.exports.unpackSceneTransfer(packet);
  assert.equal(decoded.size, preview.viewer_bytes);
  const direct = await get(new URL(prepared.file_urls[prepared.mobile_viewer_file], api));
  assert.equal(direct.status, 200);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const decodedHash = hash(Buffer.from(await decoded.arrayBuffer()));
  assert.equal(decodedHash, hash(Buffer.from(await direct.arrayBuffer())));
  const tampered = new URL(relay); tampered.searchParams.set('sig', '0'.repeat(64));
  const bad = await get(tampered); assert.equal(bad.status, 403);
  const findings = { site, prepareSeconds, headersSeconds, downloadSeconds, fullRawBytes: preview.source_bytes, mobileRawBytes: decoded.size, mobileWireBytes: packet.size, reductionPercent: +(100 * (1 - packet.size / 27647024)).toFixed(1), sha256: decodedHash, range: range.status, unauthorized: bad.status, relayByteIdentity: true };
  fs.writeFileSync('artifacts/mobile-delivery-check.json', JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
