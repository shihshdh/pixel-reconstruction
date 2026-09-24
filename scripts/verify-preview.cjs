const fs = require('node:fs');
(async () => {
  const base = 'https://ruhua-api-aa5d4d3-v6.app.beam.cloud';
  const job = JSON.parse(fs.readFileSync('artifacts/secure-job.json'));
  const started = Date.now();
  let response;
  for (let i = 0; i < 3; i++) {
    response = await fetch(base + '/files/' + job.job_id, { headers: { 'X-Ruhua-Token': job.job_token }, signal: AbortSignal.timeout(60000) });
    if (response.ok || ![502, 503, 504].includes(response.status)) break;
    await response.body.cancel();
  }
  if (!response.ok) throw new Error('File listing HTTP ' + response.status);
  const files = await response.json();
  if (!files.viewer_file || !files.file_urls[files.viewer_file]) throw new Error('Compact preview was not created');
  fs.writeFileSync('artifacts/secure-preview-job.json', JSON.stringify({ ...job, ...files, backend_url: base }, null, 2));
  const original = await fetch(new URL(files.file_urls['original.jpg'], base));
  if (!original.ok) throw new Error('Signed original HTTP ' + original.status);
  await original.arrayBuffer();
  console.log(JSON.stringify({ oldWorkUpgraded: true, viewer: files.viewer_file, signedOriginal: original.status, cpuSeconds: (Date.now() - started) / 1000 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
