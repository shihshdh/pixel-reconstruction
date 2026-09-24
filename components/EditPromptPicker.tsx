'use client';

import { useState } from 'react';

const PRESETS = [
  { name: '自然补光', note: '只提亮暗部，保留光影层次', pad: 0, prompt: '只调整曝光与局部明暗：轻微提亮人物面部和室内暗部，保留原有光源方向、阴影层次与高光，不改变时间、背景和构图。保留真实肤质和原作笔触，不磨皮、不锐化描边，不改变人物五官、表情、姿势、身材和衣物细节。整体像对原图做一次克制的专业后期。' },
  { name: '日落暖调', note: '柔和暖色，不重塑人物', pad: 0, prompt: '在保持原图人物、构图和空间完全一致的前提下，将色温轻微调暖，营造柔和自然的日落气氛。明亮区域加入淡金色，阴影保留少量冷色，避免整张图泛橙和过饱和。不新增太阳、光束或物体；不重绘脸部、头发、手和衣物纹理，只调整色彩与光照观感。' },
  { name: '去噪修复', note: '轻去噪，保留纹理与画风', pad: 0, prompt: '只修复压缩噪点、轻微色块和边缘毛刺，适度恢复已有细节。保留皮肤、织物、木材和原作笔触的自然纹理；不要创造原图不存在的纹理、文字或装饰，不使用过度锐化和塑料般的平滑效果。人物身份、五官、表情、头身比、手指与肢体结构必须沿用原图。' },
  { name: '克制扩图', note: '四周延伸 15%，原图中心保留', pad: .15, prompt: '仅补全原图四周新增的画布区域，自然延续原有地面、墙面、窗景与环境；透视消失点、材质尺度、照明方向、景深、色调和画风与原图一致。保留中央原图内容不变，边界无缝衔接。不新增人物、不复制人物或肢体，不改人物与主体，不生成文字、水印和不合理结构。优先补全安静、可信的背景。' },
  { name: '空间延展', note: '四周延伸 25%，适合场景展示', pad: .25, prompt: '在新增边缘区域延伸原有空间，使地面、墙壁、天花板与窗外景物具有连贯的透视和可信的连接关系。镜头位置、原有人物、主体比例、室内陈设和光源方向保持不变。仅根据相邻可见结构补全背景，避免重复家具、倾斜门框、悬空物体和不可能的几何。中央原图不得重绘；不要把画面伪造成另一视角，不新增人物和文字。' },
  { name: '柔和电影感', note: '收敛高光，低饱和调色', pad: 0, prompt: '仅进行克制的电影感调色：适度降低过饱和色彩，柔和压缩高光，保留清晰暗部层次和自然肤色。保持原图明暗关系、背景、人物表情与轮廓，不加黑边、光晕、颗粒、景深虚化或新的光源。不得改变人物身份、五官、姿势、肢体和服装结构，照片保持照片质感，插画保持原来的画风。' },
] as const;

export default function EditPromptPicker({ onSelect, strength, onStrengthChange, disabled = false }: {
  onSelect: (prompt: string, pad: number) => void;
  strength: 'gentle' | 'balanced';
  onStrengthChange: (value: 'gentle' | 'balanced') => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  return <section className="prompt-picker liquid-surface" aria-label="精细修图预设">
    <style>{`.prompt-picker{padding:22px;border:1px solid var(--line);border-radius:24px;margin-bottom:24px}.prompt-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.prompt-heading h2{font-size:17px;margin:0}.prompt-heading select{font:inherit;font-size:12px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}.prompt-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.prompt-tile{padding:13px;text-align:left;border:1px solid var(--line);border-radius:15px;background:var(--card);color:var(--ink);cursor:pointer;transition:transform .2s,background .2s}.prompt-tile[aria-pressed=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--card))}.prompt-tile:hover{transform:translateY(-2px)}.prompt-tile strong,.prompt-tile span{display:block}.prompt-tile strong{font-size:13px;font-weight:550}.prompt-tile span{font-size:11px;color:var(--ink3);margin-top:5px;line-height:1.5}.prompt-note{font-size:11px;color:var(--ink3);line-height:1.7;margin:14px 0 0}.prompt-preview{font-size:12px;line-height:1.85;color:var(--ink2);margin-top:14px}.prompt-preview summary{cursor:pointer;color:var(--accent)}@media(max-width:600px){.prompt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.prompt-picker{padding:16px}.prompt-heading{align-items:flex-start}}@media(prefers-reduced-motion:reduce){.prompt-tile{transition:none}.prompt-tile:hover{transform:none}}`}</style>
    <div className="prompt-heading"><h2>从一个细致的想法开始</h2><label><span className="sr-only">修图程度</span><select value={strength} disabled={disabled} onChange={e => onStrengthChange(e.target.value as 'gentle' | 'balanced')}><option value="gentle">轻度调整 · 默认</option><option value="balanced">适中调整</option></select></label></div>
    <div className="prompt-grid">{PRESETS.map((preset, index) => <button type="button" className="prompt-tile" key={preset.name} disabled={disabled} aria-pressed={selected === index} onClick={() => { setSelected(index); onSelect(preset.prompt, preset.pad); }}><strong>{preset.name}</strong><span>{preset.note}</span></button>)}</div>
    <p className="prompt-note">选择后填入下方，可继续修改再发送。默认约束人物身份与结构，扩图保留原图中心；生成结果仍请与原图核对。</p>
    {selected !== null && <details className="prompt-preview"><summary>查看完整提示词</summary><p>{PRESETS[selected].prompt}</p></details>}
  </section>;
}
