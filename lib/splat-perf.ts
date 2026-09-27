// gaussian-splats-3d 0.4.7 的一处性能缺陷：SplatBuffer.getBucketIndex 对“未填满的桶”里的高斯
// 每次都从头线性扫描桶列表。压缩场景（.ksplat，compressionLevel ≥ 1）载入完成后，库会对全部高斯
// 调用两轮 getSplatCenter（建八叉树、算场景半径），每次都走这段扫描——八十多万个高斯在客户端里
// 实测主线程卡住 7 秒（“正在整理空间”），期间页面不能拖动、不能点。
//
// 这里给每个 section 预先算一张“高斯序号 → 桶序号”的表（O(n) 一次），之后每次查找 O(1)。
// 结果与原实现逐个相同；只在原型上替换一次，展示页与工作室共用。
type Section = {
  fullBucketCount: number; bucketSize: number; splatCount: number;
  partiallyFilledBucketLengths: ArrayLike<number>;
  __bucketTable?: Uint32Array;
};
type SplatBufferClass = { prototype: { getBucketIndex: (section: Section, localSplatIndex: number) => number; __fastBuckets?: boolean } };

export function patchSplatBuffer(GS: { SplatBuffer?: unknown }) {
  const SplatBuffer = GS.SplatBuffer as SplatBufferClass | undefined;
  if (!SplatBuffer?.prototype?.getBucketIndex || SplatBuffer.prototype.__fastBuckets) return;
  const original = SplatBuffer.prototype.getBucketIndex;
  SplatBuffer.prototype.__fastBuckets = true;
  SplatBuffer.prototype.getBucketIndex = function (section: Section, localSplatIndex: number) {
    const full = section.fullBucketCount * section.bucketSize;
    if (localSplatIndex < full) return Math.floor(localSplatIndex / section.bucketSize);
    let table = section.__bucketTable;
    if (!table) {
      const lengths = section.partiallyFilledBucketLengths;
      if (!lengths) return original.call(this, section, localSplatIndex);
      table = new Uint32Array(Math.max(0, section.splatCount - full));
      let at = 0;
      for (let b = 0; b < lengths.length && at < table.length; b++) {
        const bucket = section.fullBucketCount + b;
        const end = Math.min(table.length, at + lengths[b]);
        table.fill(bucket, at, end);
        at = end;
      }
      section.__bucketTable = table;
    }
    const i = localSplatIndex - full;
    return i < table.length ? table[i] : original.call(this, section, localSplatIndex);
  };
}
