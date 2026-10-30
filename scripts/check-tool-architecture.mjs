import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (parent, child) => { const r = relative(parent, child); return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };

export function validatePlan(plan) {
  const errors = [];
  if (plan?.version !== 1 || plan?.kind !== 'implementation-plan-only' || plan?.runtimeAuthority !== false) errors.push('Plan must be explicitly non-authoritative runtime data.');
  if (!Array.isArray(plan?.references) || !plan.references.length) errors.push('Reference inventory is required.');
  const ids = new Set(), paths = new Set();
  for (const ref of plan?.references || []) {
    if (typeof ref.id !== 'string' || ids.has(ref.id)) errors.push('Reference IDs must be unique.');
    ids.add(ref.id);
    if (typeof ref.path !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ref.path) || paths.has(ref.path)) errors.push('Reference paths must be unique root-level directory names.');
    paths.add(ref.path);
    if (!/^[a-f0-9]{40}$/.test(ref.head || '')) errors.push('Each reference needs an exact source HEAD.');
    if (ref.productionImport !== false) errors.push('Reference checkouts cannot become production imports through this plan.');
    if (!Array.isArray(ref.licenseFiles) || !ref.licenseFiles.length || ref.licenseFiles.some(f => !/^[A-Za-z0-9_.-]+$/.test(f))) errors.push('License evidence must name checkout-root files.');
  }
  const families = plan?.families;
  if (!Array.isArray(families) || !families.length || new Set(families.map(f => f.id)).size !== families.length || families.some(f => !f.id || !f.owner || !f.next)) errors.push('Each tool family needs a unique ID, owner and next step.');
  if (!['design-not-bound', 'partial-cdp-bound'].includes(plan?.browser?.stage) || plan?.browser?.sessionScheduling !== 'serial' || plan?.browser?.automaticProviderFallback !== false) errors.push('Browser plan must use a reviewed implementation stage, serial sessions and no automatic fallback.');
  return errors;
}

// A limited static architecture check, not a JS parser, bundler or security sandbox.
export function checkArchitecture(root = defaultRoot, { checkouts = false, plan } = {}) {
  plan ??= JSON.parse(readFileSync(resolve(root, 'docs/architecture/tool-platform-plan.json'), 'utf8'));
  const errors = validatePlan(plan), references = [];
  if (errors.length) return { ok: false, mode: 'invalid-plan', errors, references };
  const referenceRoots = plan.references.map(ref => resolve(root, ref.path));
  const dockerLines = readFileSync(resolve(root, '.dockerignore'), 'utf8').split(/\r?\n/).map(s => s.trim());
  for (const ref of plan.references) {
    if (!dockerLines.includes('/' + ref.path + '/')) errors.push('Docker context must explicitly exclude /' + ref.path + '/.');
    if (dockerLines.some(line => line.startsWith('!') && line.includes(ref.path))) errors.push('Docker negation may reinclude reference ' + ref.path + '.');
  }
  function checkImport(file, specifier) {
    let target;
    if (specifier.startsWith('file:')) {
      try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); } catch { errors.push('Invalid file import in ' + relative(root, file)); return; }
    } else if (specifier.startsWith('.') || isAbsolute(specifier)) target = resolve(dirname(file), specifier);
    else return;
    if (referenceRoots.some(ref => within(ref, target))) errors.push('Production import crosses reference boundary: ' + relative(root, file));
  }
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, item.name);
      if (item.isSymbolicLink()) { errors.push('Source symlink needs explicit review: ' + relative(root, file)); continue; }
      if (item.isDirectory()) { if (!['node_modules', '.git'].includes(item.name)) scan(file); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(item.name) || /\.(test|spec)\./.test(item.name)) continue;
      const source = readFileSync(file, 'utf8');
      const imports = /\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
      for (const match of source.matchAll(imports)) checkImport(file, match[1]);
    }
  }
  for (const dir of ['src', 'server', 'scripts']) scan(resolve(root, dir));
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const values of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
    for (const value of Object.values(values || {})) {
      if (typeof value === 'string' && /^(file:|link:)/.test(value)) checkImport(resolve(root, 'package.json'), resolve(root, value.replace(/^(file:|link:)/, '')));
    }
  }
  if (pkg.workspaces) errors.push('Root workspaces were added; review reference isolation and revise this architecture check deliberately.');
  if (checkouts) {
    for (const ref of plan.references) {
      const path = resolve(root, ref.path);
      if (!existsSync(path)) { errors.push('Requested reference checkout is missing: ' + ref.path); continue; }
      if (lstatSync(path).isSymbolicLink() || !within(realpathSync(root), realpathSync(path))) { errors.push('Reference is not an in-project checkout: ' + ref.path); continue; }
      try {
        const git = args => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
        if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(path)) throw Error('not an independent checkout');
        const head = git(['rev-parse', 'HEAD']);
        const status = git(['status', '--porcelain']);
        if (head !== ref.head) errors.push('Reference HEAD drift requires review: ' + ref.path);
        for (const name of ref.licenseFiles) {
          const evidence = resolve(path, name);
          if (!existsSync(evidence) || !lstatSync(evidence).isFile() || lstatSync(evidence).isSymbolicLink()) errors.push('Missing regular license evidence: ' + ref.path + '/' + name);
        }
        references.push({ id: ref.id, path: ref.path, head, matchesPin: head === ref.head, workingTreeDirty: Boolean(status), role: ref.role });
      } catch { errors.push('Cannot inspect independent checkout: ' + ref.path); }
    }
  }
  return { ok: errors.length === 0, mode: checkouts ? 'plan-and-local-checkouts' : 'plan-and-build-boundaries', runtimeCapabilityVerified: false, errors, references };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--checkouts')) { console.error('Usage: node scripts/check-tool-architecture.mjs [--checkouts]'); process.exitCode = 2; }
  else {
    try { const result = checkArchitecture(defaultRoot, { checkouts: args.includes('--checkouts') }); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
    catch { console.error('Architecture check could not read required project files. No alternate resource was used.'); process.exitCode = 1; }
  }
}
