#!/usr/bin/env python3
"""Fetch a digest-locked Docker Hub rootfs without a daemon or privileged helper."""
import hashlib, json, os, pathlib, shutil, sys, tarfile, urllib.request, time
REGISTRY = 'https://registry-1.docker.io/v2/'

def request(url, token=None):
    headers = {'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    for attempt in range(5):
        try:
            opener = urllib.request.build_opener() if attempt % 2 == 0 else urllib.request.build_opener(urllib.request.ProxyHandler({}))
            return opener.open(urllib.request.Request(url, headers=headers), timeout=30)
        except OSError:
            if attempt == 4: raise
            time.sleep(1 + attempt)


def token_for(repo):
    with request('https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + repo + ':pull') as r:
        return json.load(r)['token']

def manifest(repo, reference, token):
    with request(REGISTRY + repo + '/manifests/' + reference, token) as r: data = r.read()
    digest = 'sha256:' + hashlib.sha256(data).hexdigest()
    if reference.startswith('sha256:') and reference != digest: raise ValueError('manifest checksum mismatch')
    value = json.loads(data)
    if 'manifests' in value:
        platform = 'arm64' if os.uname().machine == 'aarch64' else 'amd64'
        item = next(i for i in value['manifests'] if i.get('platform', {}).get('os') == 'linux' and i['platform'].get('architecture') == platform)
        return manifest(repo, item['digest'], token)
    return digest, value

def pull(repo, reference, dest, cache):
    dest = pathlib.Path(dest); cache = pathlib.Path(cache)
    cached = cache / ('manifest-' + reference.replace(':', '-') + '.json')
    if reference.startswith('sha256:') and cached.exists():
        data = cached.read_bytes()
        if hashlib.sha256(data).hexdigest() != reference.split(':', 1)[1]: raise ValueError('Cached manifest checksum mismatch')
        digest, value, token = reference, json.loads(data), None
    else:
        token = token_for(repo)
        digest, value = manifest(repo, reference, token)
        # Canonical original bytes are fetched once for exact digest verification.
        with request(REGISTRY + repo + '/manifests/' + digest, token) as response: data = response.read()
        if 'sha256:' + hashlib.sha256(data).hexdigest() != digest: raise ValueError('manifest checksum mismatch')
        cached.parent.mkdir(parents=True, exist_ok=True); cached.write_bytes(data)
    dest.mkdir(parents=True, exist_ok=True); cache.mkdir(parents=True, exist_ok=True)
    for layer in value['layers']:
        checksum = layer['digest'].removeprefix('sha256:')
        target = cache / checksum
        if not target.exists():
            if token is None: token = token_for(repo)
            with request(REGISTRY + repo + '/blobs/' + layer['digest'], token) as r, open(str(target) + '.tmp', 'wb') as f: shutil.copyfileobj(r, f)
            os.rename(str(target) + '.tmp', target)
        h = hashlib.sha256()
        with open(target, 'rb') as f:
            for chunk in iter(lambda: f.read(1048576), b''): h.update(chunk)
        if h.hexdigest() != checksum: raise ValueError('layer checksum mismatch')
        # Python's data filter checks traversal, symlink escape and special files.
        # OCI whiteouts are applied only beneath the resolved extraction root.
        with tarfile.open(target) as archive:
            for member in archive:
                if '/.wh.' in '/' + member.name:
                    p = dest / member.name
                    parent = p.parent.resolve()
                    if not parent.is_relative_to(dest.resolve()): raise ValueError('whiteout escape')
                    victims = list(parent.iterdir()) if p.name == '.wh..wh..opq' and parent.exists() else [parent / p.name.removeprefix('.wh.')]
                    for victim in victims:
                        if victim.is_dir() and not victim.is_symlink(): shutil.rmtree(victim)
                        else: victim.unlink(missing_ok=True)
                    continue
                if member.isdev(): continue
                if member.issym() and member.linkname.startswith('/'):
                    member.linkname = os.path.relpath(dest / member.linkname.lstrip('/'), (dest / member.name).parent)
                archive.extract(member, dest, filter='data')
    return digest

if __name__ == '__main__':
    print(pull(*sys.argv[1:]))
