// 液态滑块的物理：左右两条边各挂一根弹簧。
// 目标在右边时，右边（前沿）弹簧更硬、先冲出去，左边（后沿）更软、慢半拍跟上——
// 移动中滑块被拉长，到位时前沿略微越过再回弹，读起来像一滴液体在槽里流动，而不是一块硬片平移。
// 拖动时两条边直接跟手（带越界阻尼），松手后再交给弹簧吸附。

export type Edges = { left: number; right: number };

const LEAD = { stiffness: 520, damping: 30 };   // 前沿：快、稍有过冲
const TRAIL = { stiffness: 260, damping: 26 };  // 后沿：慢半拍，形成拉伸

export class LiquidSpring {
  left: number; right: number;
  private vl = 0; private vr = 0;
  private target: Edges;
  dragging = false;

  constructor(initial: Edges) {
    this.left = initial.left; this.right = initial.right;
    this.target = { ...initial };
  }

  setTarget(target: Edges, immediate = false) {
    this.target = { ...target };
    if (immediate) { this.left = target.left; this.right = target.right; this.vl = this.vr = 0; }
  }

  /** 拖动：两条边整体跟手，保持宽度；越过两端时按 1/3 阻尼，像拉扯液面 */
  drag(center: number, width: number, min: number, max: number) {
    let c = center;
    if (c - width / 2 < min) c = min + width / 2 - (min + width / 2 - c) / 3;
    if (c + width / 2 > max) c = max - width / 2 + (c + width / 2 - max) / 3;
    const left = c - width / 2, right = c + width / 2;
    this.vl = (left - this.left) * 60; this.vr = (right - this.right) * 60;
    this.left = left; this.right = right;
  }

  /** 前进 dt 秒；返回是否仍在运动 */
  step(dt: number): boolean {
    if (this.dragging) return true;
    const movingRight = this.target.left + this.target.right > this.left + this.right;
    const l = movingRight ? TRAIL : LEAD, r = movingRight ? LEAD : TRAIL;
    // 半隐式欧拉，分步积分保证大 dt 下也稳定
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vl += (-l.stiffness * (this.left - this.target.left) - l.damping * this.vl) * h;
      this.vr += (-r.stiffness * (this.right - this.target.right) - r.damping * this.vr) * h;
      this.left += this.vl * h; this.right += this.vr * h;
    }
    const settled = Math.abs(this.left - this.target.left) < .05 && Math.abs(this.right - this.target.right) < .05
      && Math.abs(this.vl) < 1 && Math.abs(this.vr) < 1;
    if (settled) { this.left = this.target.left; this.right = this.target.right; this.vl = this.vr = 0; }
    return !settled;
  }

  /** 速度越快越“扁”：纵向略收，模拟液体被拉长时变薄 */
  get squash(): number {
    const speed = Math.abs(this.vl + this.vr) / 2;
    return Math.max(.86, 1 - speed / 9000);
  }
}
