const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const job = JSON.parse(fs.readFileSync(process.env.JOB_FILE || 'artifacts/secure-job.json'));
  if (process.env.BEAM_API_URL) job.backend_url = process.env.BEAM_API_URL;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:3000');
    const findings = await page.evaluate(async job => {
      const base = job.backend_url;
      const headers = { 'X-Ruhua-Token': job.job_token };
      const transient = [];
      const read = async (url, init) => {
        for (let attempt = 0; ; attempt++) {
          const response = await fetch(url, init);
          if (attempt === 2 || ![502, 503, 504].includes(response.status)) return response;
          transient.push(response.status); await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, 900));
        }
      };
      const status = await read(base + '/status/' + job.call_id, { headers });
      const anonymous = await read(base + '/status/' + job.call_id);
      const forged = await read(base + '/status/' + job.call_id, { headers: { 'X-Ruhua-Token': 'a'.repeat(43) } });
      const bareFile = await read(base + '/file/' + job.job_id + '/original.jpg');
      const packedWithoutGrant = job.viewer_file ? await read(base + '/file/' + job.job_id + '/' + job.viewer_file, { headers: { Accept: 'application/vnd.pixel-reconstruction.splat+gzip' } }) : null;
      const files = await read(base + '/files/' + job.job_id, { headers }).then(r => r.json());
      let sceneRanges;
      if (job.viewer_file) {
        const scene = new URL(files.file_urls[job.viewer_file], base);
        const raw = await read(scene, { headers: { Range: 'bytes=32-63' } });
        const rawBytes = (await raw.arrayBuffer()).byteLength;
        const packet = await read(scene, { headers: { Accept: 'application/vnd.pixel-reconstruction.splat+gzip', Range: 'bytes=0-19' } });
        const packetBytes = new Uint8Array(await packet.arrayBuffer());
        sceneRanges = { rawStatus: raw.status, rawBytes, packetStatus: packet.status, packetBytes: packetBytes.length, magic: new TextDecoder().decode(packetBytes.slice(0, 8)), encoding: packet.headers.get('content-encoding') };
      }
      const original = new URL(files.file_urls['original.jpg'], base);
      const signed = await read(original);
      original.searchParams.set('sig', '0'.repeat(64));
      const tampered = await read(original);
      return { status: status.status, anonymous: anonymous.status, forged: forged.status, bareFile: bareFile.status, packedWithoutGrant: packedWithoutGrant?.status, signed: signed.status, tampered: tampered.status, sceneRanges, transient };
    }, job);
    console.log(JSON.stringify(findings));
    if (findings.status !== 200 || findings.signed !== 200 || [findings.anonymous, findings.forged, findings.bareFile, findings.tampered].some(s => ![401,403].includes(s))) throw new Error('Authorization check failed');
    if (findings.packedWithoutGrant && findings.packedWithoutGrant !== 403) throw new Error('Compressed scene must require a valid signature');
    if (findings.sceneRanges) {
      const r = findings.sceneRanges;
      if (r.rawStatus !== 206 || r.rawBytes !== 32 || r.packetStatus !== 206 || r.packetBytes !== 20 || r.magic !== 'PRSGZ001' || r.encoding) throw new Error('Range download compatibility failed');
    }
    fs.writeFileSync('artifacts/api-security-check.json', JSON.stringify(findings, null, 2));
    if (process.argv.includes('--edit')) {
      const response = await fetch(job.backend_url + '/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ruhua-Token': job.job_token },
        body: JSON.stringify({ job_id: job.job_id, prompt: '仅自然延伸四周环境，保持光影与透视连续。不新增人物、肢体或文字，中央画面原样保留。', pad_ratio: .15, edit_strength: 'gentle' }),
        signal: AbortSignal.timeout(240000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`Edit ${response.status}: ${result.detail || 'failed'}`);
      fs.writeFileSync('artifacts/secure-edit.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ edit: 'success', subject_preserved: result.subject_preserved }));
      const image = await fetch(new URL(result.file_url, job.backend_url));
      if (!image.ok) throw new Error('Edited-image download failed');
      fs.writeFileSync('artifacts/edited-protected.jpg', Buffer.from(await image.arrayBuffer()));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
