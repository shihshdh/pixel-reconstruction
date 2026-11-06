/** 保持原有线段顺序和 Float32 转换，只在批次之间让出主线程。 */
export async function decodeLineSegments(
  buf: ArrayBuffer, strokes: number, points: number, scale: number, lut: Float32Array,
  cancelled: () => boolean,
) {
  const offsets = new Uint32Array(buf, 0, strokes + 1);
  const xyzAt = (strokes + 1) * 4 + strokes + ((4 - strokes % 4) % 4);
  const xyz = new Int16Array(buf, xyzAt, points * 3);
  const rgb = new Uint8Array(buf, xyzAt + points * 6, points * 3);
  const pos = new Float32Array((points - strokes) * 6);
  const col = new Float32Array((points - strokes) * 6);
  let o = 0, started = performance.now();
  for (let s = 0; s < strokes; s++) {
    for (let j = offsets[s]; j + 1 < offsets[s + 1]; j++, o += 6) {
      if (o % (4096 * 6) === 0 && performance.now() - started >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (cancelled()) return null;
        started = performance.now();
      }
      for (let c = 0; c < 6; c++) {
        pos[o + c] = xyz[j * 3 + c] * scale;
        col[o + c] = lut[rgb[j * 3 + c]];
      }
    }
  }
  return cancelled() ? null : { pos: pos.subarray(0, o), col: col.subarray(0, o) };
}
