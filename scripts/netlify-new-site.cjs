// Finds or creates the "Pixel Reconstruction" site on the Netlify account that
// scripts/netlify-cli-new.ps1 is logged in to, and records it in .netlify-site.json.
// The CLI's login token is read from its own config and never printed or saved elsewhere.
//   node scripts/netlify-new-site.cjs --check-login   exit 0 when logged in, 2 when not
//   node scripts/netlify-new-site.cjs                  ensure the site, print its URL
//   node scripts/netlify-new-site.cjs --print-id       print the recorded site id only
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const recordPath = path.join(root, '.netlify-site.json');
const NAMES = ['pixel-reconstruction', 'pixelreconstruction', 'pixel-reconstruction-site', 'pixel-reconstruction-3d'];

function token() {
  const config = path.join(root, '.netlify-local-new', 'netlify', 'Config', 'config.json');
  try {
    const data = JSON.parse(fs.readFileSync(config, 'utf8'));
    const user = data.users?.[data.userId];
    return user?.auth?.token || '';
  } catch { return ''; }
}

async function api(method, route, body) {
  const response = await fetch('https://api.netlify.com/api/v1' + route, {
    method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', 'User-Agent': 'pixel-reconstruction-deploy' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 200) }; }
  return { status: response.status, json };
}

async function main() {
  const arg = process.argv[2] || '';
  if (arg === '--check-login') process.exit(token() ? 0 : 2);
  if (arg === '--print-id') {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    process.stdout.write(record.id);
    return;
  }
  if (!token()) throw new Error('还没有登录新的 Netlify 账号。');
  const me = await api('GET', '/user');
  if (me.status !== 200) throw new Error('Netlify 登录已失效，请重新运行以重新登录。(' + me.status + ')');

  // Reuse a recorded site if it still belongs to this account.
  if (fs.existsSync(recordPath)) {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const found = await api('GET', '/sites/' + encodeURIComponent(record.id));
    if (found.status === 200) { report(found.json, false); return; }
  }
  // Or a site with one of our names already in this account.
  const mine = await api('GET', '/sites?filter=all&per_page=100');
  if (mine.status === 200 && Array.isArray(mine.json)) {
    const existing = mine.json.find(site => NAMES.includes(site.name));
    if (existing) { save(existing); report(existing, false); return; }
  }
  for (const name of NAMES) {
    const created = await api('POST', '/sites', { name });
    if (created.status === 201 || created.status === 200) { save(created.json); report(created.json, true); return; }
    if (created.status !== 422) throw new Error('创建站点失败 (' + created.status + '): ' + (created.json.message || ''));
    console.log(`名字 ${name} 已被占用，换下一个…`);
  }
  throw new Error('备选的站点名都被占用了，请在 scripts/netlify-new-site.cjs 里的 NAMES 加一个新名字。');
}

function save(site) {
  const url = (site.ssl_url || site.url || `https://${site.name}.netlify.app`).replace(/^http:/, 'https:').replace(/\/$/, '');
  fs.writeFileSync(recordPath, JSON.stringify({ id: site.id, name: site.name, url }, null, 2) + '\n');
}
function report(site, created) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  console.log(`${created ? '已创建' : '已找到'}站点：${record.url}  (站点名 ${site.name})`);
}

main().catch(error => { console.error('错误：' + error.message); process.exit(1); });
