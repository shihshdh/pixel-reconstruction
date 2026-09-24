// Fixed, owned CPU gateway. Never forward arbitrary URLs or cloud credentials.
const GATEWAY = 'https://ruhua-api-aa5d4d3-v16.app.beam.cloud';
const FILE = /^(original\.jpg|edit_[a-f0-9]{32}\.jpg|scene_[a-f0-9]{32}(?:\.ply|(?:_mobile)?\.splat)|camera_[a-f0-9]{32}\.mp4)$/;
const PACKED = 'application/vnd.pixel-reconstruction.splat+gzip';
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Netlify-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
function failure(status: number, message: string) {
  return new Response(message, { status, headers: { ...PRIVATE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

function acceptsPacked(accept: string): boolean {
  return accept.split(',').some(entry => {
    const [type, ...parameters] = entry.split(';').map(part => part.trim().toLowerCase());
    if (type !== PACKED) return false;
    const qualities = parameters.filter(part => /^q\s*=/.test(part));
    if (qualities.length > 1) return false;
    if (!qualities.length) return true;
    const value = qualities[0].replace(/^q\s*=\s*/, '');
    return /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) && Number(value) > 0;
  });
}

export default async function sceneFile(request: Request): Promise<Response> {
  if (request.method !== 'GET') return failure(405, 'Method not allowed');
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  if (parts.length !== 4 || parts[1] !== 'scene-file' || !/^[a-f0-9]{32}$/.test(parts[2]) || !FILE.test(parts[3])) return failure(404, 'Not found');
  const keys = [...url.searchParams.keys()];
  const expires = url.searchParams.get('expires') || '';
  const signature = url.searchParams.get('sig') || '';
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.every(key => ['expires', 'sig'].includes(key))
    || !/^\d{10}$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature)) return failure(403, 'Access denied');
  const now = Date.now() / 1000;
  if (Number(expires) <= now || Number(expires) > now + 86460) return failure(403, 'Access expired');
  const range = request.headers.get('Range');
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return failure(416, 'Invalid range');
  const headers = new Headers();
  headers.set('Accept', acceptsPacked(request.headers.get('Accept') || '') ? PACKED : 'application/octet-stream');
  headers.set('Accept-Encoding', 'identity');
  if (range) headers.set('Range', range);
  // Authentication is evaluated upstream on every request, including Range requests.
  const upstream = `${GATEWAY}/file/${parts[2]}/${parts[3]}?expires=${expires}&sig=${signature}`;
  const controller = new AbortController();
  const cancel = () => { controller.abort(); request.signal.removeEventListener('abort', cancel); };
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timer = setTimeout(cancel, 35000);
  try {
    const response = await fetch(upstream, { headers, signal: controller.signal, redirect: 'error' });
    clearTimeout(timer); // The response body streams without buffering the model in edge memory.
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel();
      request.signal.removeEventListener('abort', cancel);
      return failure([403, 404, 416, 429].includes(response.status) ? response.status : 502,
        response.status === 403 ? 'Access denied' : 'Scene download unavailable');
    }
    const outgoing = new Headers(PRIVATE_HEADERS);
    const encoded = !['', 'identity'].includes((response.headers.get('Content-Encoding') || '').trim().toLowerCase());
    // Fetch may have already decoded HTTP compression. Its original byte count
    // and compressed-byte ranges would then describe a different body.
    if (encoded && response.status === 206) {
      await response.body?.cancel();
      request.signal.removeEventListener('abort', cancel);
      return failure(502, 'Scene download unavailable; retry the request');
    }
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
      if (encoded && ['Content-Length', 'Content-Range', 'Accept-Ranges'].includes(name)) continue;
      const value = response.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    // No public CDN cache: a signed URL is a private per-work access grant.
    outgoing.set('Vary', 'Accept');
    if (!response.body) {
      request.signal.removeEventListener('abort', cancel);
      return new Response(null, { status: response.status, headers: outgoing });
    }
    const reader = response.body.getReader();
    let finished = false;
    const finish = (abort = false) => {
      finished = true;
      request.signal.removeEventListener('abort', cancel);
      if (abort) controller.abort();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        if (finished) return;
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            finish();
            reader.releaseLock();
            stream.close();
          } else {
            stream.enqueue(chunk.value);
          }
        } catch (error) {
          if (finished) return;
          finish(true);
          reader.releaseLock();
          stream.error(error);
        }
      },
      async cancel(reason) {
        finish(true);
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); }
      },
    });
    return new Response(body, { status: response.status, headers: outgoing });
  } catch {
    request.signal.removeEventListener('abort', cancel);
    return failure(502, 'Scene download unavailable; retry the request');
  } finally { clearTimeout(timer); }
}
