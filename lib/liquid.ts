// 液态滑块的物理：左右两条边各挂一根弹簧。
// 目标在右边时，右边（前沿）弹簧更硬、先冲出去，左边（后沿）更软、慢半拍跟上——
// 移动中滑块被拉长，到位时前沿略微越过再回弹，读起来像一滴液体在槽里流动，而不是一块硬片平移。
// 拖动时两条边直接跟手（带越界阻尼），松手后再交给弹簧吸附。
//
// 参数按 Apple 的弹簧描述（response 为无阻尼周期，dampingFraction 为阻尼比）换算：
// 刚度 = (2π/response)²，阻尼 = 2·dampingFraction·(2π/response)。前沿 0.28s、后沿 0.42s，
// 阻尼比保证过冲不超过 3%——液体感来自两条边的时间差，而不是回弹。

export type Edges = { left: number; right: number };

export function springCoefficients(response: number, dampingFraction: number) {
  const omega = 2 * Math.PI / response;
  return { stiffness: omega * omega, damping: 2 * dampingFraction * omega };
}
const LEAD = springCoefficients(.28, .78);   // 前沿：先冲出去，过冲约 2%
const TRAIL = springCoefficients(.42, .86);  // 后沿：慢半拍跟上，形成拉伸

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

/** 单个数值的 Apple 式弹簧。改目标时从当前值与当前速度出发，所以连续改目标也不会跳变。 */
export class Spring {
  value: number; velocity = 0; target: number;
  private k: number; private c: number;
  constructor(value: number, response = .45, dampingFraction = .86) {
    this.value = this.target = value;
    ({ stiffness: this.k, damping: this.c } = springCoefficients(response, dampingFraction));
  }
  configure(response: number, dampingFraction: number) {
    ({ stiffness: this.k, damping: this.c } = springCoefficients(response, dampingFraction));
    return this;
  }
  set(value: number) { this.value = this.target = value; this.velocity = 0; }
  /** 前进 dt 秒；返回是否仍在运动 */
  step(dt: number): boolean {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += (-this.k * (this.value - this.target) - this.c * this.velocity) * h;
      this.value += this.velocity * h;
    }
    const scale = Math.max(1e-3, Math.abs(this.target) * 1e-3);
    if (Math.abs(this.value - this.target) < scale && Math.abs(this.velocity) < scale * 10) { this.value = this.target; this.velocity = 0; return false; }
    return true;
  }
}
