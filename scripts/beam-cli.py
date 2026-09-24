"""Run the Beam CLI with a locally stored key, never putting it in command arguments."""
import os
import re
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
token_path = root / '.beam-token'
if not token_path.is_file():
    raise SystemExit('Missing .beam-token. Save a Beam API key locally before deploying.')
token = token_path.read_text(encoding='utf-8-sig').strip()
if not token or any(c.isspace() for c in token):
    raise SystemExit('Invalid .beam-token file.')
env = dict(os.environ, BEAM_TOKEN=token)
if (root / '.beam-tools/ark-enabled').is_file():
    env['RUHUA_ENABLE_ARK'] = '1'
if (root / '.beam-tools/assist-enabled').is_file():
    env['RUHUA_ENABLE_ASSIST'] = '1'
if (root / '.beam-tools/search-enabled').is_file():
    env['RUHUA_ENABLE_SEARCH'] = '1'
# Let the browser on the current Netlify site call the API (CORS). Written by scripts/netlify-new-site.cjs.
site_record = root / '.netlify-site.json'
if site_record.is_file():
    try:
        import json
        site_url = str(json.loads(site_record.read_text(encoding='utf-8-sig')).get('url', ''))
        if re.fullmatch(r'https://[A-Za-z0-9.-]+', site_url):
            env['RUHUA_EXTRA_ORIGINS'] = site_url
    except ValueError:
        pass
beam = root / '.venv-beam/bin/beam'
workdir = root / 'backend/beam'
if not workdir.is_dir():
    workdir = root
# CLI tracebacks can include signed upload URLs. Keep diagnostics, not their query credentials.
process = subprocess.Popen([str(root / '.venv-beam/bin/python'), str(root / 'scripts/beam-cli-runtime.py'), *sys.argv[1:]], cwd=workdir, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
traceback = False
for line in process.stdout:
    if 'Traceback' in line:
        traceback = True
        print('Beam CLI request failed; the credential-bearing traceback was suppressed.', flush=True)
    if not traceback:
        print(re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?[redacted]', line), end='', flush=True)
code = process.wait()
if code:
    print('Beam CLI exited with status', code, flush=True)
raise SystemExit(code)
