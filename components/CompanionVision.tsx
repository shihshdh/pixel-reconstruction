'use client';
import { useEffect, useRef, useState } from 'react';
import { collectCompanionPage, encodeVisionImage } from '@/lib/companion-vision';
import styles from './WhaleCompanion.module.css';

// The one-line notice that she reads the page, plus a folded tray for pictures. Page text is read on
// every message; pictures (a screen capture, an uploaded screenshot, the page's own images) go out
// only when the user attaches them here and sends.
export default function CompanionVision({ enabled, busy, screen, onScreen, pageImage, onPageImage, autoLook, onAutoLook }: {
  enabled: boolean; busy: boolean;
  screen: string | null; onScreen: (value: string | null) => void;
  pageImage: { image: string; count: number } | null; onPageImage: (value: { image: string; count: number } | null) => void;
  autoLook?: boolean; onAutoLook?: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [capturing, setCapturing] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setSupported(!!navigator.mediaDevices?.getDisplayMedia);
    return () => { generation.current++; stream.current?.getTracks().forEach(t => t.stop()); };
  }, []);
  const capture = async () => {
    const version = ++generation.current; setCapturing(true); setError('');
    let media: MediaStream | undefined;
    const video = document.createElement('video'); video.muted = true; video.playsInline = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
      if (version !== generation.current) return;
      stream.current = media; video.srcObject = media;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('无法读取画面。'));
          void video.play().catch(reject);
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('画面读取超时，请重试。')), 12000); }),
      ]);
      if (version === generation.current) onScreen(encodeVisionImage(video, video.videoWidth, video.videoHeight));
    } catch (e) {
      if (version === generation.current && !(e instanceof DOMException && e.name === 'NotAllowedError'))
        setError('无法截取屏幕，可以改用上传截图。');
    } finally {
      clearTimeout(timer); media?.getTracks().forEach(t => t.stop()); video.pause(); video.srcObject = null;
      if (version === generation.current) { stream.current = null; setCapturing(false); }
    }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    const version = ++generation.current; setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError('请选择 20MB 以内的 JPG、PNG 或 WebP 截图。'); return;
    }
    setCapturing(true);
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      if (image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片尺寸过大。');
      if (version === generation.current) onScreen(encodeVisionImage(image, image.naturalWidth, image.naturalHeight));
    } catch { if (version === generation.current) setError('无法读取截图，请换一张较小的图片。'); }
    finally { URL.revokeObjectURL(url); if (version === generation.current) setCapturing(false); }
  };
  const attachPage = () => {
    setError('');
    try {
      const snapshot = collectCompanionPage({ images: true });
      if (snapshot.image) onPageImage({ image: snapshot.image, count: snapshot.count });
      else setError(snapshot.omitted ? '页面图片暂时无法读取，可以改用截图。' : '当前页面没有可附上的图片。');
    } catch { setError('页面图片过大，可以改用局部截图。'); }
  };
  const attached = (screen ? 1 : 0) + (pageImage ? 1 : 0);
  return <div className={styles.vision}>
    <details open={attached > 0 || undefined}>
      <summary>
        <span className={styles.notice}>鲸鱼娘会读取当前页面内容</span>
        <span className={styles.tray}>{attached ? `图片 · 已附 ${attached}` : '图片'}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></span>
      </summary>
      <p>{enabled ? '每条消息会自动带上页面文字和按钮名称（不含输入框、密码和图片），方便她帮你看、帮你点。图片只在你在这里附上后随消息发送。' : '图片查看等待后端更新；页面文字仍会随消息发送。'}</p>
      <div className={styles.visionActions}>
        {supported && <button type="button" disabled={!enabled || busy || capturing} onClick={() => void capture()}>{capturing ? '正在读取…' : '截取屏幕'}</button>}
        <button type="button" disabled={!enabled || busy || capturing} onClick={() => input.current?.click()}>上传截图</button>
        <button type="button" disabled={!enabled || busy || capturing} onClick={attachPage}>附上页面图片</button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="选择截图" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {(screen || pageImage) && <div className={styles.screenPreview}>
        {screen && <span><img src={screen} alt="待发送截图预览" /><button type="button" disabled={busy} onClick={() => onScreen(null)}>移除截图</button></span>}
        {pageImage && <span><img src={pageImage.image} alt={`待发送的 ${pageImage.count} 张页面图片`} /><button type="button" disabled={busy} onClick={() => onPageImage(null)}>移除页面图片</button></span>}
      </div>}
      {(screen || pageImage) && <p>图片只随你下一条消息交给 DeepSeek。截图里的隐私文字不会自动遮挡，请先检查。</p>}
      {autoLook && <p>本次访问中，你上传的照片和显影结果她会直接看。<button type="button" className={styles.linkish} onClick={() => onAutoLook?.(false)}>改回每次先问</button></p>}
      {error && <p role="status">{error}</p>}
    </details>
  </div>;
}
