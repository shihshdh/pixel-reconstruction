// Usage: node scripts/prepare-landing.cjs artifacts/landing.ply
// Deterministic SHARP → KSplat conversion using the project's pinned viewer library.
const fs = require('node:fs');
const path = require('node:path');
const GS = require('@mkkellogg/gaussian-splats-3d');
const THREE = require('three');

const source = process.argv[2] || 'artifacts/landing.ply';
const raw = fs.readFileSync(source);
const parsed = GS.PlyParser.parseToUncompressedSplatArray(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 0,
);
const output = path.resolve(__dirname, '../public/scene');
fs.mkdirSync(output, { recursive: true });
const manifest = { sourceSplats: parsed.splatCount, compressionLevel: 1, seed: 9131, variants: [] };

// Retain more of the original Gaussian footprint instead of blurring over missing
// samples with enlarged splats. The mobile variant still caps GPU memory/downloads.
for (const [name, fraction, scale] of [['landing.ksplat', .7, 1.12], ['landing-lo.ksplat', .4, 1.30]]) {
  let seed = 9131;
  // Periodic sampling aliases against SHARP's pixel grid and creates stripes.
  // Seeded uniform sampling preserves coverage without a visible grid pattern.
  const splats = parsed.splats.filter(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 < fraction;
  }).map(splat => {
    const copy = splat.slice();
    for (const axis of [3, 4, 5]) copy[axis] *= scale;
    return copy;
  });
  const buffer = GS.SplatBuffer.generateFromUncompressedSplatArrays(
    [{ splats, splatCount: splats.length, sphericalHarmonicsDegree: 0 }], 1, 1, new THREE.Vector3(),
  );
  fs.writeFileSync(path.join(output, name), Buffer.from(buffer.bufferData));
  const variant = { name, sampledSplats: splats.length, bytes: buffer.bufferData.byteLength, fraction, scale };
  manifest.variants.push(variant);
  console.log(JSON.stringify(variant));
}
fs.writeFileSync(path.join(output, 'scene-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
