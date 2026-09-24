'use client';

import { useEffect, useRef, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { ICON } from '@/lib/icons';
import { SPRING } from '@/lib/motion';

const captions = [
  ['01 / INPUT', '照片提供色彩、构图与空间线索。'],
  ['02 / RECONSTRUCT', '由图像建立可从附近视角观看的场景。'],
  ['03 / CAMERA', '为场景编排镜头，再导出成片。'],
];

/** A CSS illustration of the workflow, not a substitute for the actual 3D viewer. */
export default function WorkflowPreview({ stage, onStageChange, playing, onPlayingChange, active }: {
  stage: number;
  onStageChange: (stage: number) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  active: boolean;
}) {
  const figure = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { threshold: .25 });
    if (figure.current) observer.observe(figure.current);
    const onVisibility = () => setPageVisible(!document.hidden);
    onVisibility(); document.addEventListener('visibilitychange', onVisibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  useEffect(() => {
    if (!active || !visible || !pageVisible || !playing) return;
    const timer = setTimeout(() => onStageChange((stage + 1) % captions.length), 2000);
    return () => clearTimeout(timer);
  }, [active, visible, pageVisible, playing, stage, onStageChange]);
  const select = (index: number) => { onPlayingChange(false); onStageChange(index); };
  return <figure ref={figure} className="workflow-preview" data-stage={stage} data-playing={playing} aria-label={`交互流程示意：${captions[stage][1]}`}>
    <div className="workflow-preview-scene" aria-hidden="true">
      <div className="workflow-preview-grid" />
      <div className="workflow-preview-plane">
        <img className="workflow-photo" src="/scene/landing.jpg" alt="" loading="lazy" />
        <img className="workflow-point-photo" src="/scene/landing.jpg" alt="" loading="lazy" />
      </div>
      <svg className="workflow-camera-path" viewBox="0 0 360 220" fill="none">
        <path className="workflow-path-shadow" d="M38 176C95 119 189 225 303 140" />
        <path key={stage} className="workflow-path-line" d="M38 176C95 119 189 225 303 140" pathLength="1" />
        <circle cx="38" cy="176" r="3" fill="currentColor" />
        <g className="workflow-camera-marker" transform="translate(303 140) rotate(-30)"><rect x="-10" y="-7" width="17" height="14" rx="3" fill="currentColor" /><path d="m8-3 7-4v14l-7-4" fill="currentColor" /></g>
      </svg>
      <span className="workflow-preview-index">{captions[stage][0]}</span>
    </div>
    <div className="workflow-preview-controls">
      <div role="group" aria-label="流程预览阶段">{['照片', '场景', '运镜'].map((name, index) => <button key={name} type="button" aria-pressed={stage === index} onClick={() => select(index)}>{name}</button>)}</div>
      <button className="workflow-preview-play" type="button" onClick={() => onPlayingChange(!playing)} aria-label={playing ? '暂停流程自动播放' : '播放流程示意'} aria-pressed={playing}><MorphIcon icon={playing ? ICON.pause : ICON.play} size={13} strokeWidth={2} spring={SPRING} reducedMotion="user" />{playing ? '暂停' : '播放'}</button>
    </div>
    <figcaption><span>{captions[stage][1]}</span><small>交互流程示意</small></figcaption>
  </figure>;
}
