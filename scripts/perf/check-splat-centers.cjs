// 使用真实压缩场景验证排序缓冲的逐位一致性及 transfer 隔离。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const GS = require('@mkkellogg/gaussian-splats-3d');
const THREE = require('three');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/splat-perf.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: exportsObject, Float32Array, Uint32Array });
exportsObject.patchSplatBuffer(GS);
const bytes = fs.readFileSync('public/scene/victoria.ksplat');
const buffer = new GS.SplatBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const transform = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(1, 0, 0, 0));
const count = buffer.getSplatCount();
const base = new Float32Array(count * 3);
buffer.fillSplatCenterArray(base, transform);
let fallbacks = 0;
const mesh = { dynamicMode: false, integerBasedDistancesComputation: false, scenes: [{}], splatDataTextures: { baseData: { centers: base } },
  getDataForDistancesComputation() { fallbacks++; return null; } };
exportsObject.reuseStaticSplatCenters(mesh);
for (const [start,end] of [[0,count-1],[35,1000]]) {
  const raw = new Float32Array((end-start+1)*3);
  buffer.fillSplatCenterArray(raw, transform, start, end, 0);
  const expected = new Float32Array((end-start+1)*4);
  for(let i=0;i<=end-start;i++) { expected.set(raw.subarray(i*3,i*3+3),i*4); expected[i*4+3]=1; }
  const actual = mesh.getDataForDistancesComputation(start,end);
  assert.equal(Buffer.compare(Buffer.from(expected.buffer),Buffer.from(actual.centers.buffer)),0);
  assert.ok(actual.sceneIndexes.every(x => x === 0));
  structuredClone(actual.centers, { transfer: [actual.centers.buffer] });
  assert.equal(base.length,count*3);
}
mesh.dynamicMode = true; mesh.getDataForDistancesComputation(0,1);
mesh.dynamicMode = false; mesh.splatDataTextures = undefined; mesh.getDataForDistancesComputation(0,1);
assert.equal(fallbacks,2);
console.log(`PASS: ${count} 个高斯，中心坐标逐位一致；局部范围、转移隔离及回退通过`);
