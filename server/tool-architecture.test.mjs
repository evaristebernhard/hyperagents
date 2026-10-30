import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan, checkArchitecture } from '../scripts/check-tool-architecture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plan = JSON.parse(readFileSync(resolve(root, 'docs/architecture/tool-platform-plan.json'), 'utf8'));
function fixture(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'hyperagents-architecture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(resolve(dir, 'server'));
  writeFileSync(resolve(dir, 'package.json'), '{}');
  writeFileSync(resolve(dir, '.dockerignore'), plan.references.map(r => '/' + r.path + '/').join('\n') + '\n');
  return dir;
}
test('architecture inventory is planning data, never runtime authorization', () => {
  assert.deepEqual(validatePlan(plan), []);
  for (const ref of plan.references) assert.equal(ref.productionImport, false);
  assert.ok(plan.browser.blockedNativePassthrough.includes('login'));
  assert.ok(plan.browser.blockedNativePassthrough.includes('evaluate'));
  assert.ok(plan.browser.blockedNativePassthrough.includes('session_list'));
});
test('architecture validation fails closed on unsafe paths and runtime claims', () => {
  for (const mutate of [p => p.runtimeAuthority = true, p => p.references[0].path = '../other', p => p.references[0].productionImport = true, p => p.references[0].licenseFiles = ['../LICENSE'], p => p.browser.automaticProviderFallback = true, p => p.browser.stage = 'implemented']) {
    const changed = structuredClone(plan); mutate(changed); assert.ok(validatePlan(changed).length);
  }
});
test('project boundary check passes without requiring optional reference checkouts', () => {
  const result = checkArchitecture(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeCapabilityVerified, false);
});
test('boundary check rejects imported reference source but allows an owned browser service', t => {
  const dir = fixture(t);
  writeFileSync(resolve(dir, 'server/app.mjs'), "import { x } from './browser/provider.mjs';\n");
  assert.equal(checkArchitecture(dir, { plan }).ok, true);
  writeFileSync(resolve(dir, 'server/app.mjs'), "export { x } from '../browser/src/x.mjs';\n");
  assert.match(checkArchitecture(dir, { plan }).errors.join('\n'), /crosses reference boundary/);
  writeFileSync(resolve(dir, 'server/app.mjs'), "const x = import('../macro/foo.mjs');\n");
  assert.equal(checkArchitecture(dir, { plan }).ok, false);
});
test('boundary check rejects context reinclusion, local dependencies and unreviewed workspaces', t => {
  const dir = fixture(t);
  writeFileSync(resolve(dir, '.dockerignore'), '/browser/\n');
  assert.equal(checkArchitecture(dir, { plan }).ok, false);
  writeFileSync(resolve(dir, '.dockerignore'), plan.references.map(r => '/' + r.path + '/').join('\n') + '\n!browser/src\n');
  assert.equal(checkArchitecture(dir, { plan }).ok, false);
  writeFileSync(resolve(dir, '.dockerignore'), plan.references.map(r => '/' + r.path + '/').join('\n'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ dependencies: { external: 'file:macro' } }));
  assert.match(checkArchitecture(dir, { plan }).errors.join('\n'), /crosses reference boundary/);
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ workspaces: ['*'] }));
  assert.match(checkArchitecture(dir, { plan }).errors.join('\n'), /workspaces/);
});
test('explicit checkout audit reports missing resources and never substitutes another repository', t => {
  const dir = fixture(t);
  const result = checkArchitecture(dir, { plan, checkouts: true });
  assert.equal(result.ok, false);
  assert.equal(result.references.length, 0);
  assert.equal(result.errors.filter(e => e.includes('checkout is missing')).length, plan.references.length);
});
