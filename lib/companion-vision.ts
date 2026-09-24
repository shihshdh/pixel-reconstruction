// What the companion can see of the page. Text and the list of controls are read whenever the user
// sends a message (the panel says so); page pictures only when the user attaches them. Inputs, the
// companion itself and anything marked data-assist-private are never read. Nothing is stored here.
const originals = new Map<Element, { image: HTMLImageElement; label: string }>();
const PRIVATE = 'input,textarea,select,script,style,noscript,[contenteditable],[data-assist-private],[inert],[hidden],[aria-hidden="true"]';
export function registerCompanionImage(anchor: Element, image: HTMLImageElement, label: string) {
  const entry = { image, label };
  originals.set(anchor, entry);
  return () => { if (originals.get(anchor) === entry) originals.delete(anchor); };
}
function visible(el: Element) {
  if (!el.isConnected || el.closest(PRIVATE) || !el.getClientRects().length) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}
export function redactPageText(text: string) {
  return text.replace(/https?:\/\/[^\s<>]+/g, '[链接已隐藏]')
    .replace(/\b(?:sk|ak|pk)-[\w-]{8,}/gi, '[密钥已隐藏]')
    .replace(/\bbearer\s+[\w.\-]+/gi, '[凭证已隐藏]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[编号已隐藏]');
}
export function encodeVisionImage(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('画面还没准备好，请稍后重试。');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1536 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法读取图片。');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [.86, .7, .5]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= 1_398_000) return data;
  }
  throw new Error('图片过大，请选择局部截图。');
}
const CONTROLS = 'button,a[href],[role="button"],[role="tab"],summary,label,h1,h2,h3';
const labelOf = (el: Element) => ((el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || '')
  .replace(/\s+/g, ' ').trim()).slice(0, 40);

/** Numbers the visible controls and headings (data-assist-ref="c12" / "h3") so the companion can
 *  point at, scroll to or click them, and lists them for the model. Old numbers are cleared first. */
export function tagPageControls(root: Element) {
  document.querySelectorAll('[data-assist-ref]').forEach(el => el.removeAttribute('data-assist-ref'));
  const lines: string[] = []; let controls = 0, headings = 0;
  for (const el of root.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (!visible(el)) continue;
    const heading = /^H[1-3]$/.test(el.tagName);
    if (heading ? headings >= 30 : controls >= 80) continue;
    const label = labelOf(el);
    if (!label) continue;
    const ref = heading ? `h${++headings}` : `c${++controls}`;
    el.setAttribute('data-assist-ref', ref);
    const box = el.getBoundingClientRect();
    const kind = heading ? '标题' : el.matches('a[href]') ? '链接' : el.matches('label') ? (el.querySelector('input[type="file"]') ? '选择文件' : '选项') : el.matches('summary') ? '展开项' : el.matches('[role="tab"]') ? '标签' : '按钮';
    const flags = [
      (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' ? '不可用' : '',
      el.getAttribute('aria-current') ? '当前页' : '',
      el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' ? '已选中' : '',
      box.bottom < 0 || box.top > innerHeight ? '在屏幕外' : '',
    ].filter(Boolean);
    lines.push(`[${ref}] ${kind}「${label}」${flags.length ? `（${flags.join('，')}）` : ''}`);
  }
  return lines;
}

export function collectCompanionPage({ images = true }: { images?: boolean } = {}) {
  const root = document.querySelector('.showcase-workspace');
  if (!root || !visible(root)) return { text: '', image: undefined, count: 0, omitted: 0 };
  const parts: string[] = []; let size = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement, value = node.textContent?.trim();
    if (!parent || !value || !visible(parent)) continue;
    if (size + value.length > 8000) { parts.push('[页面文字较长，后续内容未附上]'); break; }
    parts.push(value); size += value.length;
  }
  const scrollable = document.documentElement.scrollHeight - innerHeight;
  parts.push(`【滚动位置】${scrollable > 8 ? `约 ${Math.round(scrollY / scrollable * 100)}%` : '整页可见'}`);
  const controls = tagPageControls(root);
  if (controls.length) parts.push('【可操作控件】', ...controls);
  if (!images) return { text: redactPageText(parts.join('\n')), image: undefined, count: 0, omitted: 0 };
  const candidates = [...originals.entries()].filter(([anchor]) => root.contains(anchor) && visible(anchor)).map(([, value]) => value);
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    if (visible(img) && img.complete && img.naturalWidth >= 96 && img.naturalHeight >= 96)
      candidates.push({ image: img, label: img.alt || '页面图片' });
  }
  const unique = candidates.filter((entry, i) => entry.image.complete && entry.image.naturalWidth && candidates.findIndex(other => other.image.src === entry.image.src) === i);
  const selected: { image: HTMLImageElement; label: string }[] = [];
  let inaccessible = 0;
  for (const entry of unique.slice(0, 8)) {
    // Tainted cross-origin pictures cannot be read. Never fetch arbitrary remote URLs.
    try { encodeVisionImage(entry.image, entry.image.naturalWidth, entry.image.naturalHeight); selected.push(entry); }
    catch { inaccessible++; }
  }
  let image: string | undefined;
  if (selected.length === 1) image = encodeVisionImage(selected[0].image, selected[0].image.naturalWidth, selected[0].image.naturalHeight);
  else if (selected.length) {
    const sheet = document.createElement('canvas'); sheet.width = 1536; sheet.height = Math.ceil(selected.length / 2) * 384;
    const ctx = sheet.getContext('2d')!; ctx.fillStyle = '#f4f2eb'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    selected.forEach(({ image: img }, i) => {
      const x = i % 2 * 768, y = Math.floor(i / 2) * 384;
      const scale = Math.min(744 / img.naturalWidth, 340 / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      ctx.drawImage(img, x + (768 - w) / 2, y + 12, w, h);
      ctx.fillStyle = '#20241d'; ctx.font = '20px sans-serif'; ctx.fillText(`图 ${i + 1}`, x + 18, y + 375);
    });
    image = encodeVisionImage(sheet, sheet.width, sheet.height);
  }
  const omitted = Math.max(0, unique.length - 8) + inaccessible;
  parts.push(...selected.map((entry, i) => `图 ${i + 1}：${entry.label}`));
  if (omitted) parts.push(`另有 ${omitted} 张图片未读取，请打开具体作品或附截图查看。`);
  return { text: redactPageText(parts.join('\n')), image, count: selected.length, omitted };
}
