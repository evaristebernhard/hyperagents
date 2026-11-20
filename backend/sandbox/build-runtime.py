#!/usr/bin/env python3
"""Build user-owned, immutable Debian runtime bundles. No Docker, sudo or host installs.
Resolve upstream image tags only with --update-lock. Commit the resulting lock to reproduce.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tempfile, urllib.request, concurrent.futures, shlex, re, lzma, fcntl
from importlib.machinery import SourceFileLoader
fetch = SourceFileLoader('oci', str(pathlib.Path(__file__).with_name('fetch-oci.py'))).load_module()
HERE = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--prefix', default=str(pathlib.Path.home() / '.local/share/hyperagents/runtimes'))
parser.add_argument('--update-lock', action='store_true')
parser.add_argument('--refresh-packages', action='store_true')
parser.add_argument('--kind', choices=['browser', 'compute', 'all'], default='all')
a = parser.parse_args()
prefix = pathlib.Path(a.prefix).resolve(); prefix.mkdir(parents=True, exist_ok=True)
build_lock = open(prefix / '.build.lock', 'a')
fcntl.flock(build_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
lockfile = HERE / 'runtime.lock.json'
lock = json.loads(lockfile.read_text()) if lockfile.exists() else {'version': 1, 'images': {}}
images = {'python': ('library/python', '3.12-slim-bookworm'), 'node': ('library/node', '24-bookworm-slim')}
if a.update_lock:
    for key, (repo, tag) in images.items():
        digest, _ = fetch.manifest(repo, tag, fetch.token_for(repo))
        lock['images'][key] = {'repository': repo, 'digest': digest}
    lockfile.write_text(json.dumps(lock, indent=2) + '\n')
if set(lock['images']) != set(images): raise SystemExit('Missing runtime.lock.json. Resolve explicitly with --update-lock.')

def run(args):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE)
    if result.returncode:
        print(result.stdout, flush=True)
        raise RuntimeError('Build command failed: ' + args[0])
    return result.stdout

def shell(root, command, extra=None):
    # Build-only network access; runtime launchers have stricter namespace policy.
    return run(['bwrap', '--unshare-user', '--uid', '0', '--gid', '0', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent',
         '--bind', str(root), '/', '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
         *(extra or []), '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'DEBIAN_FRONTEND', 'noninteractive',
         '/bin/sh', '-ec', command])

def merge_deb(source, destination, root):
    for item in source.iterdir():
        target = destination / item.name
        if not target.parent.resolve().is_relative_to(root.resolve()): raise ValueError('Debian package path escape')
        if item.is_symlink():
            link = os.readlink(item)
            if link.startswith('/'): link = os.path.relpath(root / link.lstrip('/'), target.parent)
            if target.is_dir() and not target.is_symlink(): shutil.rmtree(target)
            else: target.unlink(missing_ok=True)
            target.symlink_to(link)
        elif item.is_dir():
            # Preserve usrmerge symlinks from the immutable base image.
            target.mkdir(exist_ok=True)
            merge_deb(item, target, root)
        else:
            if target.is_symlink(): target.unlink()
            shutil.copy2(item, target)

def apt_indexes(root):
    # Keep Debian signature validation; download through bounded direct requests.
    lists = root / 'var/lib/apt/lists'; lists.mkdir(parents=True, exist_ok=True)
    arch = 'arm64' if os.uname().machine == 'aarch64' else 'amd64'
    opener = urllib.request.build_opener()
    for archive, suite in [('debian', 'bookworm'), ('debian', 'bookworm-updates'), ('debian-security', 'bookworm-security')]:
        base = f'https://deb.debian.org/{archive}/dists/{suite}'
        name = f'deb.debian.org_{archive}_dists_{suite}'
        release = lists / (name + '_InRelease')
        with opener.open(base + '/InRelease', timeout=30) as response: release.write_bytes(response.read())
        run(['gpgv', '--keyring', str(root / 'usr/share/keyrings/debian-archive-keyring.gpg'), str(release)])
        checksums = release.read_text().split('SHA256:\n', 1)[1].split('\n', 100000)
        entry = next(line.split() for line in checksums if line.endswith(f' main/binary-{arch}/Packages.xz'))
        checksum, size, filename = entry
        cached = prefix / 'cache' / (checksum + '.xz')
        if not cached.exists():
            with opener.open(base + '/' + filename, timeout=60) as response: cached.write_bytes(response.read())
        data = cached.read_bytes()
        if len(data) != int(size) or hashlib.sha256(data).hexdigest() != checksum: raise ValueError('Debian index checksum mismatch')
        (lists / (name + f'_main_binary-{arch}_Packages')).write_bytes(lzma.decompress(data))

for kind in (['browser', 'compute'] if a.kind == 'all' else [a.kind]):
    stage = pathlib.Path(tempfile.mkdtemp(prefix=kind + '-', dir=prefix))
    try:
        print("Building " + kind, flush=True)
        root = stage / 'rootfs'
        image = lock['images']['python']
        print('Extract Python base', flush=True)
        fetch.pull(image['repository'], image['digest'], root, prefix / 'cache')
        node_root = stage / 'node'
        image = lock['images']['node']
        print('Extract Node binary', flush=True)
        fetch.pull(image['repository'], image['digest'], node_root, prefix / 'cache')
        shutil.copy2(node_root / 'usr/local/bin/node', root / 'usr/local/bin/node')
        shutil.rmtree(node_root)
        for sources in (root / 'etc/apt/sources.list.d').glob('*'):
            sources.write_text(sources.read_text().replace('http://', 'https://'))
        packages = ('chromium chromium-sandbox libglib2.0-bin gsettings-desktop-schemas xvfb openbox x11vnc xauth socat ca-certificates fonts-noto-cjk' if kind == 'browser' else 'fonts-wqy-zenhei poppler-utils')
        package_lock = lock.get('packages', {}).get(kind)
        if a.update_lock or a.refresh_packages or not package_lock:
            print("Validate Debian indexes", flush=True)
            apt_indexes(root)
            uris = shell(root, 'apt-get -y --print-uris --download-only -o APT::Sandbox::User=root -o Acquire::ForceHash=SHA256 --no-install-recommends install ' + packages)
            package_lock = []
            for line in uris.splitlines():
                if not line.startswith("'"): continue
                url, name, size, digest = shlex.split(line)
                package_lock.append({'url': url.replace('http://', 'https://'), 'name': name, 'size': int(size), 'digest': digest})
        cache = prefix / 'debs'; cache.mkdir(exist_ok=True)
        lock.setdefault('packages', {})[kind] = package_lock
        lockfile.write_text(json.dumps(lock, indent=2) + '\n')
        def download(package):
            target = cache / package['name']
            algorithm, expected = package['digest'].split(':', 1)
            def valid():
                if not target.exists(): return False
                data = target.read_bytes()
                return len(data) == package['size'] and hashlib.new(algorithm.lower().replace('sum',''), data).hexdigest() == expected
            for attempt in range(4):
                if valid(): break
                target.unlink(missing_ok=True)
                try:
                    req = urllib.request.Request(package['url'] + '?checksum=' + expected + '&attempt=' + str(attempt), headers={'Cache-Control': 'no-cache'})
                    with urllib.request.urlopen(req, timeout=60) as response, open(str(target) + '.tmp', 'wb') as f: shutil.copyfileobj(response, f)
                    os.rename(str(target) + '.tmp', target)
                except OSError:
                    if attempt == 3: raise
            if not valid(): raise ValueError('Debian package checksum mismatch: ' + package['name'])
            package['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
            return target
        print('Fetch ' + str(len(package_lock)) + ' verified Debian packages', flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor: debs = list(executor.map(download, package_lock))
        lock.setdefault('packages', {})[kind] = package_lock
        lockfile.write_text(json.dumps(lock, indent=2) + '\n')
        unpack = stage / 'unpack'
        for deb in sorted(debs):
            unpack.mkdir()
            run(['dpkg-deb', '-x', str(deb), str(unpack)])
            merge_deb(unpack, root, root)
            shutil.rmtree(unpack)
        if kind == 'compute':
            # Wheels, their hashes and the installed inventory are captured in manifest.json.
            wheels = prefix / 'wheels'; wheels.mkdir(exist_ok=True)
            wheel_lock = lock.get('wheels')
            if a.update_lock or not wheel_lock:
                run(['python3', '-m', 'pip', 'download', '--index-url', 'https://pypi.org/simple', '--dest', str(wheels), '--only-binary=:all:', '--python-version', '3.12', '--implementation', 'cp', '--abi', 'cp312', '--platform', 'manylinux_2_17_x86_64' if os.uname().machine == 'x86_64' else 'manylinux_2_17_aarch64', 'numpy==2.2.4', 'pandas==2.2.3', 'matplotlib==3.10.1', 'reportlab==4.3.1', 'pypdf==5.4.0', 'pillow==11.1.0'])
                wheel_lock = []
                for wheel in sorted(wheels.glob('*.whl')):
                    data = wheel.read_bytes()
                    # PyPI metadata gives a canonical URL and a second independent hash.
                    import zipfile
                    with zipfile.ZipFile(wheel) as z:
                        metadata = z.read(next(n for n in z.namelist() if n.endswith('.dist-info/METADATA'))).decode()
                    name = re.search(r'^Name: (.+)$', metadata, re.M)[1]
                    version = re.search(r'^Version: (.+)$', metadata, re.M)[1]
                    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response: metadata = json.load(response)
                    item = next(i for i in metadata['urls'] if i['filename'] == wheel.name)
                    checksum = hashlib.sha256(data).hexdigest()
                    if checksum != item['digests']['sha256']: raise ValueError('Wheel checksum mismatch')
                    wheel_lock.append({'name': wheel.name, 'sha256': checksum, 'url': item['url']})
                lock['wheels'] = wheel_lock; lockfile.write_text(json.dumps(lock, indent=2) + '\n')
            for wheel in wheel_lock:
                target = wheels / wheel['name']
                if not target.exists():
                    with urllib.request.urlopen(wheel['url'], timeout=60) as response: target.write_bytes(response.read())
                if hashlib.sha256(target.read_bytes()).hexdigest() != wheel['sha256']: raise ValueError('Wheel checksum mismatch')
            shell(root, 'python3 -m pip install --no-index --no-compile --find-links=/wheels numpy==2.2.4 pandas==2.2.3 matplotlib==3.10.1 reportlab==4.3.1 pypdf==5.4.0 pillow==11.1.0', ['--ro-bind', str(wheels), '/wheels'])
            shutil.copy2(HERE.parent / 'deploy/hyper_document.py', root / 'usr/local/lib/python3.12/site-packages/hyper_document.py')
            for name in ['inputs', 'work']: (root / name).mkdir(exist_ok=True)
        else:
            managed = root / 'etc/chromium/policies/managed'; managed.mkdir(parents=True, exist_ok=True)
            policy = json.loads((HERE.parent / 'deploy/browser-policy.json').read_text())
            # Chromium 156 suppresses CDP target attachment with DevTools=2.
            # The runtime's file, network and namespace policies are the boundary.
            policy['DeveloperToolsAvailability'] = 1
            policy['URLAllowlist'] += ['chrome://omnibox-popup.top-chrome/*', 'chrome://tab-search.top-chrome/*']
            (managed / 'hyperagents.json').write_text(json.dumps(policy, indent=2) + '\n')
            shutil.copy2(HERE.parent / 'deploy/openbox.xml', root / 'etc/xdg/openbox/rc.xml')
            for name in ['profile', 'work', 'control']: (root / name).mkdir(exist_ok=True)
            shutil.copy2(HERE / 'browser-files.py', root / 'usr/local/bin/hyper-browser-files.py')
            shutil.copy2(HERE / 'browser-init.sh', root / 'usr/local/bin/hyper-browser-init')
            os.chmod(root / 'usr/local/bin/hyper-browser-init', 0o755)
            # The package normally gets this bit from dpkg. Chromium must use userns,
            # never a setuid sandbox installed in a user-owned directory.
            (root / 'usr/lib/chromium/chrome-sandbox').chmod(0o755)
            shell(root, 'glib-compile-schemas /usr/share/glib-2.0/schemas && fc-cache -f')
        for p in ['var/cache/apt/archives', 'var/lib/apt/lists']:
            shutil.rmtree(root / p); (root / p).mkdir(parents=True)
        manifest = {'version': 1, 'kind': kind, 'images': lock['images'], 'files': {}}
        for p in sorted(root.rglob('*')):
            if p.is_symlink(): manifest['files'][str(p.relative_to(root))] = {'link': os.readlink(p)}
            elif p.is_file():
                manifest['files'][str(p.relative_to(root))] = {'sha256': hashlib.file_digest(open(p, 'rb'), 'sha256').hexdigest(), 'mode': p.stat().st_mode & 0o777}
        data = json.dumps(manifest, sort_keys=True, separators=(',', ':'))
        checksum = hashlib.sha256(data.encode()).hexdigest()
        (stage / 'manifest.json').write_text(data + '\n')
        (stage / 'manifest.sha256').write_text(hashlib.sha256((data + '\n').encode()).hexdigest() + '\n')
        destination = prefix / (kind + '-' + checksum[:16])
        if destination.exists():
            shutil.rmtree(stage)
        else:
            stage.rename(destination)
        temp = prefix / (kind + '.next'); temp.unlink(missing_ok=True); temp.symlink_to(destination.name)
        temp.replace(prefix / kind)
        print(json.dumps({'kind': kind, 'path': str(destination), 'checksum': checksum}), flush=True)
    finally:
        if stage.exists(): shutil.rmtree(stage)
