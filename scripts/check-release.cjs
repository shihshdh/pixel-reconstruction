const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('out');
const secrets = [];
if (fs.existsSync('.beam-token')) secrets.push(fs.readFileSync('.beam-token', 'utf8').replace(/^\uFEFF/, '').trim());
const backup = '.delivery-backup/启动入画.bat';
if (fs.existsSync(backup)) {
  const match = fs.readFileSync(backup, 'utf8').match(/ARK_API_KEY\s*=\s*([^\s"\r\n]+)/i);
  if (match?.[1]?.length > 20) secrets.push(match[1]);
}
// The companion's DeepSeek key lives only in this git-ignored file and Beam Secrets; it must never ship.
const deepseek = '.beam-tools/deepseek.env';
if (fs.existsSync(deepseek)) {
  const match = fs.readFileSync(deepseek, 'utf8').match(/DEEPSEEK_API_KEY\s*=\s*([^\s"\r\n]+)/i);
  if (match?.[1]?.length > 20) secrets.push(match[1]);
}
let count = 0;
function scan(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (/^(\.env|\.beam-token|\.netlify|artifacts|backend|scripts|node_modules|access\.json)/i.test(entry.name)) throw new Error('Private path in release: ' + path.relative(root, filename));
    if (entry.isDirectory()) scan(filename);
    else {
      const bytes = fs.readFileSync(filename); count++;
      if (secrets.some(secret => secret.length > 20 && bytes.includes(Buffer.from(secret)))) throw new Error('A private credential was found in: ' + path.relative(root, filename));
    }
  }
}
scan(root);
console.log(`Release checked: ${count} files; no known account keys or private directories found.`);
