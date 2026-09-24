'use client';

import { useEffect, useState } from 'react';
import { downloadJobFile, registerJobAccess, type JobResult } from '@/lib/api';
import { galleryId, getGalleryAsset } from '@/lib/gallery-storage';
import { abortReason } from '@/lib/abort';

type PosterSource = JobResult & { id?: string; gallery_id?: string; offline_original_url?: string };

/** The poster and durable gallery use the exact same original.jpg transfer key. */
export async function loadScenePosterBlob(item: PosterSource, signal?: AbortSignal): Promise<Blob> {
  const original = await getGalleryAsset(item.gallery_id || item.id || galleryId(item), 'original');
  if (signal?.aborted) throw abortReason(signal);
  if (original) return original;
  registerJobAccess(item.job_id, item.job_token, item.file_urls);
  return downloadJobFile(item.job_id, 'original.jpg', item.backend_url, { signal });
}

/** Only returns local object/data URLs: an img must never start a parallel remote GET. */
export function useScenePoster(item: PosterSource | null): string {
  const key = item ? `${item.gallery_id || item.id || galleryId(item)}::${item.offline_original_url || ''}` : '';
  const local = item?.offline_original_url && /^(blob:|data:)/.test(item.offline_original_url) ? item.offline_original_url : '';
  const [state, setState] = useState({ key: '', url: '' });
  useEffect(() => {
    if (!item || local) return;
    const controller = new AbortController();
    let alive = true, ownedUrl = '';
    setState({ key, url: '' });
    void loadScenePosterBlob(item, controller.signal).then(blob => {
      if (!alive) return;
      ownedUrl = URL.createObjectURL(blob);
      setState({ key, url: ownedUrl });
    }).catch(() => {
      // A failed poster must not interrupt the independently loading scene.
      if (alive) setState({ key, url: '' });
    });
    return () => {
      alive = false;
      controller.abort();
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
    // Credentials/metadata updates for the same work do not restart its in-flight download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, local]);
  return local || (state.key === key ? state.url : '');
}
