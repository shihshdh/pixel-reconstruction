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

// 胶片模拟：按各家胶片 / 相机色彩模式公开的影调特点写成的修图指令（原创文字，不含任何品牌的配方参数）。
// 与上面的预设同样的约束：只改色彩、影调、对比与颗粒，人物、构图、内容一律不动。
const KEEP = '画面内容、构图、人物身份与五官、姿势、服装和背景物体全部保持原样，不新增或删除任何元素，不改变光源方向，只调整色彩、影调、对比与颗粒。';
type Film = { name: string; note: string; prompt: string };
const FILMS: { group: string; items: Film[] }[] = [
  { group: '富士', items: [
    { name: '经典正片', note: 'Classic Chrome · 低饱和纪实', prompt: '把照片调成富士“经典正片”（Classic Chrome）风格：整体饱和度明显降低但不褪成灰，红色偏砖红、蓝色偏沉稳的青蓝，暗部带少量青色；影调偏硬，中间调略压暗，高光干净不过曝，呈现克制、冷静的纪实杂志感。' + KEEP },
    { name: '经典负片', note: 'Classic Neg · 色彩分离', prompt: '把照片调成富士“经典负片”（Classic Neg）风格：对比较高，阴影偏青绿，高光带淡淡洋红与暖黄，色彩分离明显，饱和度中等偏低，像九十年代冲印的彩色负片快照，保留一点怀旧的褪色感但肤色自然。' + KEEP },
    { name: 'Velvia', note: '反转片 · 浓郁风光', prompt: '把照片调成富士 Velvia 反转片风格：饱和度高而通透，天空是深邃的蓝，植被是浓郁的绿，红色鲜亮；对比强，暗部偏深但保留层次，高光清澈。人物肤色适度收敛，避免过红。' + KEEP },
    { name: 'Pro 400H', note: '淡雅通透 · 人像', prompt: '把照片调成富士 Pro 400H 胶片风格：低对比、明亮通透，整体偏淡雅的青绿与粉色，高光柔和微微过曝感，阴影不死黑而是带淡青色，肤色干净白皙，加入非常细的胶片颗粒。' + KEEP },
    { name: 'Eterna 电影', note: '低饱和 · 柔和阴影', prompt: '把照片调成富士 Eterna 电影卷风格：饱和度与对比都偏低，影调平缓，阴影柔和并略带青灰，高光被轻轻压住，色彩安静克制，像电影母带调色前的质感。' + KEEP },
    { name: 'Acros 黑白', note: '细腻颗粒 · 丰富灰阶', prompt: '把照片转为富士 Acros 黑白胶片风格：黑白，灰阶过渡丰富细腻，黑位深而干净，高光保留细节，中间调有立体感，加入细腻均匀的胶片颗粒，整体锐利但不生硬。' + KEEP },
  ] },
  { group: '理光 GR', items: [
    { name: '正片', note: 'Positive Film · 街拍经典', prompt: '把照片调成理光 GR“正片”色彩风格：饱和度偏高，红色与黄色浓郁，蓝天和阴影偏向清爽的青色，高光通透明亮，对比中等偏高，带有日系街拍那种干净鲜明、略微偏冷的色调。' + KEEP },
    { name: '负片', note: 'Negative Film · 青绿复古', prompt: '把照片调成理光 GR“负片”色彩风格：整体偏青绿、略微褪色，饱和度偏低，对比柔和，高光带一点暖黄，阴影发青，像过期彩色负片冲印出来的安静复古感。' + KEEP },
    { name: '高对比黑白', note: '硬朗反差 · 粗颗粒', prompt: '把照片转为理光 GR 高对比黑白风格：黑白，反差强烈，暗部大面积压黑、高光明亮，中间调少，加入明显的粗颗粒，带有街头摄影的粗粝与张力。' + KEEP },
  ] },
  { group: '柯达与电影卷', items: [
    { name: 'Portra 400', note: '温暖自然 · 肤色', prompt: '把照片调成柯达 Portra 400 胶片风格：色温略暖，肤色自然红润，饱和度适中偏低，对比柔和，高光宽容度高、过渡平滑，阴影带一点暖棕，加入细腻的胶片颗粒。' + KEEP },
    { name: 'Gold 200', note: '暖黄怀旧 · 日常', prompt: '把照片调成柯达 Gold 200 胶片风格：整体偏暖黄，阳光感明显，饱和度中等，红黄色温暖，蓝色略微偏青，对比适中，带有明显但不粗糙的颗粒，像夏天日常随手拍的怀旧照片。' + KEEP },
    { name: 'Ektar 100', note: '高饱和 · 细腻', prompt: '把照片调成柯达 Ektar 100 胶片风格：饱和度高、色彩鲜艳纯净，红色和蓝色尤其浓郁，对比较强，画面细腻几乎无颗粒，适合风光与城市。' + KEEP },
    { name: 'CineStill 800T', note: '夜景 · 红色光晕', prompt: '把照片调成 CineStill 800T 电影卷风格：按钨丝灯白平衡处理，整体偏冷青蓝，暖色光源保持橙黄；明亮光源和高光边缘出现柔和的红色光晕（halation），暗部带青色，颗粒明显，呈现夜色电影感。' + KEEP },
  ] },
];

export default function EditPromptPicker({ onSelect, strength, onStrengthChange, disabled = false }: {
  onSelect: (prompt: string, pad: number) => void;
  strength: 'gentle' | 'balanced';
  onStrengthChange: (value: 'gentle' | 'balanced') => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filmOpen, setFilmOpen] = useState(false);
  const pick = (key: string, prompt: string, pad: number) => { setSelected(key); onSelect(prompt, pad); };
  const selectedPrompt = selected === null ? null
    : selected.startsWith('p:') ? PRESETS[+selected.slice(2)].prompt
    : FILMS.flatMap(g => g.items).find(f => 'f:' + f.name === selected)?.prompt ?? null;
  return <section className="prompt-picker liquid-surface" aria-label="精细修图预设">
    <style>{`.prompt-picker{padding:22px;border:1px solid var(--line);border-radius:24px;margin-bottom:24px}.prompt-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.prompt-heading h2{font-size:17px;margin:0}.prompt-heading select{font:inherit;font-size:12px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}.prompt-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.prompt-tile{padding:13px;text-align:left;border:1px solid var(--line);border-radius:15px;background:var(--card);color:var(--ink);cursor:pointer;transition:transform .2s,background .2s}.prompt-tile[aria-pressed=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--card))}.prompt-tile:hover{transform:translateY(-2px)}.prompt-tile strong,.prompt-tile span{display:block}.prompt-tile strong{font-size:13px;font-weight:550}.prompt-tile span{font-size:11px;color:var(--ink3);margin-top:5px;line-height:1.5}.prompt-note{font-size:11px;color:var(--ink3);line-height:1.7;margin:14px 0 0}.prompt-preview{font-size:12px;line-height:1.85;color:var(--ink2);margin-top:14px}.prompt-preview summary{cursor:pointer;color:var(--accent)}.film-toggle{width:100%;display:flex;align-items:baseline;gap:10px;margin-top:16px;padding:12px 14px;border:1px dashed var(--line);border-radius:15px;background:none;color:var(--ink);cursor:pointer;text-align:left}.film-toggle span{font-size:14px;font-weight:600}.film-toggle small{font-size:11px;color:var(--ink3)}.film-toggle i{margin-left:auto;font-style:normal;color:var(--accent);font-size:16px}.film-group{margin-top:14px}.film-group h3{font-size:12px;font-weight:600;color:var(--ink2);margin:0 0 8px;letter-spacing:.02em}@media(max-width:600px){.prompt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.prompt-picker{padding:16px}.prompt-heading{align-items:flex-start}}@media(prefers-reduced-motion:reduce){.prompt-tile{transition:none}.prompt-tile:hover{transform:none}}`}</style>
    <div className="prompt-heading"><h2>从一个细致的想法开始</h2><label><span className="sr-only">修图程度</span><select value={strength} disabled={disabled} onChange={e => onStrengthChange(e.target.value as 'gentle' | 'balanced')}><option value="gentle">轻度调整 · 默认</option><option value="balanced">适中调整</option></select></label></div>
    <div className="prompt-grid">{PRESETS.map((preset, index) => <button type="button" className="prompt-tile" key={preset.name} disabled={disabled} aria-pressed={selected === 'p:' + index} onClick={() => pick('p:' + index, preset.prompt, preset.pad)}><strong>{preset.name}</strong><span>{preset.note}</span></button>)}</div>
    <button type="button" className="film-toggle" aria-expanded={filmOpen} onClick={() => setFilmOpen(v => !v)}>
      <span>胶片模拟</span><small>富士 · 理光 GR · 柯达 · CineStill</small><i aria-hidden="true">{filmOpen ? '−' : '+'}</i>
    </button>
    {filmOpen && FILMS.map(group => <div className="film-group" key={group.group}>
      <h3>{group.group}</h3>
      <div className="prompt-grid">{group.items.map(film => <button type="button" className="prompt-tile" key={film.name} disabled={disabled} aria-pressed={selected === 'f:' + film.name}
        onClick={() => pick('f:' + film.name, film.prompt, 0)}><strong>{film.name}</strong><span>{film.note}</span></button>)}</div>
    </div>)}
    <p className="prompt-note">选择后填入下方，可继续修改再发送。默认约束人物身份与结构，扩图保留原图中心；生成结果仍请与原图核对。</p>
    {selectedPrompt && <details className="prompt-preview"><summary>查看完整提示词</summary><p>{selectedPrompt}</p></details>}
  </section>;
}
