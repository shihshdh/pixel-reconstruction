// Offline check against the exact parser shipped with this frontend.
// Usage: node backend/beam/verify_preview.cjs artifacts/landing.ply artifacts/landing-preview.splat
const fs = require('node:fs');
const assert = require('node:assert/strict');
const GS = require('@mkkellogg/gaussian-splats-3d');
const source = fs.readFileSync(process.argv[2]);
const preview = fs.readFileSync(process.argv[3]);
const offset = source.indexOf('end_header\n') + 11;
assert.ok(offset > 11);
const header = source.subarray(0, offset).toString('ascii');
const count = Number(header.match(/element vertex (\d+)/)[1]);
const vertexHeader = header.split(/element vertex \d+\n/)[1].split('element ')[0];
const properties = vertexHeader.trim().split('\n').filter(line => line.startsWith('property'));
assert.ok(properties.every(line => line.startsWith('property float ')));
const stride = properties.length * 4;
assert.equal(preview.byteLength, count * 32);
const sampleCount = Math.min(8192, count);
const sampleHeader = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + sampleCount + '\n' + properties.join('\n') + '\nend_header\n');
const plySample = Buffer.alloc(sampleHeader.length + sampleCount * stride);
const splatSample = Buffer.alloc(sampleCount * 32);
sampleHeader.copy(plySample);
for (let i = 0; i < sampleCount; i++) {
  const sourceIndex = Math.floor(i * (count - 1) / Math.max(1, sampleCount - 1));
  source.copy(plySample, sampleHeader.length + i * stride, offset + sourceIndex * stride, offset + (sourceIndex + 1) * stride);
  preview.copy(splatSample, i * 32, sourceIndex * 32, (sourceIndex + 1) * 32);
}
const arrayBuffer = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const original = GS.PlyParser.parseToUncompressedSplatArray(arrayBuffer(plySample), 0);
const converted = GS.SplatParser.parseStandardSplatToUncompressedSplatArray(arrayBuffer(splatSample));
assert.equal(original.splatCount, converted.splatCount);
let maxScaleRelativeError = 0, maxRotationDegrees = 0;
for (let i = 0; i < sampleCount; i++) {
  const a = original.splats[i], b = converted.splats[i];
  for (let axis = 0; axis < 3; axis++) assert.equal(a[axis], b[axis], 'Position changed');
  for (let axis = 3; axis < 6; axis++) {
    const error = Math.abs(a[axis] - b[axis]) / Math.max(Math.abs(a[axis]), 1e-30);
    maxScaleRelativeError = Math.max(maxScaleRelativeError, error);
    assert.ok(error < 2e-7, 'Scale changed beyond Float32 rounding');
  }
  for (let color = 10; color < 14; color++) assert.equal(a[color], b[color], 'RGBA changed');
  const dot = a[6] * b[6] + a[7] * b[7] + a[8] * b[8] + a[9] * b[9];
  const degrees = 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
  maxRotationDegrees = Math.max(maxRotationDegrees, degrees);
  assert.ok(degrees < 1.5, 'Quaternion differs beyond expected byte quantization');
}
console.log(JSON.stringify({ count, sampleCount, originalBytes: source.byteLength, previewBytes: preview.byteLength,
  reductionPercent: 100 * (1 - preview.byteLength / source.byteLength), maxScaleRelativeError, maxRotationDegrees }));
