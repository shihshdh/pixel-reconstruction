// The gallery owns durable metadata and binary assets. No automatic expiry or count limit.
import { fileUrl, registerJobAccess, downloadJobFile, prepareMobilePreview, type JobResult } from './api';
import { isDesktopApp, saveWorkFile, workFolder } from './desktop';

const DB_NAME = 'ruhua-gallery';
const LEGACY_KEY = 'ruhua-gallery-v1';
const CHANGE_EVENT = 'ruhua-gallery-changed';
type AssetKind = 'original' | 'thumbnail' | 'ply' | 'viewer' | 'mobile' | 'video';
export type GalleryItem = JobResult & {
  id: string;
  title: string;
  date: string;
  createdAt: number;
  meta: string;
  fav: boolean;
  thumb: string;
  cacheState: 'remote' | 'saving' | 'local' | 'partial';
  cacheError?: string;
  originalReady?: boolean;
  thumbnailReady?: boolean;
  plyReady?: boolean;
  viewerReady?: boolean;
  mobileReady?: boolean;
  videoReady?: boolean;
  persistent?: boolean;
};
type GalleryInput = JobResult & Partial<GalleryItem>;
const fallbackRecords = new Map<string, GalleryItem>();
const activeSaves = new Map<string, AbortController>();
const saveCompletions = new Map<string, Promise<void>>();
// 客户端里，作品另存一份到本地“作品”文件夹（网页版不做）。缩略图和手机轻量版不另存。
const DISK_NAMES: Partial<Record<AssetKind, string>> = { original: 'original.jpg', viewer: 'scene.splat', ply: 'scene.ply' };
function writeWorkInfo(item: GalleryItem) {
  // 只写展示用的信息，不写任务 Token 或下载链接
  const info = { title: item.title, date: item.date, createdAt: new Date(item.createdAt).toISOString(), source: item.meta, job_id: item.job_id };
  return saveWorkFile(workFolder(item.job_id), 'info.json', JSON.stringify(info, null, 2));
}
let database: Promise<IDBDatabase> | undefined;
let migration: Promise<void> | undefined;

function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('这个浏览器无法使用作品存储。')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('works', { keyPath: 'id' });
      database.createObjectStore('assets', { keyPath: 'id' });
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error || new Error('无法打开作品存储。')); };
    request.onblocked = () => reject(new Error('作品存储正在被另一页面更新，请稍后重试。'));
  });
  return database;
}

async function transaction<T>(store: 'works' | 'assets', mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const request = run(tx.objectStore(store));
    let value: T;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || request.error || new Error('作品存储失败。'));
    tx.onabort = () => reject(tx.error || request.error || new Error('作品存储已中断。'));
  });
}

export function galleryId(item: Pick<JobResult, 'job_id' | 'backend_url' | 'ply_file'>) {
  return `${(item.backend_url || '').replace(/\/+$/, '')}::${item.job_id}::${item.ply_file}`;
}
/** Version identity matters: one job can own several rerender results. */
export function isSameGalleryScene(a: (JobResult & { id?: string; gallery_id?: string }) | null, b: JobResult & { id?: string; gallery_id?: string }) {
  return !!a && a.job_id === b.job_id && a.ply_file === b.ply_file
    && (a.gallery_id || a.id || galleryId(a)) === (b.gallery_id || b.id || galleryId(b));
}
function assetFilename(item: GalleryItem, kind: AssetKind) {
  return kind === 'original' || kind === 'thumbnail' ? 'original.jpg' : kind === 'ply' ? item.ply_file
    : kind === 'viewer' ? item.viewer_file : kind === 'mobile' ? item.mobile_viewer_file : item.mp4_file;
}
function normalize(item: GalleryInput): GalleryItem {
  const backend = item.backend_url || (item.thumb?.includes('/file/') ? item.thumb.split('/file/')[0] : '');
  return {
    job_id: item.job_id, ply_file: item.ply_file, viewer_file: item.viewer_file, mobile_viewer_file: item.mobile_viewer_file, mp4_file: item.mp4_file || null,
    job_token: item.job_token, file_urls: item.file_urls,
    backend_url: backend, id: item.id || galleryId({ ...item, backend_url: backend }),
    title: item.title || '显影场景', date: item.date || new Date().toLocaleDateString('zh-CN'),
    createdAt: item.createdAt || Date.now(), meta: item.meta || '', fav: !!item.fav,
    thumb: item.thumb || fileUrl(item.job_id, 'original.jpg', backend),
    cacheState: item.cacheState || 'remote', cacheError: item.cacheError,
    originalReady: !!item.originalReady, thumbnailReady: !!item.thumbnailReady,
    plyReady: !!item.plyReady, viewerReady: !!item.viewerReady, mobileReady: !!item.mobileReady, videoReady: !!item.videoReady, persistent: !!item.persistent,
  };
}
function readLegacy(): GalleryItem[] {
  try {
    const items = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => item && typeof item.job_id === 'string' && typeof item.ply_file === 'string').map(normalize) : [];
  } catch { return []; }
}
function mirror(item?: GalleryItem, deletedId?: string) {
  try {
    const remaining = readLegacy().filter(old => old.id !== item?.id && old.id !== deletedId);
    localStorage.setItem(LEGACY_KEY, JSON.stringify(item ? [item, ...remaining] : remaining));
  } catch { /* IndexedDB remains the primary store. */ }
}
function notify() { window.dispatchEvent(new Event(CHANGE_EVENT)); }
async function migrate() {
  if (!migration) migration = (async () => {
    for (const item of readLegacy()) {
      try {
        const existing = await transaction<GalleryItem>('works', 'readonly', store => store.get(item.id));
        if (!existing) await transaction('works', 'readwrite', store => store.put(item));
      } catch { fallbackRecords.set(item.id, item); }
    }
  })();
  await migration;
}
/** Keep read/merge/write in one transaction so user edits cannot be overwritten
 * by a cache save that started with an older metadata snapshot. */
async function updateMetadata(id: string, change: (current?: GalleryItem) => GalleryItem | undefined): Promise<GalleryItem | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('works', 'readwrite');
    const store = tx.objectStore('works');
    const request = store.get(id);
    let saved: GalleryItem | undefined;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        saved = change(request.result);
        if (saved) store.put(saved);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(saved);
    tx.onerror = () => reject(failure || tx.error || request.error || new Error('作品存储失败。'));
    tx.onabort = () => reject(failure || tx.error || request.error || new Error('作品存储已中断。'));
  });
}
async function writeMetadata(item: GalleryItem, controller?: AbortController) {
  try {
    await updateMetadata(item.id, current => {
      if (controller?.signal.aborted) throw new DOMException('作品已删除', 'AbortError');
      item.fav = fallbackRecords.get(item.id)?.fav ?? current?.fav ?? item.fav;
      return item;
    });
    fallbackRecords.delete(item.id);
  } catch (error) {
    if (controller?.signal.aborted) throw error;
    item.fav = fallbackRecords.get(item.id)?.fav ?? item.fav;
    fallbackRecords.set(item.id, item);
    mirror(item); notify(); throw error;
  }
  mirror(item); notify();
}
export async function listGallery(): Promise<GalleryItem[]> {
  await migrate();
  let items: GalleryItem[];
  try { items = await transaction<GalleryItem[]>('works', 'readonly', store => store.getAll()); }
  catch { items = readLegacy(); }
  const merged = new Map(items.map(item => [item.id, item]));
  fallbackRecords.forEach((item, id) => merged.set(id, item));
  return [...merged.values()].map(item => item.cacheState === 'saving' && !activeSaves.has(item.id)
    ? { ...item, cacheState: 'partial' as const, cacheError: '上次保存被中断，请联网后继续保存。' } : item).sort((a, b) => b.createdAt - a.createdAt);
}
export function subscribeGallery(listener: () => void) {
  const storageListener = (event: StorageEvent) => { if (event.key === LEGACY_KEY) listener(); };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', storageListener);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener('storage', storageListener); };
}
export async function getGalleryAsset(id: string, kind: AssetKind, expectedFilename?: string): Promise<Blob | undefined> {
  try {
    const asset = await transaction<{ blob: Blob; filename?: string }>('assets', 'readonly', store => store.get(`${id}:${kind}`));
    if (asset && expectedFilename) {
      // Old assets have no filename: accept them only against the old record's matching metadata.
      const metadata = !asset.filename ? await transaction<GalleryItem>('works', 'readonly', store => store.get(id)) : undefined;
      if ((asset.filename || (metadata && assetFilename(metadata, kind))) !== expectedFilename) return undefined;
    }
    return asset?.blob;
  }
  catch { return undefined; }
}
/** Full models are always preferred. Historical light caches are an offline-only fallback. */
export async function getGalleryScene(item: GalleryItem, online: boolean) {
  const [viewer, ply] = await Promise.all([
    item.viewer_file ? getGalleryAsset(item.id, 'viewer', item.viewer_file) : undefined,
    getGalleryAsset(item.id, 'ply', item.ply_file),
  ]);
  const mobile = !online && !viewer && !ply && item.mobile_viewer_file
    ? await getGalleryAsset(item.id, 'mobile', item.mobile_viewer_file) : undefined;
  return { viewer, ply, mobile, quality: mobile ? 'mobile' as const : 'full' as const };
}
async function putAsset(id: string, kind: AssetKind, blob: Blob, controller: AbortController, filename?: string) {
  await transaction('assets', 'readwrite', store => {
    if (controller.signal.aborted) throw new DOMException('作品已删除', 'AbortError');
    return store.put({ id: `${id}:${kind}`, workId: id, kind, blob, filename });
  });
}
async function thumbnail(original: Blob): Promise<Blob> {
  if (!globalThis.createImageBitmap) return original;
  const image = await createImageBitmap(original);
  try {
    const scale = Math.min(1, 640 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d'); if (!context) return original;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(blob => resolve(blob || original), 'image/jpeg', .84));
  } finally { image.close(); }
}
function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '浏览器空间不足，未完整离线保存；仍可尝试云端查看，或先下载文件备份。';
  if (error instanceof Error && error.name === 'AbortError') return '保存超时或被中断，作品记录仍保留，可联网后继续保存。';
  return error instanceof Error ? error.message : '未完整离线保存，仍可尝试云端查看。';
}

/** Metadata is saved first. Each completed binary write survives partial failures. */
export async function cacheGalleryItem(input: GalleryInput, options: { quality?: 'mobile' | 'full'; sceneBlob?: Blob } = {}): Promise<GalleryItem> {
  await migrate();
  registerJobAccess(input.job_id, input.job_token, input.file_urls);
  const normalized = normalize(input);
  const existing = (await listGallery()).find(item => item.id === normalized.id);
  const changedVersion = !!existing && existing.ply_file !== normalized.ply_file;
  let item: GalleryItem = { ...existing, ...normalized, title: existing?.title || normalized.title, fav: existing?.fav ?? normalized.fav, createdAt: existing?.createdAt || normalized.createdAt, cacheState: 'saving', cacheError: '' };
  if (activeSaves.has(item.id)) {
    // Serialise saves so restoring a full model cannot race a historical light-cache write.
    if (!changedVersion && !options.sceneBlob && options.quality === 'mobile') return existing || item;
    await saveCompletions.get(item.id);
    if (!(await listGallery()).some(record => record.id === item.id)) return existing || item;
    return cacheGalleryItem(input, options);
  }
  item.originalReady = !!(item.originalReady || existing?.originalReady); item.thumbnailReady = !!(item.thumbnailReady || existing?.thumbnailReady);
  item.viewerReady = !changedVersion && !!(item.viewerReady || existing?.viewerReady); item.mobileReady = !changedVersion && !!(item.mobileReady || existing?.mobileReady);
  item.plyReady = !changedVersion && !!(item.plyReady || existing?.plyReady); item.videoReady = !changedVersion && !!(item.videoReady || existing?.videoReady);
  if (!changedVersion) item.mobile_viewer_file ||= existing?.mobile_viewer_file;
  const controller = new AbortController(); activeSaves.set(item.id, controller);
  let complete = () => {};
  saveCompletions.set(item.id, new Promise<void>(resolve => { complete = resolve; }));
  const quality = options.quality || 'full';
  const stillPresent = () => { if (controller.signal.aborted) throw new DOMException('作品已删除', 'AbortError'); };
  try {
    if (changedVersion) for (const kind of ['ply', 'viewer', 'mobile', 'video']) await transaction('assets', 'readwrite', store => store.delete(`${item.id}:${kind}`));
    await writeMetadata(item, controller);
    if (isDesktopApp()) void writeWorkInfo(item);
    // Current signed links can be used immediately; the downloader renews them only on 403.
    try { item.persistent = await navigator.storage?.persist?.() || false; } catch { item.persistent = false; }
    const errors: string[] = [];
    const save = async (kind: AssetKind, filename: string, ready: 'originalReady' | 'plyReady' | 'viewerReady' | 'mobileReady' | 'videoReady') => {
      stillPresent();
      try {
        let blob = await getGalleryAsset(item.id, kind, filename);
        if (!blob) {
          blob = kind !== 'original' && options.sceneBlob ? options.sceneBlob : await downloadJobFile(item.job_id, filename, item.backend_url, { signal: controller.signal }); stillPresent(); await putAsset(item.id, kind, blob, controller, filename);
          const diskName = DISK_NAMES[kind];
          if (diskName && isDesktopApp()) void saveWorkFile(workFolder(item.job_id), diskName, blob);
        }
        item[ready] = true;
        if (kind === 'original' && !await getGalleryAsset(item.id, 'thumbnail')) {
          try { await putAsset(item.id, 'thumbnail', await thumbnail(blob), controller); item.thumbnailReady = true; }
          catch { /* The stored original remains a valid offline thumbnail. */ }
        }
        stillPresent(); await writeMetadata(item, controller);
      } catch (error) { stillPresent(); errors.push(errorMessage(error)); }
    };
    // Start the scene together with the viewer, so offline saving joins its existing transfer.
    const saveScene = async () => {
      if (quality === 'mobile') {
        try {
          const prepared = await prepareMobilePreview(item); stillPresent();
          item.mobile_viewer_file = prepared.mobile_viewer_file; item.viewer_file = prepared.viewer_file; item.file_urls = prepared.file_urls;
          await save('mobile', item.mobile_viewer_file!, 'mobileReady');
        } catch (error) { stillPresent(); errors.push(errorMessage(error)); }
      } else if (item.viewer_file) await save('viewer', item.viewer_file, 'viewerReady');
      else await save('ply', item.ply_file, 'plyReady');
    };
    await Promise.all([
      save('original', 'original.jpg', 'originalReady'),
      saveScene(),
    ]);
    // Video and the full source PLY remain explicit downloads, especially on cellular connections.
    stillPresent();
    item = { ...item, cacheState: item.originalReady && (quality === 'mobile' ? item.mobileReady : item.plyReady || item.viewerReady) ? 'local' : 'partial', cacheError: [...new Set(errors)].join(' ') };
    await writeMetadata(item, controller);
  } catch (error) {
    if (!controller.signal.aborted) {
      item = { ...item, cacheState: 'partial', cacheError: errorMessage(error) };
      try { await writeMetadata(item, controller); } catch { /* mirror and in-memory fallback were updated */ }
    }
  } finally { if (activeSaves.get(item.id) === controller) { activeSaves.delete(item.id); saveCompletions.delete(item.id); } complete(); notify(); }
  return item;
}
export async function setGalleryFavorite(id: string, fav: boolean) {
  await migrate();
  try {
    // Only update the current record's favorite, preserving completed asset
    // writes; an already deleted record must not be recreated by a late click.
    const item = await updateMetadata(id, current => current ? { ...current, fav } : undefined);
    if (item) { fallbackRecords.delete(id); mirror(item); notify(); }
  } catch (error) {
    const current = fallbackRecords.get(id) || readLegacy().find(item => item.id === id);
    if (current) {
      const item = { ...current, fav };
      fallbackRecords.set(id, item); mirror(item); notify();
    }
    throw error;
  }
}
export async function deleteGalleryItem(id: string) {
  activeSaves.get(id)?.abort(); activeSaves.delete(id);
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['works', 'assets'], 'readwrite');
    tx.objectStore('works').delete(id);
    for (const kind of ['original', 'thumbnail', 'ply', 'viewer', 'mobile', 'video']) tx.objectStore('assets').delete(`${id}:${kind}`);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
  fallbackRecords.delete(id); mirror(undefined, id); notify();
}
