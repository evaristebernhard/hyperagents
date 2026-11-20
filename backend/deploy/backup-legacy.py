#!/usr/bin/env python3
"""Online SQLite backups plus private uploads; never modifies the old service."""
import argparse, hashlib, json, pathlib, shutil, sqlite3, datetime
p=argparse.ArgumentParser();p.add_argument('--source',default='../.data');p.add_argument('--destination',required=True);a=p.parse_args()
src=pathlib.Path(a.source).resolve();dst=pathlib.Path(a.destination).resolve()
if dst==src or src in dst.parents: raise SystemExit('Backup destination must be outside source')
dst.mkdir(mode=0o700,parents=True,exist_ok=False)
manifest=[]
for f in src.rglob('*'):
 if not f.is_file() or f.is_symlink() or f.name.endswith(('-wal','-shm')): continue
 target=dst/f.relative_to(src);target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 if f.suffix in ('.sqlite','.db'):
  with sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True) as origin,sqlite3.connect(target) as backup:
   origin.backup(backup)
   if backup.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity failed')
 else:shutil.copyfile(f,target)
 target.chmod(0o600);manifest.append({'path':str(f.relative_to(src)),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size})
(dst/'manifest.json').write_text(json.dumps({'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':manifest},indent=2));(dst/'manifest.json').chmod(0o600)
print(json.dumps({'backup':str(dst),'files':len(manifest)}))
