// 展示页轮流播放的 3D 场景。每个都由一张照片经 SHARP 重建（scripts/prepare-landing.cjs 转成 .ksplat）。
// 内参（width/height/fy）取自重建出的 PLY；reach 放大机位活动范围，focus 是注视点深度，
// 两者按场景的深度分布调：横移上限约为近景深度（不透明高斯深度的第 10 百分位）的 30%，
// 再大就会看到单张照片视锥外的空洞；focus 取主体所在的深度。
// 修改任一场景的文件后，把 version 改掉，否则浏览器会继续用一年缓存里的旧文件。

export type LandingScene = {
  id: string;
  name: string;         // 切换按钮上的名字
  place: string;
  alt: string;
  width: number; height: number; fy: number;
  reach: number; focus: number;
  version: string;
  /** 液态玻璃标题：当地语言的“一张照片，一整个世界。” */
  title: { lang: string; lines: [string, string] };
  /** 玻璃的色调，取自场景的主光 */
  tint: string;
  /** 原图标题区域的平均线性亮度（0–1）。越亮，标题下的压暗越多，而不是把玻璃染得更重 */
  luma: number;
  /** 手写诗句的墨色与光晕 */
  ink: string; halo: string;
};

// 深色墨水配浅色光晕在亮而杂的背景上（如灯光下的玻璃金字塔）发糊，实测都用浅色墨水 + 深色光晕更清楚，
// 墨色按场景主光取暖白、冷白、樱色、桃色等
const DARK_HALO = "rgba(6,10,8,.6)";

// 六张 2560×1600 的照片没有 EXIF 焦距，SHARP 按 30mm 等效焦距估计内参，fy 相同
const WIDE = { width: 2560, height: 1600, fy: 2093.2124 };

export const LANDING_SCENES: LandingScene[] = [
  {
    id: "victoria", name: "太平山", place: "中国香港 · 维多利亚港",
    alt: "从太平山俯瞰香港维多利亚港：中环高楼、海港与九龙",
    ...WIDE, reach: 8.5, focus: 150, version: "victoria-1",
    title: { lang: "zh-Hant", lines: ["一張照片，", "一整個世界。"] }, tint: "#8cc8ff", luma: .36,
    ink: "#f6f9ff", halo: DARK_HALO,
  },
  {
    // 玻璃色调取樱色：诗句是芭蕉写江户（东京）的“花の雲”
    id: "shibuya", name: "涩谷", place: "日本 · 东京",
    alt: "从涩谷高处俯瞰东京：代代木公园的森林、体育馆与远处的新宿高楼",
    ...WIDE, reach: 7, focus: 60, version: "shibuya-1",
    title: { lang: "ja", lines: ["一枚の写真、", "ひとつの世界。"] }, tint: "#ffb3c7", luma: .34,
    ink: "#fff5f8", halo: DARK_HALO,
  },
  {
    id: "kelingking", name: "精灵坠崖", place: "印尼 · 佩尼达岛",
    alt: "印尼佩尼达岛的精灵坠崖：恐龙背形状的海岬与海湾沙滩",
    width: 1586, height: 992, fy: 1297.0881, reach: 1.3, focus: 8.5, version: "kelingking-2",
    title: { lang: "id", lines: ["Satu foto,", "satu dunia utuh."] }, tint: "#5ed6c9", luma: .137,
    ink: "#fbf5dc", halo: DARK_HALO,
  },
  {
    id: "london", name: "伦敦暮色", place: "英国 · 伦敦",
    alt: "从窗内望向暮色中的伦敦：大本钟、议会大厦与车流",
    ...WIDE, reach: .75, focus: 22, version: "london-1",
    title: { lang: "en-GB", lines: ["One photograph,", "a whole world."] }, tint: "#ffb05c", luma: .131,
    ink: "#ffd9a8", halo: DARK_HALO,
  },
  {
    id: "louvre", name: "卢浮宫", place: "法国 · 巴黎",
    alt: "夜晚的卢浮宫与玻璃金字塔，水池倒映着灯光",
    ...WIDE, reach: .95, focus: 13, version: "louvre-1",
    title: { lang: "fr", lines: ["Une photo,", "tout un monde."] }, tint: "#f0cb86", luma: .277,
    ink: "#fff0d6", halo: DARK_HALO,
  },
  {
    id: "seine", name: "河畔天鹅", place: "法国 · 巴黎 · 塞纳河",
    alt: "夜色中的塞纳河，三只天鹅游过，对岸建筑灯火倒映在水面",
    ...WIDE, reach: 1.25, focus: 28, version: "seine-1",
    title: { lang: "fr", lines: ["Une image,", "un monde entier."] }, tint: "#b4c6ec", luma: .066,
    ink: "#e4ebff", halo: DARK_HALO,
  },
  {
    id: "california", name: "棕榈日落", place: "美国 · 加州海岸",
    alt: "日落后的加州海岸，一排高大的棕榈树剪影映着橙色天际",
    ...WIDE, reach: 11, focus: 120, version: "california-1",
    title: { lang: "en-US", lines: ["One shot,", "a whole world."] }, tint: "#ff8a4c", luma: .276,
    ink: "#ffcaa2", halo: DARK_HALO,
  },
  {
    id: "harbor", name: "海港烟花", place: "海港之夜",
    alt: "黄昏的海港上空绽放烟花，码头上的人们坐着观看",
    ...WIDE, reach: 6.5, focus: 100, version: "harbor-1",
    title: { lang: "en", lines: ["One frame,", "an entire world."] }, tint: "#ff9d8c", luma: .174,
    ink: "#ffe3d6", halo: DARK_HALO,
  },
  {
    id: "nice", name: "尼斯海滨", place: "法国 · 尼斯",
    alt: "午后阳光下的尼斯英国人漫步大道，棕榈树、斑马线与地中海",
    ...WIDE, reach: 3.8, focus: 24, version: "nice-1",
    title: { lang: "fr", lines: ["Un cliché,", "tout un monde."] }, tint: "#ffc978", luma: .42,
    ink: "#fff3de", halo: DARK_HALO,
  },
];

/** 每个场景停留多久后换到下一个（用户正在拖动探索时不换） */
export const SCENE_DWELL_MS = 16000;
