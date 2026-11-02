// Run: node scripts/convert-site-images.cjs
// Keep originals as reproducible inputs. Bump VERSION and URLs when changing settings.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const VERSION = 'v1';
const root = path.resolve(__dirname, '..', 'public');

async function convert(source, target, width, quality) {
  const input = path.join(root, source), output = path.join(root, target);
  const newestInput = Math.max(fs.statSync(input).mtimeMs, fs.statSync(__filename).mtimeMs);
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= newestInput) {
    console.log(`unchanged ${target}`);
    return;
  }
  await sharp(input).rotate().resize({ width, withoutEnlargement: true })
    .webp({ quality, effort: 6, smartSubsample: true }).toFile(output);
  console.log(`${source}: ${fs.statSync(input).size} -> ${target}: ${fs.statSync(output).size}`);
}

(async () => {
  for (const name of fs.readdirSync(path.join(root, 'scene')).filter(name => name.endsWith('.jpg') && name !== 'landing.jpg')) {
    const id = path.basename(name, '.jpg');
    await convert(`scene/${name}`, `scene/${id}-1440-${VERSION}.webp`, 1440, 86);
    // Portrait cover on a DPR 3 phone needs the full source height, not a 393px thumbnail.
    await convert(`scene/${name}`, `scene/${id}-full-${VERSION}.webp`, 2048, 86);
  }
  await convert('rtx4090.png', `rtx4090-960-${VERSION}.webp`, 960, 90);
  await convert('rtx4090.png', `rtx4090-1600-${VERSION}.webp`, 1600, 90);
  for (const id of ['orbit', 'dolly', 'arc', 'zoom']) {
    await convert(`demo/demo-${id}.jpg`, `demo/demo-${id}-${VERSION}.webp`, 1280, 86);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
