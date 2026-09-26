// 展示页轮流播放的 3D 场景。每个都由一张照片经 SHARP 重建（scripts/prepare-landing.cjs 转成 .ksplat）。
// 内参（width/height/fy）取自重建出的 PLY；reach 放大机位活动范围，focus 是注视点深度，
// 两者按场景的深度分布调：远景为主的场景要走得更远才看得出视差。
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
};

export const LANDING_SCENES: LandingScene[] = [
  {
    id: "kelingking", name: "精灵坠崖", place: "印尼 · 佩尼达岛",
    caption: "眼前这片海岸，也只来自一张照片。",
    alt: "印尼佩尼达岛的精灵坠崖：恐龙背形状的海岬与海湾沙滩",
    width: 1586, height: 992, fy: 1297.0881, reach: 1.3, focus: 8.5, version: "kelingking-2",
  },
  {
    id: "hongkong", name: "中环", place: "中国香港",
    caption: "眼前这座城市，也只来自一张照片。",
    alt: "透过落地窗看到的香港中环高楼",
    width: 4096, height: 2731, fy: 3072.1208, reach: 1.5, focus: 30, version: "hongkong-1",
  },
];

/** 每个场景停留多久后换到下一个（用户正在拖动探索时不换） */
export const SCENE_DWELL_MS = 16000;
