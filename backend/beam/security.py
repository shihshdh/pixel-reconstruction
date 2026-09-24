"""Per-job capabilities and expiring downloads; no cloud keys leave the server."""
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import time
from urllib.parse import urlencode

from storage import ROOT, admission_lock, atomic_json, job_path, read_json, valid_id

FILE_PATTERN = re.compile(r"^(original\.jpg|edit_[a-f0-9]{32}\.jpg|scene_[a-f0-9]{32}(?:\.ply|(?:_mobile)?\.splat)|camera_[a-f0-9]{32}\.mp4)$")
LINK_SECONDS = 86400


class AccessDenied(Exception):
    pass


class SigningUnavailable(Exception):
    pass


def create_access(job_id):
    token = secrets.token_urlsafe(32)
    atomic_json(job_path(job_id) / "access.json", {
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(), "created_at": time.time(),
    })
    return token


def access_record(job_id):
    if not valid_id(job_id):
        raise AccessDenied()
    record = read_json(job_path(job_id) / "access.json", {})
    if not re.fullmatch(r"[0-9a-f]{64}", str(record.get("token_sha256", ""))):
        raise AccessDenied()  # Old jobs are deliberately NOT grandfathered in.
    return record


def authorize(job_id, token):
    record = access_record(job_id)
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise AccessDenied()
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not hmac.compare_digest(digest, record["token_sha256"]):
        raise AccessDenied()


def signing_key():
    key = os.environ.get("BEAM_API_TOKEN", "")
    if not key:
        raise SigningUnavailable()
    return hmac.digest(key.encode(), b"ruhua-private-files-v1", "sha256")


def signature(job_id, filename, expires):
    message = f"{job_id}\n{filename}\n{expires}".encode()
    return hmac.new(signing_key(), message, hashlib.sha256).hexdigest()


def get_urls(job_id, filenames):
    access_record(job_id)
    expires = int(time.time()) + LINK_SECONDS
    urls = {}
    for name in filenames:
        if name and FILE_PATTERN.fullmatch(name) and (job_path(job_id) / name).is_file():
            query = urlencode({"expires": expires, "sig": signature(job_id, name, expires)})
            urls[name] = f"/file/{job_id}/{name}?{query}"
    return urls


def authorize_file(job_id, filename, expires, sig):
    access_record(job_id)
    if not FILE_PATTERN.fullmatch(filename) or not re.fullmatch(r"[0-9a-f]{64}", sig):
        raise AccessDenied()
    try:
        deadline = int(expires)
    except (ValueError, TypeError):
        raise AccessDenied()
    now = int(time.time())
    if deadline <= now or deadline > now + LINK_SECONDS + 60:
        raise AccessDenied()
    if not hmac.compare_digest(signature(job_id, filename, deadline), sig):
        raise AccessDenied()


def allow_upload(client_host, forwarded_for=""):
    """Best-effort IP throttling, not identity/authentication or a spend limit.

    Beam terminates the public request. Forwarded headers may be spoofable in
    some proxy setups; per-job authorization and the global daily cap remain
    independent controls. Store only a hash of the address and recent times.
    """
    candidate = (forwarded_for.split(",", 1)[0].strip() or client_host or "unknown")
    try:
        candidate = str(ipaddress.ip_address(candidate))
    except ValueError:
        candidate = client_host or "unknown"
    identity = hmac.new(signing_key(), candidate.encode(), hashlib.sha256).hexdigest()
    now = time.time()
    with admission_lock():
        path = ROOT / "limits" / "upload-ips.json"
        ledger = read_json(path, {})
        ledger = {key: [stamp for stamp in stamps if now - stamp < 60]
                  for key, stamps in ledger.items() if stamps and now - stamps[-1] < 60}
        recent = ledger.get(identity, [])
        if len(recent) >= 3:
            return False
        recent.append(now)
        ledger[identity] = recent
        atomic_json(path, ledger)
    return True
