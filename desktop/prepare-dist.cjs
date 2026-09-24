// 构建网站并把静态文件复制到 desktop/dist，供 Tauri 打包进客户端。
// 不复制 download/（安装包本身）；其余文件原样保留，图片、场景、视频不做任何压缩。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out');
const dist = path.join(__dirname, 'dist');

if (!process.argv.includes('--skip-site-build')) execSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error('没有找到网站构建结果 out/index.html');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(out, dist, { recursive: true, filter: src => path.relative(out, src).split(path.sep)[0] !== 'download' });
let files = 0, bytes = 0;
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(dist);
console.log(`dist: ${files} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
