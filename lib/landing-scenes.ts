// 展示页轮流播放的 3D 场景。每个都由一张照片经 SHARP 重建（scripts/prepare-landing.cjs 转成 .ksplat）。
// 内参（width/height/fy）取自重建出的 PLY；reach 放大机位活动范围，focus 是注视点深度，
// 两者按场景的深度分布调：横移上限约为近景深度（不透明高斯深度的第 10 百分位）的 30%，
// 再大就会看到单张照片视锥外的空洞；focus 取主体所在的深度。
// 修改任一场景的文件后，把 version 改掉，否则浏览器会继续用一年缓存里的旧文件。

export type LandingScene = {
  id: string;
  name: string;         // 切换按钮上的名字
  place: string;
  caption: string;      // 向下滚动后的说明
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
};

// 六张 2560×1600 的照片没有 EXIF 焦距，SHARP 按 30mm 等效焦距估计内参，fy 相同
const WIDE = { width: 2560, height: 1600, fy: 2093.2124 };

export const LANDING_SCENES: LandingScene[] = [
  {
    id: "kelingking", name: "精灵坠崖", place: "印尼 · 佩尼达岛",
    caption: "眼前这片海岸，也只来自一张照片。",
    alt: "印尼佩尼达岛的精灵坠崖：恐龙背形状的海岬与海湾沙滩",
    width: 1586, height: 992, fy: 1297.0881, reach: 1.3, focus: 8.5, version: "kelingking-2",
    title: { lang: "id", lines: ["Satu foto,", "satu dunia utuh."] }, tint: "#5ed6c9", luma: .137,
  },
  {
    id: "london", name: "伦敦暮色", place: "英国 · 伦敦",
    caption: "窗外这片暮色，也只来自一张照片。",
    alt: "从窗内望向暮色中的伦敦：大本钟、议会大厦与车流",
    ...WIDE, reach: .75, focus: 22, version: "london-1",
    title: { lang: "en-GB", lines: ["One photograph,", "a whole world."] }, tint: "#ffb05c", luma: .131,
  },
  {
    id: "louvre", name: "卢浮宫", place: "法国 · 巴黎",
    caption: "这座宫殿与金字塔，也只来自一张照片。",
    alt: "夜晚的卢浮宫与玻璃金字塔，水池倒映着灯光",
    ...WIDE, reach: .95, focus: 13, version: "louvre-1",
    title: { lang: "fr", lines: ["Une photo,", "tout un monde."] }, tint: "#f0cb86", luma: .277,
  },
  {
    id: "seine", name: "河畔天鹅", place: "法国 · 巴黎 · 塞纳河",
    caption: "这段河岸与天鹅，也只来自一张照片。",
    alt: "夜色中的塞纳河，三只天鹅游过，对岸建筑灯火倒映在水面",
    ...WIDE, reach: 1.25, focus: 28, version: "seine-1",
    title: { lang: "fr", lines: ["Une image,", "un monde entier."] }, tint: "#b4c6ec", luma: .066,
  },
  {
    id: "california", name: "棕榈日落", place: "美国 · 加州海岸",
    caption: "这片海岸的日落，也只来自一张照片。",
    alt: "日落后的加州海岸，一排高大的棕榈树剪影映着橙色天际",
    ...WIDE, reach: 11, focus: 120, version: "california-1",
    title: { lang: "en-US", lines: ["One shot,", "a whole world."] }, tint: "#ff8a4c", luma: .276,
  },
  {
    id: "harbor", name: "海港烟花", place: "海港之夜",
    caption: "这一夜的烟花，也只来自一张照片。",
    alt: "黄昏的海港上空绽放烟花，码头上的人们坐着观看",
    ...WIDE, reach: 6.5, focus: 100, version: "harbor-1",
    title: { lang: "en", lines: ["One frame,", "an entire world."] }, tint: "#ff9d8c", luma: .174,
  },
  {
    id: "nice", name: "尼斯海滨", place: "法国 · 尼斯",
    caption: "这条海滨大道，也只来自一张照片。",
    alt: "午后阳光下的尼斯英国人漫步大道，棕榈树、斑马线与地中海",
    ...WIDE, reach: 3.8, focus: 24, version: "nice-1",
    title: { lang: "fr", lines: ["Un cliché,", "tout un monde."] }, tint: "#71c2ff", luma: .42,
  },
];

/** 每个场景停留多久后换到下一个（用户正在拖动探索时不换） */
export const SCENE_DWELL_MS = 16000;
