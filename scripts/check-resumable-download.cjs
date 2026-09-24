// Offline protocol checks against the real downloader; virtual time, no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { gzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const MIME = 'application/vnd.pixel-reconstruction.splat+gzip';
const checks = [];
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

function virtualClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, delay = 0) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (let guard = 0; ; guard++) {
        assert.ok(guard < 1000, 'Unexpected timer loop');
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= target);
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick();
      }
      now = target; await tick();
    },
  };
}

function load(fetchMock, compression = false) {
  const clock = virtualClock(), cache = new Map();
  const context = vm.createContext({
    Blob, Response, Headers, Request, ReadableStream, Uint8Array, ArrayBuffer, DataView,
    TextEncoder, TextDecoder, AbortController, AbortSignal: {}, DOMException, Error, TypeError,
    DecompressionStream: compression ? DecompressionStream : undefined,
    performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, fetch: fetchMock,
  });
  function moduleFor(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module);
    const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: relative,
    }).outputText;
    const factory = vm.runInContext('(function(require,module,exports){\n' + compiled + '\n})', context, { filename: relative });
    factory(specifier => {
      assert.ok(['./abort', './scene-transfer'].includes(specifier));
      return moduleFor('lib/' + specifier.slice(2) + '.ts');
    }, module, module.exports);
    return module.exports;
  }
  return { ...moduleFor('lib/asset-download.ts'), clock };
}

function streamResponse({ status = 200, total = 10, type = 'application/octet-stream', etag = '"same-bytes"', range, encoding } = {}) {
  let controller, cancellations = 0;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancellations++; } });
  const headers = { 'Content-Type': type };
  if (total !== null) headers['Content-Length'] = String(total);
  if (etag !== null) headers.ETag = etag;
  if (range) headers['Content-Range'] = range;
  if (encoding) headers['Content-Encoding'] = encoding;
  return {
    response: new Response(body, { status, headers }),
    push(data) { controller.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : data); },
    end() { controller.close(); }, fail() { controller.error(new TypeError('Simulated offline interruption')); },
    get cancellations() { return cancellations; },
  };
}

function complete(data, options = {}) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const item = streamResponse({ total: bytes.length, ...options }); item.push(bytes); item.end(); return item.response;
}

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Check remained pending')), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function test(name, action) {
  try { await bounded(action()); checks.push(name); }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

function packed(bytes) {
  const header = Buffer.alloc(20); header.write('PRSGZ001');
  header.writeUInt32LE(bytes.length, 8); header.writeUInt32LE(65536, 12); header.writeUInt32LE(1, 16);
  const rows = bytes.length / 32, shuffled = Buffer.alloc(bytes.length);
  for (let lane = 0; lane < 32; lane++) for (let row = 0; row < rows; row++) shuffled[lane * rows + row] = bytes[row * 32 + lane];
  return Buffer.concat([header, gzipSync(shuffled)]);
}

(async () => {
  await test('steady slow progress survives the former three-minute deadline', async () => {
    const source = streamResponse({ total: 8 }); let calls = 0;
    const { downloadAsset, clock } = load(async () => { calls++; return source.response; });
    const result = outcome(downloadAsset('https://offline.invalid/slow'));
    await tick();
    for (let i = 0; i < 8; i++) { await clock.advance(30000); source.push(String(i)); await tick(); }
    source.end();
    const settled = await result; assert.equal(settled.error, undefined);
    assert.equal(await settled.value.text(), '01234567'); assert.equal(calls, 1); assert.equal(clock.now, 240000);
  });

  await test('a broken stream resumes from the exact accepted offset', async () => {
    const source = streamResponse(); const calls = [];
    const { downloadAsset, clock } = load(async (url, options) => {
      calls.push({ url, ...options });
      return calls.length === 1 ? source.response : complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/resume');
    await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.Range, 'bytes=4-');
  });

  await test('an initially unknown length is learned from a validated partial response', async () => {
    const source = streamResponse({ total: null }); const calls = [];
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options); return calls.length === 1 ? source.response : complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/chunked');
    await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls[1].headers.Range, 'bytes=4-');
  });

  await test('a graceful but truncated body is resumed, never returned as complete', async () => {
    let calls = 0; const source = streamResponse();
    const { downloadAsset, clock } = load(async (_, options) => {
      calls++; if (calls === 1) return source.response;
      assert.equal(options.headers.Range, 'bytes=4-'); return complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/truncated');
    await tick(); source.push('abcd'); source.end(); await tick(); await clock.advance(900);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls, 2);
  });

  await test('403 renewal retains the verified prefix and remains within three GETs', async () => {
    const source = streamResponse(); const calls = []; let renewals = 0;
    const { downloadAsset, clock } = load(async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1) return source.response;
      if (calls.length === 2) return new Response(null, { status: 403 });
      return complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/old', { refreshUrl: async () => { renewals++; return 'https://offline.invalid/new'; } });
    await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls.length, 3); assert.equal(renewals, 1);
    assert.equal(calls[1].headers.Range, 'bytes=4-'); assert.equal(calls[2].headers.Range, 'bytes=4-'); assert.match(calls[2].url, /\/new$/);
  });

  await test('ignored Range with HTTP 200 discards the old prefix safely', async () => {
    const source = streamResponse(); let calls = 0;
    const { downloadAsset, clock } = load(async (_, options) => {
      if (++calls === 1) return source.response;
      assert.equal(options.headers.Range, 'bytes=4-'); return complete('NEW-CONTENT', { etag: '"replacement"' });
    });
    const result = downloadAsset('https://offline.invalid/ignored');
    await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.equal(await (await result).text(), 'NEW-CONTENT'); assert.equal(calls, 2);
  });

  for (const [label, bad] of [
    ['wrong start', { range: 'bytes 3-8/10' }],
    ['wrong end', { range: 'bytes 4-10/10' }],
    ['changed total', { range: 'bytes 4-9/11' }],
    ['length disagrees with range', { range: 'bytes 4-9/10', total: 5 }],
    ['missing Content-Range', {}],
    ['changed ETag', { range: 'bytes 4-9/10', etag: '"other"' }],
    ['missing ETag', { range: 'bytes 4-9/10', etag: null }],
    ['changed representation', { range: 'bytes 4-9/10', type: MIME }],
    ['HTTP-decoded range', { range: 'bytes 4-9/10', encoding: 'gzip' }],
  ]) {
    await test(`206 ${label} never contaminates the next complete file`, async () => {
      const source = streamResponse(); const invalid = streamResponse({ status: 206, total: 6, ...bad }); const calls = [];
      const { downloadAsset, clock } = load(async (_, options) => {
        calls.push(options);
        return calls.length === 1 ? source.response : calls.length === 2 ? invalid.response : complete('abcdefghij');
      });
      const result = downloadAsset('https://offline.invalid/invalid');
      await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(2700);
      assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls.length, 3);
      assert.equal(calls[1].headers.Range, 'bytes=4-'); assert.equal(calls[2].headers, undefined); assert.equal(invalid.cancellations, 1);
    });
  }

  await test('weak or absent validators restart without mixing unidentified bytes', async () => {
    for (const etag of [null, 'W/"same-bytes"']) {
      const source = streamResponse({ etag }); const calls = [];
      const { downloadAsset, clock } = load(async (_, options) => {
        calls.push(options); return calls.length === 1 ? source.response : complete('abcdefghij');
      });
      const result = downloadAsset('https://offline.invalid/no-validator');
      await tick(); source.push('abcd'); await tick(); source.fail(); await tick(); await clock.advance(900);
      assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls[1].headers, undefined);
    }
  });

  await test('valid shorter partial responses require all remaining bytes before success', async () => {
    const source = streamResponse(); const calls = [];
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options);
      if (calls.length === 1) return source.response;
      if (calls.length === 2) return complete('efg', { status: 206, range: 'bytes 4-6/10' });
      return complete('hij', { status: 206, range: 'bytes 7-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/short-ranges');
    await tick(); source.push('abcd'); source.end(); await tick(); await clock.advance(2700);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls.length, 3);
    assert.equal(calls[2].headers.Range, 'bytes=7-');
  });

  await test('a third truncated response fails explicitly rather than exposing partial bytes', async () => {
    let calls = 0;
    const { downloadAsset, clock } = load(async (_, options) => {
      calls++;
      const item = calls === 1 ? streamResponse() : streamResponse({ status: 206, total: 12 - calls * 2, range: `bytes ${(calls - 1) * 2}-9/10` });
      item.push(calls === 1 ? 'ab' : calls === 2 ? 'cd' : 'ef'); item.end(); return item.response;
    });
    const result = outcome(downloadAsset('https://offline.invalid/always-truncated'));
    await tick(); await clock.advance(2700);
    assert.match((await result).error.message, /尚未完整下载/); assert.equal(calls, 3); assert.equal((await result).value, undefined);
  });

  await test('45 seconds of inactivity cancels the body and resumes existing bytes', async () => {
    const source = streamResponse(); const calls = [];
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options); return calls.length === 1 ? source.response : complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const result = downloadAsset('https://offline.invalid/idle');
    await tick(); source.push('abcd'); await tick(); await clock.advance(45900);
    assert.equal(await (await result).text(), 'abcdefghij'); assert.equal(calls[1].headers.Range, 'bytes=4-');
    assert.equal(source.cancellations, 1); assert.equal(calls[0].signal.aborted, true);
  });

  await test('repeated idle failures terminate after exactly three GETs', async () => {
    const calls = [];
    const { downloadAsset, clock } = load((_, options) => { calls.push(options); return new Promise(() => {}); });
    const result = outcome(downloadAsset('https://offline.invalid/no-response'));
    await tick(); await clock.advance(140000);
    assert.match((await result).error.message, /连续 45 秒没有进展/); assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.signal.aborted));
  });

  await test('the logical ten-minute cap still bounds continuously progressing streams', async () => {
    const source = streamResponse({ total: 40 }); let calls = 0;
    const { downloadAsset, clock } = load(async () => { calls++; return source.response; });
    const result = outcome(downloadAsset('https://offline.invalid/too-long'));
    await tick();
    for (let i = 0; i < 19; i++) { await clock.advance(30000); source.push('x'); await tick(); }
    await clock.advance(30000);
    assert.match((await result).error.message, /持续 10 分钟/); assert.equal(calls, 1); assert.equal(source.cancellations, 1);
  });

  await test('one shared cancellation preserves the other consumer and its resumed bytes', async () => {
    const source = streamResponse(); const calls = []; const a = new AbortController(), b = new AbortController();
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options); return calls.length === 1 ? source.response : complete('efghij', { status: 206, range: 'bytes 4-9/10' });
    });
    const first = outcome(downloadAsset('https://offline.invalid/shared', { key: 'shared', signal: a.signal }));
    const second = downloadAsset('https://offline.invalid/shared', { key: 'shared', signal: b.signal });
    await tick(); source.push('abcd'); await tick(); a.abort(new Error('first left'));
    assert.match((await first).error.message, /first left/); assert.equal(calls[0].signal.aborted, false);
    source.fail(); await tick(); await clock.advance(900);
    assert.equal(await (await second).text(), 'abcdefghij'); assert.equal(calls.length, 2);
  });

  await test('all shared cancellations stop a pending read and prevent retries', async () => {
    const source = streamResponse(); const calls = []; const a = new AbortController(), b = new AbortController();
    const { downloadAsset, clock } = load(async (_, options) => { calls.push(options); return source.response; });
    const first = outcome(downloadAsset('https://offline.invalid/all', { signal: a.signal }));
    const second = outcome(downloadAsset('https://offline.invalid/all', { signal: b.signal }));
    await tick(); source.push('abcd'); await tick(); a.abort(); b.abort(); await tick();
    assert.equal((await first).error.name, 'AbortError'); assert.equal((await second).error.name, 'AbortError');
    await clock.advance(700000); assert.equal(calls.length, 1); assert.equal(source.cancellations, 1); assert.equal(calls[0].signal.aborted, true);
  });

  await test('cancellation interrupts a stalled signed-link refresh', async () => {
    let calls = 0; const controller = new AbortController();
    const { downloadAsset, clock } = load(async () => { calls++; return new Response(null, { status: 403 }); });
    const result = outcome(downloadAsset('https://offline.invalid/renew', { signal: controller.signal, refreshUrl: () => new Promise(() => {}) }));
    await tick(); controller.abort(); await tick(); await clock.advance(700000);
    assert.equal((await result).error.name, 'AbortError'); assert.equal(calls, 1);
  });

  await test('a resumed compressed representation unpacks to every exact original byte', async () => {
    const raw = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 13 + (i >> 8)) & 255));
    const packet = packed(raw), prefix = Math.floor(packet.length / 3);
    const source = streamResponse({ total: packet.length, type: MIME }); const calls = [];
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options); return calls.length === 1 ? source.response : complete(packet.subarray(prefix), {
        status: 206, type: MIME, range: `bytes ${prefix}-${packet.length - 1}/${packet.length}`,
      });
    }, true);
    const result = downloadAsset('https://offline.invalid/scene.splat');
    await tick(); source.push(packet.subarray(0, prefix)); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.deepEqual(Buffer.from(await (await result).arrayBuffer()), raw);
    assert.equal(calls.length, 2); assert.equal(calls[1].headers.Range, `bytes=${prefix}-`); assert.match(calls[1].headers.Accept, /splat\+gzip/);
  });

  await test('a corrupt resumed packet falls back to raw with no old offset or Accept', async () => {
    const raw = Buffer.alloc(2048, 91), packet = packed(raw); packet[packet.length - 5] ^= 255;
    const prefix = 25, source = streamResponse({ total: packet.length, type: MIME }); const calls = [];
    const { downloadAsset, clock } = load(async (_, options) => {
      calls.push(options);
      if (calls.length === 1) return source.response;
      if (calls.length === 2) return complete(packet.subarray(prefix), { status: 206, type: MIME, range: `bytes ${prefix}-${packet.length - 1}/${packet.length}` });
      return complete(raw);
    }, true);
    const result = downloadAsset('https://offline.invalid/corrupt.splat');
    await tick(); source.push(packet.subarray(0, prefix)); await tick(); source.fail(); await tick(); await clock.advance(900);
    assert.deepEqual(Buffer.from(await (await result).arrayBuffer()), raw); assert.equal(calls.length, 3); assert.equal(calls[2].headers, undefined);
  });

  await test('server errors preserve the retry budget instead of starting a new logical transfer', async () => {
    let calls = 0;
    const { downloadAsset, clock } = load(async () => { calls++; return new Response(null, { status: 502 }); });
    const result = outcome(downloadAsset('https://offline.invalid/502'));
    await tick(); await clock.advance(2700);
    assert.match((await result).error.message, /502/); assert.equal(calls, 3);
  });

  console.log(JSON.stringify({ passed: checks.length, network: 'mocked', clock: 'virtual', checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
