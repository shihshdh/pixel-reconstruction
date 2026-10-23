// 「走进世界」的国内中转：World Labs 的高斯点、碰撞网格、缩略图放在 Google Cloud Storage（cdn.marble.worldlabs.ai），
// 国内多数网络直连不通或很慢。页面测出直连不通时（lib/world.ts routeWorldUrl）改从本站的 /world-file/<路径> 取，
// 这里转给那个 CDN。只放行这一个 CDN、只放行它的文件路径格式，不转发任何别的地址，也不带任何凭证。
// 文件名里带随机编号、内容不会变：在 Netlify 边缘缓存一年，同一个世界第二个人来看直接从边缘出。
const CDN = 'https://cdn.marble.worldlabs.ai/';
// <世界编号>/<文件> 或 <世界编号>/<子目录>/<文件>（缩略图在子目录里）
const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[A-Za-z0-9_-]{1,120}\/)?[A-Za-z0-9_-]{1,160}\.(spz|glb|webp|jpg|jpeg|png)$/;
const TYPES: Record<string, string> = { spz: 'application/octet-stream', glb: 'model/gltf-binary', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

function failure(status: number, message: string) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}

export default async function worldFile(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'Method not allowed');
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/world-file\//, '');
  const match = PATH.exec(path);
  if (!match || url.search) return failure(404, 'Not found');
  const range = request.headers.get('Range');
  if (range && !/^bytes=\d+-\d*$/.test(range)) return failure(416, 'Invalid range');
  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  if (range) headers.set('Range', range);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 30000);
  try {
    const response = await fetch(CDN + path, { method: request.method, headers, signal: controller.signal, redirect: 'error' });
    clearTimeout(timer);
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel();
      return failure(response.status === 404 || response.status === 403 ? 404 : 502, 'World file unavailable');
    }
    const outgoing = new Headers({
      'Content-Type': TYPES[match[1]],
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const value = response.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    if (response.status === 200) {
      // 内容按文件名不变：浏览器与 Netlify 边缘都长期缓存
      outgoing.set('Cache-Control', 'public, max-age=31536000, immutable');
      outgoing.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=31536000, immutable');
    } else outgoing.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outgoing });
  } catch {
    clearTimeout(timer);
    return failure(504, 'World file timed out');
  } finally {
    request.signal.removeEventListener('abort', cancel);
  }
}
