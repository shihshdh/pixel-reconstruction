// One paid, explicitly requested performance verification; never replay a POST.
const fs = require('node:fs');
const base = process.env.BEAM_API_URL || 'https://ruhua-api-aa5d4d3-v7.app.beam.cloud';
const destination = process.env.BEAM_STATE_FILE || 'artifacts/optimized-speed-job.json';
const action = process.argv[2] || 'status';
async function read(url, init = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    if ([502, 503, 504].includes(response.status) && attempt < 2) { await response.body?.cancel(); await new Promise(r => setTimeout(r, 1000)); continue; }
    if (!response.ok) throw new Error('Read HTTP ' + response.status);
    return response.json();
  }
}
(async () => {
  if (action === 'submit') {
    if (fs.existsSync(destination)) throw new Error('Verification state already exists; inspect it instead of submitting again.');
    const source = JSON.parse(fs.readFileSync('artifacts/speed-job.json'));
    // Write an intent first. A dropped response must never trigger a blind retry.
    fs.writeFileSync(destination, JSON.stringify({ ...source, backend_url: base, verification: 'submission-pending', submitted_at: new Date().toISOString() }, null, 2));
    const response = await fetch(base + '/rerender', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ruhua-Token': source.job_token },
      body: JSON.stringify({ job_id: source.job_id, source: 'original.jpg' }), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('Submission HTTP ' + response.status + '; inspect server before any retry.');
    const accepted = await response.json();
    fs.writeFileSync(destination, JSON.stringify({ ...source, ...accepted, backend_url: base, verification: 'accepted', submitted_at: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ accepted: true, call_id: accepted.call_id }));
    return;
  }
  const job = JSON.parse(fs.readFileSync(destination));
  if (job.verification === 'submission-pending') throw new Error('Submission outcome unknown; inspect server tasks before continuing.');
  const result = await read(job.backend_url + '/status/' + job.call_id, { headers: { 'X-Ruhua-Token': job.job_token } });
  const report = { status: result.status, phase: result.phase, total_seconds: result.total_seconds, predict_seconds: result.predict_seconds, preview_seconds: result.preview_seconds, preview_engine: result.preview_engine, splat_count: result.splat_count, timings: result.timings, message: result.message };
  console.log(JSON.stringify(report));
  if (result.status === 'done') {
    fs.writeFileSync(destination, JSON.stringify({ ...job, ...result }, null, 2));
    fs.writeFileSync('artifacts/generation-optimized-report.json', JSON.stringify(report, null, 2));
  }
  if (result.status === 'error') process.exitCode = 1;
})().catch(error => { console.error(String(error.message).replace(/https?:\/\/\S+/g, '[URL redacted]')); process.exitCode = 1; });
