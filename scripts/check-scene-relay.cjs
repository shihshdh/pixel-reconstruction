// Offline Web API behavioral tests of the actual Netlify Edge Function source.
// No real network, secrets, deployment, or GPU calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { gzipSync } = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, '../netlify/edge-functions/scene-file.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fixedGateway = source.match(/const GATEWAY = '([^']+)'/)[1];
assert.match(fixedGateway, /^https:\/\/ruhua-api-[a-z0-9]+-v\d+\.app\.beam\.cloud$/);
const job = 'a'.repeat(32), signature = 'b'.repeat(64), now = 1800000000000;
const filename = `scene_${job}_mobile.splat`;
const MIME = 'application/vnd.pixel-reconstruction.splat+gzip';
const checks = [];

function load(fetchMock) {
  const timers = new Set();
  class FixedDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Response, Request, Headers, URL, AbortController, ReadableStream, Uint8Array, DOMException,
    Date: FixedDate, console, fetch: fetchMock,
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  const module = { exports: {} };
  vm.runInContext('(function(module,exports){\n' + compiled + '\n})', context)(module, module.exports);
  return { handler: module.exports.default, timers, fire: () => { for (const timer of [...timers]) timer.callback(); } };
}

function request({ file = filename, query = `expires=${now / 1000 + 3600}&sig=${signature}`, route,
  method = 'GET', headers = {}, signal } = {}) {
  const result = new Request(`https://gausssharp.netlify.app${route || `/scene-file/${job}/${file}`}?${query}`, { method, headers, signal });
  const active = new Set();
  const add = result.signal.addEventListener.bind(result.signal), remove = result.signal.removeEventListener.bind(result.signal);
  result.signal.addEventListener = (type, callback, options) => { if (type === 'abort') active.add(callback); add(type, callback, options); };
  result.signal.removeEventListener = (type, callback, options) => { if (type === 'abort') active.delete(callback); remove(type, callback, options); };
  return { value: result, active };
}

function privateResponse(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Relay test remained pending for 1500ms')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
async function test(name, run) { await run(); checks.push({ name, passed: true }); }
const bytes = value => new TextEncoder().encode(value);

(async () => {
  await test('fixed origin and allowlisted files; never forwards credentials or caller headers', async () => {
    const files = ['original.jpg', `edit_${job}.jpg`, `scene_${job}.ply`, `scene_${job}.splat`, filename, `camera_${job}.mp4`];
    for (const file of files) {
      let captured;
      const mock = load(async (url, options) => {
        captured = { url, options };
        return new Response(bytes('model'), { headers: { 'Content-Type': 'application/octet-stream', 'Set-Cookie': 'private=forbidden' } });
      });
      const req = request({ file, headers: { Authorization: 'Bearer test-only', Cookie: 'test=only', 'X-Ruhua-Token': 'test-only', 'X-Upstream': 'https://attacker.invalid' } });
      const response = await mock.handler(req.value);
      const url = new URL(captured.url);
      assert.equal(url.origin, fixedGateway);
      assert.equal(url.pathname, `/file/${job}/${file}`);
      assert.deepEqual([...url.searchParams.keys()], ['expires', 'sig']);
      assert.equal(captured.options.redirect, 'error');
      assert.equal(captured.options.headers.get('Accept-Encoding'), 'identity');
      assert.deepEqual([...captured.options.headers.keys()].sort(), ['accept', 'accept-encoding']);
      assert.equal(response.headers.get('set-cookie'), null);
      privateResponse(response);
      assert.equal(await bounded(response.text()), 'model');
      assert.equal(req.active.size, 0);
      assert.equal(mock.timers.size, 0);
    }
  });

  await test('rejects methods, unknown names, path traversal and malformed jobs without fetch', async () => {
    const mock = load(() => { throw new Error('Rejected request reached upstream'); });
    for (const options of [{ method: 'POST' }, { method: 'HEAD' }, { file: 'access.json' }, { file: `scene_${job}_mobile.json` },
      { file: `scene_${job}_mobile.ply` }, { file: '..%2faccess.json' }, { route: `/scene-file/${'c'.repeat(31)}/${filename}` },
      { route: `/scene-file/${job}/${filename}/extra` }, { route: `/scene-file/${job}/%2e%2e/access.json` }]) {
      const response = await mock.handler(request(options).value);
      assert.equal(response.status, options.method ? 405 : 404);
      privateResponse(response);
    }
  });

  await test('rejects missing, duplicate, extra, expired and oversized query grants without fetch', async () => {
    let calls = 0;
    const mock = load(() => { calls++; throw new Error('Grant validation failed'); });
    const valid = `expires=${now / 1000 + 3600}&sig=${signature}`;
    for (const query of ['', `sig=${signature}`, `${valid}&url=https://attacker.invalid`, `${valid}&sig=${signature}`,
      `${valid}&expires=${now / 1000 + 3600}`, `expires=${now / 1000 - 1}&sig=${signature}`,
      `expires=${now / 1000 + 90000}&sig=${signature}`, `expires=999999999999&sig=${signature}`,
      `expires=${now / 1000 + 3600}&sig=${signature.toUpperCase()}`]) {
      const response = await mock.handler(request({ query }).value);
      assert.equal(response.status, 403);
      privateResponse(response);
    }
    assert.equal(calls, 0);
  });

  await test('query order is immaterial and names are safely canonicalized upstream', async () => {
    let target;
    const mock = load(async url => { target = url; return new Response('ok'); });
    const response = await mock.handler(request({ query: `sig=${signature}&expires=${now / 1000 + 3600}` }).value);
    assert.equal(response.status, 200);
    assert.equal(new URL(target).searchParams.get('sig'), signature);
    await response.text();
  });

  await test('exact MIME and valid positive q negotiate packed data', async () => {
    for (const [accept, expected] of [[MIME, MIME], [`text/plain, ${MIME};q=0.5`, MIME], [MIME.toUpperCase(), MIME],
      [`${MIME};q=0`, 'application/octet-stream'], [`x-${MIME}`, 'application/octet-stream'],
      [`${MIME}-suffix`, 'application/octet-stream'], [`${MIME};q=invalid`, 'application/octet-stream'],
      [`${MIME};q=2`, 'application/octet-stream'], [`${MIME};q=0;q=1`, 'application/octet-stream']]) {
      let forwarded;
      const mock = load(async (_, options) => { forwarded = options.headers.get('Accept'); return new Response('ok'); });
      const response = await mock.handler(request({ headers: { Accept: accept } }).value);
      assert.equal(forwarded, expected, accept);
      await response.text();
    }
  });

  await test('valid single Range and 206 headers are preserved; multi/invalid Range rejected', async () => {
    for (const range of ['bytes=0-31', 'bytes=32-', 'bytes=-32']) {
      const mock = load(async (_, options) => {
        assert.equal(options.headers.get('Range'), range);
        return new Response(bytes('range'), { status: 206, headers: { 'Content-Range': 'bytes 0-4/50', 'Content-Length': '5', 'Accept-Ranges': 'bytes', ETag: '"fixed"' } });
      });
      const response = await mock.handler(request({ headers: { Range: range } }).value);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 0-4/50');
      assert.equal(response.headers.get('content-length'), '5');
      assert.equal(response.headers.get('etag'), '"fixed"');
      assert.equal(response.headers.get('vary'), 'Accept');
      assert.equal(await response.text(), 'range');
    }
    for (const range of ['bytes=0-1,3-4', 'bytes=', 'items=0-1', 'bytes=x-7']) {
      const mock = load(() => { throw new Error('Malformed range forwarded'); });
      assert.equal((await mock.handler(request({ headers: { Range: range } }).value)).status, 416);
    }
  });

  await test('custom packed payload passes byte-exact without adding HTTP Content-Encoding', async () => {
    const header = Buffer.alloc(20); header.write('PRSGZ001'); header.writeUInt32LE(32, 8); header.writeUInt32LE(65536, 12); header.writeUInt32LE(1, 16);
    const packet = Buffer.concat([header, gzipSync(Buffer.alloc(32))]);
    const mock = load(async () => new Response(packet, { headers: { 'Content-Type': MIME, 'Content-Length': String(packet.length) } }));
    const response = await mock.handler(request({ headers: { Accept: MIME } }).value);
    assert.equal(response.headers.get('content-type'), MIME);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), String(packet.length));
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(packet));
  });

  await test('HTTP-decoded full response drops encoded length/range metadata', async () => {
    const mock = load(async () => new Response('already decoded', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '999', 'Accept-Ranges': 'bytes' } }));
    const response = await mock.handler(request().value);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('accept-ranges'), null);
    assert.equal(await response.text(), 'already decoded');
  });

  await test('HTTP-encoded 206 fails rather than lying about byte positions', async () => {
    let canceled = 0;
    const mock = load(async () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 206, headers: { 'Content-Encoding': 'gzip' } }));
    const response = await mock.handler(request({ headers: { Range: 'bytes=0-9' } }).value);
    assert.equal(response.status, 502);
    assert.equal(canceled, 1);
    privateResponse(response);
  });

  await test('upstream error bodies are canceled and never disclosed', async () => {
    for (const status of [302, 401, 403, 404, 416, 429, 500, 503]) {
      let canceled = 0;
      const mock = load(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes('INTERNAL_PRIVATE_DETAILS')); }, cancel() { canceled++; } }), { status }));
      const req = request();
      const response = await mock.handler(req.value);
      assert.equal(response.status, [403, 404, 416, 429].includes(status) ? status : 502);
      assert.equal(canceled, 1);
      assert.equal(req.active.size, 0);
      assert.ok(!(await response.text()).includes('INTERNAL_PRIVATE_DETAILS'));
      privateResponse(response);
    }
  });

  await test('headers arrive without waiting for complete body; chunks stream unchanged', async () => {
    let upstream;
    const mock = load(async () => new Response(new ReadableStream({ start(controller) { upstream = controller; } }, { highWaterMark: 0 })));
    const req = request();
    const response = await bounded(mock.handler(req.value));
    assert.equal(mock.timers.size, 0);
    const reader = response.body.getReader();
    upstream.enqueue(bytes('one'));
    assert.equal(new TextDecoder().decode((await bounded(reader.read())).value), 'one');
    upstream.enqueue(bytes('two'));
    assert.equal(new TextDecoder().decode((await bounded(reader.read())).value), 'two');
    upstream.close();
    assert.equal((await bounded(reader.read())).done, true);
    assert.equal(req.active.size, 0);
  });

  await test('downstream cancel aborts fetch, cancels its body and removes request listener', async () => {
    let signal, canceled = 0;
    const mock = load(async (_, options) => { signal = options.signal; return new Response(new ReadableStream({ cancel() { canceled++; } })); });
    const req = request();
    const response = await mock.handler(req.value);
    await bounded(response.body.cancel('viewer closed'));
    assert.equal(signal.aborted, true);
    assert.equal(canceled, 1);
    assert.equal(req.active.size, 0);
  });

  await test('request abort during headers or body reaches upstream and finishes promptly', async () => {
    const controller = new AbortController();
    const mock = load((_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })));
    const req = request({ signal: controller.signal });
    const pending = mock.handler(req.value);
    controller.abort();
    assert.equal((await bounded(pending)).status, 502);
    assert.equal(req.active.size, 0);

    const duringBody = new AbortController();
    let bodySignal;
    const bodyMock = load(async (_, options) => {
      bodySignal = options.signal;
      return new Response(new ReadableStream({ start(stream) {
        options.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true });
      } }));
    });
    const bodyReq = request({ signal: duringBody.signal });
    const body = await bodyMock.handler(bodyReq.value);
    const reading = body.body.getReader().read();
    duringBody.abort();
    await assert.rejects(bounded(reading), /aborted/);
    assert.equal(bodySignal.aborted, true);
    assert.equal(bodyReq.active.size, 0);
  });

  await test('pre-aborted request, fetch failure and response timeout leave no listener/timer', async () => {
    const controller = new AbortController(); controller.abort();
    const mock = load(async (_, options) => { assert.equal(options.signal.aborted, true); throw new DOMException('aborted', 'AbortError'); });
    const req = request({ signal: controller.signal });
    assert.equal((await mock.handler(req.value)).status, 502);
    assert.equal(req.active.size, 0);
    assert.equal(mock.timers.size, 0);
    const timeout = load((_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })));
    const waiting = request();
    const pending = timeout.handler(waiting.value);
    assert.equal([...timeout.timers][0].delay, 35000);
    timeout.fire();
    assert.equal((await bounded(pending)).status, 502);
    assert.equal(waiting.active.size, 0);
    assert.equal(timeout.timers.size, 0);
  });

  await test('stream error propagates and aborts upstream without hanging', async () => {
    let upstream, signal;
    const mock = load(async (_, options) => { signal = options.signal; return new Response(new ReadableStream({ start(stream) { upstream = stream; } })); });
    const req = request();
    const response = await mock.handler(req.value);
    const reading = response.body.getReader().read();
    upstream.error(new Error('offline stream failure'));
    await assert.rejects(bounded(reading), /offline stream failure/);
    assert.equal(signal.aborted, true);
    assert.equal(req.active.size, 0);
  });

  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
