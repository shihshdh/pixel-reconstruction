// Public gateway integration check. No account credentials are used here.
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BEAM_API_URL || 'https://ruhua-api-aa5d4d3-v4.app.beam.cloud';
const action = process.argv[2] || 'health';
const stateFile = path.resolve(process.env.BEAM_STATE_FILE || 'artifacts/secure-job.json');
async function request(url, init = {}, timeout = 120000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0,400)}`);
  return response;
}
(async () => {
  if (action === 'health') {
    const response = await request(base + '/healthz', { headers: { Origin: 'https://gausssharp.netlify.app' } });
    console.log(JSON.stringify({ ...(await response.json()), cors: response.headers.get('access-control-allow-origin') }));
  } else if (action === 'submit') {
    if (fs.existsSync(stateFile)) throw new Error('A landing job already exists; inspect it before submitting again.');
    const source = process.env.SOURCE_IMAGE || 'public/scene/landing.jpg';
    const body = new FormData();
    body.append('image', new Blob([fs.readFileSync(source)], { type: 'image/jpeg' }), 'landing.jpg');
    body.append('render_video', 'false'); body.append('enhance', 'false');
    // Persist the paid-request intent before POST: an ambiguous disconnect must not resubmit.
    fs.writeFileSync(stateFile, JSON.stringify({ intent: 'submission-started', backend_url: base, submitted_at: new Date().toISOString() }, null, 2));
    const job = await (await request(base + '/generate', { method: 'POST', body })).json();
    fs.writeFileSync(stateFile, JSON.stringify({ ...job, backend_url: base, submitted_at: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ call_id: job.call_id, job_id: job.job_id, access_grant_received: !!job.job_token }));
  } else {
    const job = JSON.parse(fs.readFileSync(stateFile));
    const status = await (await request(job.backend_url + '/status/' + job.call_id, { headers: { 'X-Ruhua-Token': job.job_token } })).json();
    console.log(JSON.stringify({status: status.status, message: status.message, stage: status.stage, predict_seconds: status.predict_seconds, total_seconds: status.total_seconds, timings: status.timings, viewer_bytes: status.viewer_bytes}));
    if (status.status === 'done') {
      fs.writeFileSync(stateFile, JSON.stringify({ ...job, ...status }, null, 2));
      if (action === 'download') {
        const response = await request(new URL(status.file_urls[status.ply_file], job.backend_url), {}, 180000);
        const destination = process.env.PLY_OUTPUT || 'artifacts/landing.ply';
        fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
        console.log('Saved ' + destination);
      }
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });


