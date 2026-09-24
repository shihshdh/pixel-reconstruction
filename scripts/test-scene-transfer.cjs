const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Compile only this browser-only module in memory; tests need no extra dependency or server.
const source = fs.readFileSync(path.join(__dirname, '../lib/scene-transfer.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { unpackSceneTransfer, SCENE_TRANSFER_MIME } = loaded.exports;

const bytes = length => {
  const output = new Uint8Array(length);
  let seed = 421;
  for (let i = 0; i < length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; output[i] = seed >>> 24; }
  return output;
};
async function packet(raw, blockRows, transform) {
  const shuffled = new Uint8Array(raw.length);
  for (let first = 0; first < raw.length; first += blockRows * 32) {
    const rows = Math.min(blockRows, (raw.length - first) / 32);
    for (let lane = 0; lane < 32; lane++) for (let row = 0; row < rows; row++) {
      const offset = first + row * 32 + lane;
      shuffled[first + lane * rows + row] = raw[offset] ^ (transform === 2 && row ? raw[offset - 32] : 0);
    }
  }
  const compressed = await new Response(new Blob([shuffled]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const header = new Uint8Array(20);
  header.set(new TextEncoder().encode('PRSGZ001'));
  const fields = new DataView(header.buffer);
  fields.setUint32(8, raw.length, true); fields.setUint32(12, blockRows, true); fields.setUint32(16, transform, true);
  return new Blob([header, compressed], { type: SCENE_TRANSFER_MIME });
}
async function mutate(blob, offset, value) {
  const copy = new Uint8Array(await blob.arrayBuffer());
  new DataView(copy.buffer).setUint32(offset, value, true);
  return new Blob([copy]);
}
const rejectsChinese = blob => assert.rejects(unpackSceneTransfer(blob), error => error instanceof Error && /[\u3400-\u9fff]/.test(error.message));

(async () => {
  const checks = [];
  assert.equal(SCENE_TRANSFER_MIME, 'application/vnd.pixel-reconstruction.splat+gzip');
  for (const raw of [new Blob(), new Blob(['ply\nformat binary_little_endian 1.0\n']), new Blob(['PRSGZ00']), new Blob([bytes(128)], { type: 'application/octet-stream' })]) {
    assert.equal(await unpackSceneTransfer(raw), raw);
  }
  checks.push('legacy blobs retain exact identity and MIME');
  for (const transform of [1, 2]) for (const blockRows of [1, 7, 65536]) {
    const original = bytes((blockRows === 65536 ? 131079 : 23) * 32);
    const packed = await packet(original, blockRows, transform);
    const result = await unpackSceneTransfer(packed);
    assert.equal(result.type, 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), original);
    checks.push(`transform ${transform}, blockRows ${blockRows}: every byte and partial block match`);
  }
  const crossed = bytes(65539 * 32);
  assert.deepEqual(new Uint8Array(await (await unpackSceneTransfer(await packet(crossed, 7, 2))).arrayBuffer()), crossed);
  checks.push('small protocol blocks cross the 2 MiB output aggregation boundary without byte loss');
  const valid = await packet(bytes(64 * 32), 7, 2);
  for (const length of [8, 12, 19, 20]) await rejectsChinese(valid.slice(0, length));
  for (const length of [0, 33, 320 * 1024 * 1024 + 32]) await rejectsChinese(await mutate(valid, 8, length));
  for (const rows of [0, 65537]) await rejectsChinese(await mutate(valid, 12, rows));
  for (const transform of [0, 3, 0xffffffff]) await rejectsChinese(await mutate(valid, 16, transform));
  checks.push('truncated header, invalid size, block size and transform rejected in Chinese');
  await rejectsChinese(await mutate(valid, 8, 32));
  await rejectsChinese(await mutate(valid, 8, 65 * 32));
  checks.push('inflated overrun and underrun rejected');
  for (const index of [20, valid.size - 8, valid.size - 4]) {
    const corrupt = new Uint8Array(await valid.arrayBuffer()); corrupt[index] ^= 0x80;
    await rejectsChinese(new Blob([corrupt]));
  }
  await rejectsChinese(valid.slice(0, valid.size - 5));
  checks.push('bad gzip header, CRC, size footer and truncated gzip rejected');
  const before = new AbortController(); before.abort();
  await assert.rejects(unpackSceneTransfer(valid, before.signal), { name: 'AbortError' });
  const large = await packet(bytes(262151 * 32), 65536, 2);
  const during = new AbortController();
  const pending = unpackSceneTransfer(large, during.signal);
  setTimeout(() => during.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' });
  checks.push('pre-abort and in-flight cancellation reject with AbortError');
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 1);
  try { await unpackSceneTransfer(large); } finally { clearInterval(heartbeat); }
  assert(ticks > 0, 'The UI event loop must run during decoding');
  checks.push(`main thread yielded during decoding (${ticks} timer ticks)`);
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
