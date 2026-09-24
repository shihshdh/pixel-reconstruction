'use client';
import { useEffect, useRef } from 'react';
import { registerCompanionImage } from '@/lib/companion-vision';
/** The already-downloaded original remains available while its 3D viewer is on screen. */
export default function CompanionPageImage({ src }: { src?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const parent = anchor.current?.closest('main');
    if (!parent || !src) return;
    let remove: (() => void) | undefined;
    const image = new Image();
    image.onload = () => { remove = registerCompanionImage(parent, image, '当前作品的上传原图（不是三维视角截图）'); };
    image.src = src;
    return () => { image.onload = null; image.src = ''; remove?.(); };
  }, [src]);
  return <span ref={anchor} hidden />;
}
