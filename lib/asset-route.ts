/** Keep private downloads on the site's connection; grants are still verified by Beam. */
export function routeAssetUrl(value: string): string {
  if (typeof location === 'undefined' || !/(^|\.)netlify\.app$/.test(location.hostname)) return value;
  try {
    const source = new URL(value);
    if (source.protocol !== 'https:' || !/^ruhua-api-aa5d4d3-v\d+\.app\.beam\.cloud$/.test(source.hostname)) return value;
    if (!/^\/file\/[a-f0-9]{32}\/[a-z0-9_.]+$/.test(source.pathname)) return value;
    // Only signed files go through the relay. No account key is sent or embedded.
    if (!source.searchParams.has('expires') || !source.searchParams.has('sig')) return value;
    return location.origin + source.pathname.replace(/^\/file\//, '/scene-file/') + source.search;
  } catch { return value; }
}
