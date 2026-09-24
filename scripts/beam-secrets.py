"""Configure server-only secrets without printing values or passing them in argv."""
import os
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
token = (root / '.beam-token').read_text(encoding='utf-8-sig').strip()
os.environ['BEAM_TOKEN'] = token
import beam  # Select Beam gateway defaults before creating SDK clients.
from beta9.channel import ServiceClient
from beta9.config import ConfigContext
from beta9.clients.secret import CreateSecretRequest, ListSecretsRequest, UpdateSecretRequest

values = {'BEAM_API_TOKEN': token}
if len(sys.argv) > 1:
    gpu_url = sys.argv[1].strip()
    if not gpu_url.startswith('https://') or '.beam.cloud' not in gpu_url:
        raise SystemExit('Expected the deployed Beam GPU HTTPS endpoint.')
    values['RUHUA_GPU_URL'] = gpu_url

for filename in ('.env.local', '.beam-tools/ark.env'):
    if not (root / filename).is_file():
        continue
    text = (root / filename).read_text(encoding='utf-8-sig')
    match = re.search(r'(?im)^\s*(?:set\s+"?)?ARK_API_KEY\s*=\s*([^\s"\r\n]+)', text)
    if match and re.fullmatch(r'[A-Za-z0-9_-]{32,}', match.group(1)):
        values['ARK_API_KEY'] = match.group(1)
        break

# Whale companion chat: the site owner's DeepSeek key, read from a local
# git-ignored file (.beam-tools/ is ignored). Never printed, never in argv.
deepseek_file = root / '.beam-tools/deepseek.env'
if deepseek_file.is_file():
    text = deepseek_file.read_text(encoding='utf-8-sig')
    match = re.search(r'(?im)^\s*DEEPSEEK_API_KEY\s*=\s*([^\s"\r\n]+)', text)
    if not match or not re.fullmatch(r'sk-[A-Za-z0-9]{16,}', match.group(1)):
        raise SystemExit('.beam-tools/deepseek.env must contain one line: DEEPSEEK_API_KEY=sk-...')
    values['DEEPSEEK_API_KEY'] = match.group(1)

# Companion web search: the site owner's 博查 Bocha key, same rules as above.
bocha_file = root / '.beam-tools/bocha.env'
if bocha_file.is_file():
    text = bocha_file.read_text(encoding='utf-8-sig')
    match = re.search(r'(?im)^\s*BOCHA_API_KEY\s*=\s*([^\s"\r\n]+)', text)
    if not match:
        print('.beam-tools/bocha.env has no key yet; web search stays as it is.')
    elif re.fullmatch(r'[A-Za-z0-9_\-]{16,}', match.group(1)):
        values['BOCHA_API_KEY'] = match.group(1)
    else:
        raise SystemExit('.beam-tools/bocha.env must contain one line: BOCHA_API_KEY=sk-...')

config = ConfigContext(token=token, gateway_host='gateway.beam.cloud', gateway_port=443)
with ServiceClient(config=config) as client:
    listed = client.secret.list_secrets(ListSecretsRequest())
    if not listed.ok:
        raise SystemExit('Could not list Beam secrets.')
    existing = {item.name for item in listed.secrets}
    for name, value in values.items():
        result = client.secret.update_secret(UpdateSecretRequest(name=name, value=value)) if name in existing else client.secret.create_secret(CreateSecretRequest(name=name, value=value))
        if not result.ok:
            raise SystemExit('Failed to configure secret: ' + name)
        print('Configured server secret:', name)
if 'ARK_API_KEY' in values or 'ARK_API_KEY' in existing:
    (root / '.beam-tools/ark-enabled').write_text('1')
else:
    print('No ARK server secret is configured; users may supply their own key.')
if 'DEEPSEEK_API_KEY' in values or 'DEEPSEEK_API_KEY' in existing:
    (root / '.beam-tools/assist-enabled').write_text('1')
else:
    print('No DEEPSEEK server secret is configured; the whale companion chat stays off.')
if 'BOCHA_API_KEY' in values or 'BOCHA_API_KEY' in existing:
    (root / '.beam-tools/search-enabled').write_text('1')
else:
    print('No BOCHA server secret is configured; the companion answers without web search.')
