'use client';

import { useState } from 'react';

export type DoubaoPreferences = { mode: 'site' | 'custom'; apiKey: string; model: string };

export default function DoubaoSettings({ value, onChange, disabled = false }: {
  value: DoubaoPreferences;
  onChange: (value: DoubaoPreferences) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <section className="doubao-settings liquid-surface" aria-label="豆包 API 设置">
    <button className="doubao-summary" type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="doubao-emblem" aria-hidden="true">✦</span>
      <span><strong>豆包修图服务</strong><span>{value.mode === 'site' ? '使用站长配置，直接开始创作' : value.apiKey.trim() ? '使用你自己的 API' : '填入你的 API Key 后使用'}</span></span>
      <span className="doubao-badge">{value.mode === 'site' ? '默认' : '自用'}</span>
      <span className="doubao-chevron" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }}>⌄</span>
    </button>
    {open && <div className="doubao-fields img-pop">
      <fieldset disabled={disabled}>
        <legend className="sr-only">修图 API 来源</legend>
        <div className="doubao-options">
          <label><input type="radio" name="doubao-provider" checked={value.mode === 'site'} onChange={() => onChange({ ...value, mode: 'site' })} /><span>站长提供的服务</span></label>
          <label><input type="radio" name="doubao-provider" checked={value.mode === 'custom'} onChange={() => onChange({ ...value, mode: 'custom' })} /><span>使用我的 API</span></label>
        </div>
        {value.mode === 'custom' && <div className="doubao-credentials">
          <label>豆包 API Key<input type="password" value={value.apiKey} onChange={e => onChange({ ...value, apiKey: e.target.value })} autoComplete="new-password" spellCheck={false} placeholder="输入你在火山方舟创建的 API Key" /></label>
          <label>模型 / 接入点 ID <span>可选</span><input type="text" value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} autoComplete="off" spellCheck={false} placeholder="留空使用站点默认修图模型" /></label>
          <p>仅在本次打开的页面内保留，刷新即清空。修图时发送到当前服务使用。</p>
          {value.apiKey && <button className="doubao-clear" type="button" onClick={() => onChange({ mode: 'site', apiKey: '', model: '' })}>清除并恢复默认</button>}
        </div>}
      </fieldset>
    </div>}
  </section>;
}
