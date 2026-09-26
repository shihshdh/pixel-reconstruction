// 大窗口、全屏时整体等比放大界面（Apple 官网在大屏上的做法），而不是让组件缩在中间一小块。
// 以 1440×900 为 1 倍，按宽、高中较小的比例放大，最多 1.28 倍；窗口更小时保持 1 倍，由各页面自己的响应式布局处理。
// 缩放用 CSS zoom 作用在页面内容上。3D 画布跟着被放大后，内部渲染分辨率要按同一倍数补偿，否则会变糊：
// 渲染器取像素比时乘上 renderZoom(画布容器)。

export const UI_ZOOM_MAX = 1.28;

export function computeUiZoom(width = innerWidth, height = innerHeight) {
  const z = Math.min(width / 1440, height / 900);
  return Math.round(Math.max(1, Math.min(UI_ZOOM_MAX, z)) * 100) / 100;
}

/** 元素实际显示尺寸与布局尺寸之比（即祖先上 CSS zoom 的累积倍数） */
export function renderZoom(el: HTMLElement | null | undefined) {
  if (!el || !el.clientWidth) return 1;
  const ratio = el.getBoundingClientRect().width / el.clientWidth;
  return Number.isFinite(ratio) && ratio > .5 && ratio < 3 ? ratio : 1;
}
