"""Fallback source upload via a 60-second CPU sandbox when local TLS fails.

No GPU, ports, volumes or account secrets are attached. Only deployment source
and its narrowly scoped presigned upload descriptor cross this path.
"""
import base64
import json
from pathlib import Path
import requests
from beta9.sync import FileSyncer
from beam.cli.main import cli

archive_upload = FileSyncer._put_archive
delta_upload = FileSyncer._upload_delta


def put_archive(filename, url, headers):
    try:
        return archive_upload(filename, url, headers)
    except requests.RequestException:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname.endswith('.storage.dev'):
            raise RuntimeError('Unexpected source-upload destination') from None
        from beam import Sandbox
        from beam_app import API_IMAGE
        print('Local storage TLS unavailable; using a temporary CPU-only transfer (60-second lifetime).', flush=True)
        instance = None
        try:
            sandbox = Sandbox(cpu=0.1, memory=256, image=API_IMAGE, keep_warm_seconds=60,
                              authorized=True, sync_local_dir=False, ports=[], name='ruhua-deploy-transfer')
            # A transfer-only sandbox has no local code mount; avoid uploading an empty ZIP.
            sandbox.files_synced = True
            instance = sandbox.create()
            payload = json.dumps({'url': url, 'headers': dict(headers or {}),
                                  'body': base64.b64encode(Path(filename).read_bytes()).decode()})
            command = (
                "import sys,json,base64,requests; d=json.load(sys.stdin); "
                "r=requests.put(d['url'],headers=d['headers'],data=base64.b64decode(d['body']),timeout=45); "
                "print('Source upload HTTP',r.status_code); sys.exit(0 if r.status_code==200 else 1)"
            )
            process = instance.process.exec('python3', '-c', command, stdin=payload)
            status = process.wait(timeout=55)
            print('CPU transfer completed' if status == 0 else 'CPU transfer failed', flush=True)
            return status == 0
        except Exception as error:
            print('CPU transfer error: ' + type(error).__name__, flush=True)
            return False
        finally:
            if instance:
                instance.terminate()
                print('Temporary transfer container terminated.', flush=True)


def upload_delta(self, *args, **kwargs):
    try:
        return delta_upload(self, *args, **kwargs)
    except requests.RequestException:
        return None


FileSyncer._put_archive = staticmethod(put_archive)
FileSyncer._upload_delta = upload_delta
cli()
