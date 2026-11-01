import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
import { createManagedSkillTools } from './managed-skills.mjs';

// Explicit server configuration, never a model-supplied path or a credential file.
// Catalogs contain entrypoint policies and credential IDs, not credential values.
export function loadManagedSkillCatalog(file, root = process.cwd()) {
  if (file === undefined || file === '') return [];
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('APP_SKILL_CATALOG must be an absolute server configuration path.');
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024) throw Error('Invalid catalog file.');
    const catalog = JSON.parse(readFileSync(fd, 'utf8'));
    createManagedSkillTools({ enabled: true, root: path.resolve(root), catalog });
    return catalog;
  } catch { throw Error('Managed skill catalog is invalid or unavailable. No fallback catalog was installed.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
