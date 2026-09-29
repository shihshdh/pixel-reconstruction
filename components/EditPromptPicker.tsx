'use client';

import { useState } from 'react';

// 提示词写法：每个专业参数后面都跟着它在画面上的样子。图像模型读得懂“暗部提亮、高光不动”，
// 读不懂孤立的数字；数字给出幅度，效果描述告诉它往哪改。参数都是后期意义上的（曝光补偿、
// 白平衡、曲线、分级、HSL、颗粒），焦段与光圈只用于景深模拟和扩图，不改变原图透视。
const COLOR = '色彩管理：按 sRGB（D65 白点、Gamma 2.2）输出，中性灰保持无偏色，肤色落在肤色线附近（色相约 20–30°），高光与高饱和色不溢出，天空等渐变不出现断层。';
const KEEP = '画面内容、构图、人物身份与五官、姿势、服装和背景物体全部保持原样，不新增或删除任何元素，不改变光源方向，只调整色彩、影调、对比与颗粒。';
const spec = (goal: string, lines: string[], tail = KEEP) => goal + '\n' + lines.map(line => '· ' + line).join('\n') + '\n' + COLOR + tail;

const PRESETS = [
  { name: '自然补光', note: '+0.3EV · 暗部打开，高光不动', pad: 0, prompt: spec('做一次克制的专业补光后期：', [
    '曝光补偿 +0.3EV（整体亮约 1/3 档），主要作用在中间调和暗部',
    '阴影 +25：暗部细节打开；黑位不动，最暗处仍接近纯黑、不发灰',
    '高光 −15：天空、窗户、灯光保留层次，不出现死白',
    'RGB 曲线：输入 64 → 输出 76，输入 192 以上保持原值（只抬暗部，不动高光）',
    '人物面部局部 +0.5EV 柔光补光，方向与原图主光一致，不产生新的阴影',
    '白平衡维持原图；饱和度不变，自然饱和度 +5',
  ]) },
  { name: '日落暖调', note: '+800K · 金色高光、冷色阴影', pad: 0, prompt: spec('把色彩调成柔和的日落暖调（只改色彩与光感，不改光源位置）：', [
    '白平衡在原图基础上提高约 800K（例如 5500K → 6300K），色调 +5 偏洋红：整体变暖但不泛橙',
    '色彩分级：高光 色相 40°（金色）饱和度 15%；中间调 色相 30° 饱和度 6%；阴影 色相 215°（冷蓝）饱和度 8%；平衡 +10 偏向高光',
    '曲线：轻微 S 形（输入 64 → 60，输入 192 → 198），反差略增',
    'HSL：橙色 饱和度 +8、明度 +5（肤色红润）；蓝色 饱和度 −10',
    '不新增太阳、光束、光斑或任何物体',
  ]) },
  { name: '去噪修复', note: 'ISO 3200 → 200 的干净度', pad: 0, prompt: spec('修复画质，让它看起来像 ISO 200 拍摄的干净原片：', [
    '按 ISO 3200 高感噪点处理：明度降噪 40、彩色降噪 60（彩色斑点全部去除），细节保留 60',
    '去除 JPEG 8×8 方块、色带和边缘毛刺',
    '锐化：数量 30、半径 0.8px、蒙版 70，只锐化真实边缘，天空和皮肤等平坦区域不锐化，不出现白边光晕',
    '保留皮肤毛孔、发丝、织物、木材和原作笔触的真实纹理，不塑料、不磨皮，不创造原图没有的细节或文字',
  ]) },
  { name: '浅景深人像', note: '85mm f/1.4 · 焦外虚化', pad: 0, prompt: spec('模拟 85mm 焦段、f/1.4 大光圈拍摄的浅景深（不改变构图和透视）：', [
    '对焦平面在主体眼睛（无人物时为画面主体），主体本身清晰度完全保持',
    '背景虚化量随距离增加：紧贴主体的背景轻微虚化，远景强烈虚化成柔和色块；前景同样适度虚化',
    '焦外光斑为圆形、边缘柔和、无洋葱圈；点光源变成大小随距离变化的光斑',
    '主体边缘（发丝、衣物轮廓）过渡自然，不能有抠图感、光边或残留背景',
    '曝光、白平衡和色彩不变',
  ]) },
  { name: '高动态均衡', note: '−2 / 0 / +2EV 包围合成感', pad: 0, prompt: spec('做成 −2、0、+2EV 三张包围曝光合成后的自然高动态效果：', [
    '高光 −40：天空云层与窗外景色层次完整；阴影 +40：暗部细节可见',
    '白色色阶 −5、黑色色阶 −5，保证仍有真正的纯白点和纯黑点，画面不发灰',
    '局部对比（清晰度）+10，去雾 +5；禁止出现 HDR 光晕、黑边描边或卡通感',
    '整体亮度与原图接近，只压缩明暗范围；饱和度不变',
  ]) },
  { name: '柔和电影感', note: '哑光黑 · 轻青橙分离', pad: 0, prompt: spec('做克制的电影感调色（按 Rec.709 / Gamma 2.4 的调色思路处理，再按下方色彩管理输出）：', [
    '曲线：黑位抬到 10/255（柔和哑光黑），白点压到 240/255（高光柔和滚降），中间调对比 +10',
    '色彩分级：阴影 色相 195°（青蓝）饱和度 10%，高光 色相 35°（暖橙）饱和度 8%，肤色保持自然不发黄',
    '全局饱和度 −12，自然饱和度 +5；色温 −200K 略冷',
    '胶片颗粒 数量 10、大小 20（非常细）',
    '不加黑边、宽银幕遮幅、光晕、镜头眩光或景深虚化；照片保持照片质感，插画保持原画风',
  ]) },
  { name: '清透日系', note: '+0.7EV · 低反差淡青', pad: 0, prompt: spec('调成明亮通透的日系色调：', [
    '曝光补偿 +0.7EV，高光 −30 防止过曝，阴影 +30',
    '曲线：黑位抬到 18/255、中间调略提亮，反差降低约 20%',
    '白平衡 −300K 略冷，色调 −3 偏绿；色彩分级 阴影 色相 180°（淡青）饱和度 8%',
    'HSL：绿色 色相 +10 偏青、饱和度 −15；橙色 明度 +10（肤色通透）；蓝色 饱和度 −10',
    '整体饱和度 −10，画面干净、空气感强，不过曝、不泛白雾',
  ]) },
  { name: '克制扩图', note: '四周延伸 15%，原图中心保留', pad: .15, prompt: spec('四周延伸画面 15%，只补全新增区域：', [
    '延续原有地面、墙面、天空、窗景和植被，材质尺度与原图一致',
    '新增区域沿用原图的光圈与景深：与对焦平面同距离的物体同样清晰，更远处按原图的虚化程度逐渐虚化',
    '新增区域的 ISO 噪点颗粒、锐度、曝光、白平衡与原图一致，不能比原图更干净、更锐或更鲜艳',
    '优先补全安静可信的背景；不新增人物、不复制人物或肢体，不生成文字、水印和不合理结构',
  ], '') },
  { name: '空间延展', note: '四周延伸 25%，适合场景展示', pad: .25, prompt: spec('四周延伸画面 25%，展示更完整的空间：', [
    '地面、墙壁、天花板、道路、海岸线等结构按原图消失点连续延长，透视线笔直且汇聚到同一消失点',
    '光源方向、阴影长度与方向、反射和倒影与原图一致',
    '新增区域沿用原图的光圈景深、ISO 颗粒、锐度与色彩分级',
    '只根据相邻可见结构补全，避免重复家具、倾斜门框、悬空物体和不可能的几何；不新增人物和文字',
  ], '') },
] as const;

// 胶片模拟：按各家胶片 / 相机色彩模式公开的影调特点写成的修图指令（原创文字；参数是按影调特点
// 自拟的近似值，不是任何品牌的官方配方）。与上面的预设同样的约束：只改色彩、影调、对比与颗粒。
type Film = { name: string; note: string; prompt: string };
const film = (name: string, lines: string[]) => spec(`把照片调成${name}的色彩风格：`, lines);
const FILMS: { group: string; items: Film[] }[] = [
  { group: '富士', items: [
    { name: '经典正片', note: 'Classic Chrome · 低饱和纪实', prompt: film('富士“经典正片”（Classic Chrome）', [
      '全局饱和度 −25（明显降低但不褪成灰），自然饱和度 −5',
      'HSL：红色 色相 −5 偏砖红、饱和度 −10；蓝色 色相 −8 偏青、饱和度 −20；绿色 饱和度 −20',
      '曲线：中间调压暗（输入 128 → 120），阴影硬朗（输入 48 → 40），高光干净不过曝',
      '色彩分级：阴影 色相 190°（青）饱和度 8%；整体呈现克制冷静的纪实杂志感',
    ]) },
    { name: '经典负片', note: 'Classic Neg · 色彩分离', prompt: film('富士“经典负片”（Classic Neg）', [
      '反差 +20，饱和度 −15',
      '色彩分级：阴影 色相 170°（青绿）饱和度 15%；高光 在淡洋红（色相 330°）与暖黄（色相 50°）之间，饱和度 10%，色彩分离明显',
      '曲线：黑位抬到 8/255 带一点褪色，高光轻微压缩',
      '像九十年代冲印的彩色负片快照，肤色保持自然',
    ]) },
    { name: 'Velvia', note: '反转片 · 浓郁风光', prompt: film('富士 Velvia 50 反转片', [
      '饱和度 +30、自然饱和度 +15，色彩浓郁而通透',
      'HSL：蓝色 饱和度 +20、明度 −10（天空深邃）；绿色 饱和度 +25；红色 饱和度 +15',
      '曲线：强 S 形（输入 64 → 50，输入 192 → 205），黑位深但保留暗部层次，高光清澈',
      '人物肤色：橙色 饱和度 −10，避免过红；颗粒几乎为零（ISO 50 的细腻）',
    ]) },
    { name: 'Pro 400H', note: '淡雅通透 · 人像', prompt: film('富士 Pro 400H 负片', [
      '曝光补偿 +0.3EV，反差 −20，低对比、明亮通透',
      '色彩分级：阴影 色相 175°（淡青）饱和度 10%，高光 色相 340°（淡粉）饱和度 6%',
      'HSL：绿色 色相 +15 偏青绿、饱和度 −10；橙色 明度 +8（肤色干净白皙）',
      '高光柔和，带微微过曝的空气感；阴影不死黑；胶片颗粒 数量 12、大小 20',
    ]) },
    { name: 'Eterna 电影', note: '低饱和 · 柔和阴影', prompt: film('富士 Eterna 电影卷', [
      '饱和度 −30，反差 −25，影调平缓',
      '曲线：黑位抬到 14/255，白点压到 235/255，高光被轻轻压住',
      '色彩分级：阴影 色相 195°（青灰）饱和度 8%，中间调无偏色',
      '色彩安静克制，像电影母带调色前的质感',
    ]) },
    { name: 'Acros 黑白', note: '细腻颗粒 · 丰富灰阶', prompt: film('富士 Acros 100 黑白胶片', [
      '转为黑白；黑白混合：红 +10、黄 +5、蓝 −15（天空略深，肤色明亮）',
      '曲线：黑位深而干净（0–8 为纯黑），高光保留细节，中间调轻微 S 形带出立体感',
      '胶片颗粒 数量 20、大小 15、粗糙度 30：细腻均匀',
      '锐度保持原图，不生硬',
    ]) },
  ] },
  { group: '理光 GR', items: [
    { name: '正片', note: 'Positive Film · 街拍经典', prompt: film('理光 GR“正片”', [
      '饱和度 +15，反差 +15',
      'HSL：红色、黄色 饱和度 +15（浓郁）；蓝色 色相 −10 偏青',
      '色彩分级：阴影 色相 185°（清爽青）饱和度 12%；白平衡 −200K 略冷',
      '高光通透明亮，干净鲜明的日系街拍感',
    ]) },
    { name: '负片', note: 'Negative Film · 青绿复古', prompt: film('理光 GR“负片”', [
      '饱和度 −20，反差 −15，略微褪色',
      '曲线：黑位抬到 16/255',
      '色彩分级：阴影 色相 170°（青绿）饱和度 15%；高光 色相 45°（暖黄）饱和度 8%',
      '像过期彩色负片冲印出来的安静复古感',
    ]) },
    { name: '高对比黑白', note: '硬朗反差 · 粗颗粒', prompt: film('理光 GR 高对比黑白', [
      '转为黑白；曲线极陡：输入 80 以下压到接近纯黑，输入 180 以上推到接近纯白，中间调很少',
      '胶片颗粒 数量 45、大小 40、粗糙度 60：明显粗颗粒，相当于 ISO 3200 增感冲洗',
      '暗角 −10，带有街头摄影的粗粝与张力',
    ]) },
  ] },
  { group: '柯达与电影卷', items: [
    { name: 'Portra 400', note: '温暖自然 · 肤色', prompt: film('柯达 Portra 400 负片', [
      '白平衡 +300K 略暖，饱和度 −10，反差 −10',
      'HSL：橙色 饱和度 −5、明度 +5（肤色自然红润）；绿色 色相 −5 偏黄绿',
      '曲线：高光宽容度高、过渡平滑（输入 200 以上柔和滚降）；阴影 色相 30°（暖棕）饱和度 6%',
      '胶片颗粒 数量 15、大小 25',
    ]) },
    { name: 'Gold 200', note: '暖黄怀旧 · 日常', prompt: film('柯达 Gold 200 负片', [
      '白平衡 +600K 偏暖黄，阳光感明显，饱和度中等',
      'HSL：黄色、橙色 饱和度 +10；蓝色 色相 −10 偏青',
      '色彩分级：高光 色相 45°（暖黄）饱和度 12%；反差适中',
      '胶片颗粒 数量 25、大小 30，明显但不粗糙，像夏天随手拍的怀旧照片',
    ]) },
    { name: 'Ektar 100', note: '高饱和 · 细腻', prompt: film('柯达 Ektar 100 负片', [
      '饱和度 +25，反差 +15，色彩鲜艳纯净',
      'HSL：红色 饱和度 +15；蓝色 饱和度 +20、明度 −5',
      '颗粒几乎为零（ISO 100 的细腻），细节清晰；适合风光与城市',
    ]) },
    { name: 'CineStill 800T', note: '夜景 · 红色光晕', prompt: film('CineStill 800T 电影卷', [
      '白平衡按 3200K 钨丝灯设定：整体偏冷青蓝，暖色光源保持橙黄',
      '明亮光源与高光边缘出现柔和的红色光晕（halation），半径约为光源大小的 1–2 倍',
      '色彩分级：阴影 色相 190°（青）饱和度 15%；反差中等',
      '胶片颗粒 数量 30、大小 30（ISO 800 的明显颗粒），夜色电影感',
    ]) },
  ] },
];

export default function EditPromptPicker({ onSelect, strength, onStrengthChange, resolution, onResolutionChange, disabled = false }: {
  onSelect: (prompt: string, pad: number) => void;
  strength: 'gentle' | 'balanced';
  onStrengthChange: (value: 'gentle' | 'balanced') => void;
  resolution: '1k' | '2k' | 'original';
  onResolutionChange: (value: '1k' | '2k' | 'original') => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filmOpen, setFilmOpen] = useState(false);
  const pick = (key: string, prompt: string, pad: number) => { setSelected(key); onSelect(prompt, pad); };
  const selectedPrompt = selected === null ? null
    : selected.startsWith('p:') ? PRESETS[+selected.slice(2)].prompt
    : FILMS.flatMap(g => g.items).find(f => 'f:' + f.name === selected)?.prompt ?? null;
  return <section className="prompt-picker liquid-surface" aria-label="精细修图预设">
    <style>{`.prompt-picker{padding:22px;border:1px solid var(--line);border-radius:24px;margin-bottom:24px}.prompt-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.prompt-heading h2{font-size:17px;margin:0}.prompt-heading-controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.prompt-heading select{font:inherit;font-size:12px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}.prompt-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.prompt-tile{padding:13px;text-align:left;border:1px solid var(--line);border-radius:15px;background:var(--card);color:var(--ink);cursor:pointer;transition:transform .2s,background .2s}.prompt-tile[aria-pressed=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--card))}.prompt-tile:hover{transform:translateY(-2px)}.prompt-tile strong,.prompt-tile span{display:block}.prompt-tile strong{font-size:13px;font-weight:550}.prompt-tile span{font-size:11px;color:var(--ink3);margin-top:5px;line-height:1.5}.prompt-note{font-size:11px;color:var(--ink3);line-height:1.7;margin:14px 0 0}.prompt-preview{font-size:12px;line-height:1.85;color:var(--ink2);margin-top:14px}.prompt-preview summary{cursor:pointer;color:var(--accent)}.prompt-preview p{white-space:pre-line}.film-toggle{width:100%;display:flex;align-items:baseline;gap:10px;margin-top:16px;padding:12px 14px;border:1px dashed var(--line);border-radius:15px;background:none;color:var(--ink);cursor:pointer;text-align:left}.film-toggle span{font-size:14px;font-weight:600}.film-toggle small{font-size:11px;color:var(--ink3)}.film-toggle i{margin-left:auto;font-style:normal;color:var(--accent);font-size:16px}.film-group{margin-top:14px}.film-group h3{font-size:12px;font-weight:600;color:var(--ink2);margin:0 0 8px;letter-spacing:.02em}@media(max-width:600px){.prompt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.prompt-picker{padding:16px}.prompt-heading{align-items:flex-start}}@media(prefers-reduced-motion:reduce){.prompt-tile{transition:none}.prompt-tile:hover{transform:none}}`}</style>
    <div className="prompt-heading"><h2>从一个细致的想法开始</h2><div className="prompt-heading-controls"><label title="豆包输出的图片大小。1K 最快；原图尺寸是按 2K 生成后放大到原照片的像素尺寸"><span className="sr-only">输出分辨率</span><select value={resolution} disabled={disabled} onChange={e => onResolutionChange(e.target.value as '1k' | '2k' | 'original')}><option value="1k">输出 1K · 默认</option><option value="2k">输出 2K</option><option value="original">原图尺寸（2K 放大）</option></select></label><label><span className="sr-only">修图程度</span><select value={strength} disabled={disabled} onChange={e => onStrengthChange(e.target.value as 'gentle' | 'balanced')}><option value="gentle">轻度调整 · 默认</option><option value="balanced">适中调整</option></select></label></div></div>
    <div className="prompt-grid">{PRESETS.map((preset, index) => <button type="button" className="prompt-tile" key={preset.name} disabled={disabled} aria-pressed={selected === 'p:' + index} onClick={() => pick('p:' + index, preset.prompt, preset.pad)}><strong>{preset.name}</strong><span>{preset.note}</span></button>)}</div>
    <button type="button" className="film-toggle" aria-expanded={filmOpen} onClick={() => setFilmOpen(v => !v)}>
      <span>胶片模拟</span><small>富士 · 理光 GR · 柯达 · CineStill</small><i aria-hidden="true">{filmOpen ? '−' : '+'}</i>
    </button>
    {filmOpen && FILMS.map(group => <div className="film-group" key={group.group}>
      <h3>{group.group}</h3>
      <div className="prompt-grid">{group.items.map(film => <button type="button" className="prompt-tile" key={film.name} disabled={disabled} aria-pressed={selected === 'f:' + film.name}
        onClick={() => pick('f:' + film.name, film.prompt, 0)}><strong>{film.name}</strong><span>{film.note}</span></button>)}</div>
    </div>)}
    <p className="prompt-note">选择后填入下方，可继续修改参数再发送。提示词写到曝光补偿、白平衡、曲线、色彩分级、HSL 与颗粒，每个参数都附带它在画面上的效果；扩图保留原图中心。生成结果仍请与原图核对。</p>
    {selectedPrompt && <details className="prompt-preview"><summary>查看完整提示词</summary><p>{selectedPrompt}</p></details>}
  </section>;
}
