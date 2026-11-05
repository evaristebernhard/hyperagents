#!/usr/local/bin/python3
"""Bounded read-only export of one sandbox download through a private socket."""
import base64, json, os, socket, stat
s = socket.socket(socket.AF_UNIX); s.bind('/control/files.sock'); os.chmod('/control/files.sock', 0o600); s.listen(4)
while True:
    c, _ = s.accept()
    try:
        raw = b''
        while b'\n' not in raw and len(raw) < 1024:
            part = c.recv(1024)
            if not part: break
            raw += part
        name = json.loads(raw)['name']
        if not isinstance(name, str) or '/' in name or len(name) > 200: raise ValueError('name')
        parent = os.open('/work/downloads', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally: os.close(parent)
        info = os.fstat(fd)
        with os.fdopen(fd, 'rb') as f:
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 20971520: raise ValueError('size')
            data = f.read(20971521)
        if len(data) > 20971520: raise ValueError('size')
        c.sendall(json.dumps({'data': base64.b64encode(data).decode()}).encode())
    except Exception:
        try: c.sendall(b'{"error":"UNSAFE_DOWNLOAD"}')
        except OSError: pass
    finally: c.close()
