'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as check from '@/lib/demo-check';
import styles from './DemoCheck.module.css';

const checks = [
  ['gateway', '云端网关', check.checkGateway], ['local', '本机引擎', check.checkLocalEngine],
  ['renderer', '显卡与渲染', check.checkRenderer], ['video', '视频导出', check.checkVideo],
  ['route', '世界线路', check.checkRoute], ['gallery', '作品库', check.checkGallery], ['worlds', '已生成的世界', check.checkWorlds],
] as const;
const actions = [
  ['gpu', '唤醒云端 GPU', check.wakeGpu], ['landing', '缓存展示页场景', check.cacheLanding],
  ['worldCache', '缓存最近的世界', () => check.cacheRecentWorld()], ['offline', '离线保存作品', check.saveGallery],
  ['assist', '测试鲸鱼娘', (_update: check.Progress, signal: AbortSignal) => check.testAssist(signal)],
] as const;
const labels = { ok: '就绪', warn: '需处理', fail: '失败', idle: '未检查', running: '进行中' };
export default function DemoCheck({ onClose }: { onClose: () => void }) {
  const [results, setResults] = useState<Record<string, check.CheckResult>>({});
  const [copyText, setCopyText] = useState('复制结果');
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const jobs = useRef(new Map<string, AbortController>());
  const update = (id: string, result: check.CheckResult) => { if (alive.current) setResults(old => ({ ...old, [id]: result })); };
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const previous = document.activeElement as HTMLElement | null;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    void (async () => {
      await Promise.all(checks.filter(([id]) => id !== 'worlds').map(async ([id, , run]) => {
        update(id, { state: 'running', text: '正在检查' });
        try { const result = await run(); if (!disposed) update(id, result); }
        catch (error) { if (!disposed) update(id, check.failure(error)); }
      }));
      if (!disposed) { try { update('worlds', await check.checkWorlds()); } catch (error) { update('worlds', check.failure(error)); } }
    })();
    return () => { window.removeEventListener('keydown', escape, true); disposed = true; alive.current = false; jobs.current.forEach(c => c.abort()); jobs.current.clear(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  async function runAction(id: string, run: (update: check.Progress, signal: AbortSignal) => Promise<check.CheckResult>) {
    if (jobs.current.has(id)) return;
    const controller = new AbortController(); jobs.current.set(id, controller);
    update(id, { state: 'running', text: '正在执行' });
    try {
      update(id, await run(result => update(id, result), controller.signal));
      if (id === 'offline') update('gallery', await check.checkGallery());
      if (id === 'worldCache') { update('route', await check.checkRoute()); update('worlds', await check.checkWorlds()); }
    } catch (error) { update(id, controller.signal.aborted ? { state: 'warn', text: '已取消 · 已下载的文件保留' } : check.failure(error)); }
    finally { jobs.current.delete(id); }
  }
  const pending = checks.filter(([id]) => !results[id] || ['idle', 'running'].includes(results[id].state)).length;
  const issues = Object.values(results).filter(r => r.state === 'warn' || r.state === 'fail').length;
  const active = Object.values(results).filter(r => r.state === 'running').length;
  const summary = pending ? `${pending} 项正在检查` : active ? `${active} 项正在执行` : issues ? `${issues} 项需要处理` : '全部就绪';
  async function copy() {
    const text = ['演示自检', ...[...checks, ...actions].map(([id, name]) => `${name} · ${labels[results[id]?.state || 'idle']} · ${results[id]?.text || '未执行'}`), summary].join('\n');
    try { await navigator.clipboard.writeText(text); setCopyText('已复制'); } catch { setCopyText('复制失败，请检查权限'); }
  }
  function result(id: string) {
    const item = results[id] || { state: 'idle', text: '未检查' };
    return <div className={styles.result} data-state={item.state}><span className={styles.dot} aria-hidden="true" /><span><span className={styles.status}>{labels[item.state]} · </span>{item.text}</span></div>;
  }
  return createPortal(<div className={styles.overlay}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="demo-check-title" className={styles.panel} onKeyDown={event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className={styles.header}><div><p className={styles.eyebrow}>PIXEL RECONSTRUCTION · 演示准备</p><h1 id="demo-check-title">演示自检</h1><p className={styles.subtitle}>检查设备与资源，按需预热和离线保存。</p></div><button onClick={onClose}>关闭</button></header>
      <div className={styles.scroll}>
        <h2>运行环境 <span>只读检查</span></h2>
        <div aria-live="polite">{checks.map(([id, name]) => <div key={id} className={styles.row} data-check={id}><h3>{name}</h3>{result(id)}</div>)}</div>
        <h2>预热与缓存 <span>点击后执行</span></h2>
        {actions.map(([id, name, run]) => <div key={id} className={`${styles.row} ${styles.action}`} data-check={id}><button disabled={results[id]?.state === 'running'} onClick={() => void runAction(id, run)}>{name}</button><div>{results[id] ? result(id) : <p className={styles.hint}>尚未执行</p>}{id === 'landing' && results[id]?.state === 'running' && <button className={styles.cancel} onClick={() => jobs.current.get(id)?.abort()}>取消下载</button>}</div></div>)}
      </div>
      <footer className={styles.footer}><p role="status">{summary}</p><button onClick={() => void copy()}>{copyText}</button></footer>
    </section>
  </div>, document.body);
}


