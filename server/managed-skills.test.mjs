import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createManagedSkillTools } from './managed-skills.mjs';

async function fixture(t, source, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'script.mjs'), source);
  const catalog = [{ id: 'test', version: '1', entrypoints: { main: {
    interpreter: process.execPath, script: 'script.mjs', args: [], inputArgs: { minItems: 0, maxItems: 2, maxLength: 100 }, credentials: [], timeoutSeconds: 3, ...extra,
  } } }];
  return { root, catalog, input: { skillId: 'test', entrypoint: 'main', args: [] } };
}
const approve = async (_request, executor) => executor();

test('Skills opt-in, trusted catalog and approval callback gate exposure; strict args and symlink containment', async t => {
  assert.deepEqual(createManagedSkillTools().definitions, []);
  assert.deepEqual(createManagedSkillTools({ enabled: true }).definitions, []);
  const f = await fixture(t, 'console.log("ok")');
  const listOnly = createManagedSkillTools({ enabled: true, ...f });
  assert.deepEqual(listOnly.definitions.map(d => d.function.name), ['list_skill_scripts']);
  await assert.rejects(() => listOnly.execute('run_skill_script', f.input), { code: 'TOOL_UNAVAILABLE' });
  const tools = createManagedSkillTools({ enabled: true, ...f, approveAndRun: approve });
  await assert.rejects(() => tools.execute('run_skill_script', { ...f.input, endpoint: 'no' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(() => tools.execute('run_skill_script', { ...f.input, args: ['\n'] }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(() => tools.execute('run_skill_script', { ...f.input, args: new Array(1) }), { code: 'INVALID_ARGUMENTS' });
  await rm(path.join(f.root, 'script.mjs'));
  await symlink('/etc/passwd', path.join(f.root, 'script.mjs'));
  await assert.rejects(() => tools.execute('run_skill_script', f.input), { code: 'UNSAFE_SCRIPT' });
});

test('approval happens before all execution/credentials; exact quoted command, success and one-shot executor', async t => {
  const f = await fixture(t, 'import {writeFileSync} from "node:fs"; writeFileSync("marker", "ran"); console.log(JSON.stringify(process.argv.slice(2)));');
  let pending, request;
  const tools = createManagedSkillTools({ enabled: true, ...f, approveAndRun: async (r, executor) => {
    request = r; pending = executor;
    await assert.rejects(() => readFile(path.join(f.root, 'marker')), { code: 'ENOENT' });
    return { status: 'pending_approval' };
  } });
  const input = { ...f.input, args: ["a';echo bad", '--literal'] };
  assert.equal((await tools.execute('run_skill_script', input)).status, 'pending_approval');
  assert.equal(request.kind, 'skill');
  assert.match(request.command, /sha256=[a-f0-9]{64}$/);
  assert.ok(request.command.includes("'a'\\'';echo bad'"));
  const result = await pending();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.stdout), input.args);
  await assert.rejects(pending, { code: 'ALREADY_EXECUTED' });
});

test('denial does not touch credentials or start the script', async t => {
  const f = await fixture(t, 'throw Error("must not run")', { credentials: [{ id: 'token', env: 'TEST_TOKEN' }] });
  let credentials = 0;
  const tools = createManagedSkillTools({ enabled: true, ...f, credentialProvider: () => { credentials++; }, approveAndRun: async () => ({ status: 'denied' }) });
  assert.deepEqual(await tools.execute('run_skill_script', f.input), { status: 'denied' });
  assert.equal(credentials, 0);
});

test('approval binds script sha256 and canonical path (CAS)', async t => {
  const f = await fixture(t, 'console.log("original")');
  const tools = createManagedSkillTools({ enabled: true, ...f, approveAndRun: async (_r, executor) => {
    await writeFile(path.join(f.root, 'script.mjs'), 'console.log("changed")');
    return executor();
  } });
  const result = await tools.execute('run_skill_script', f.input);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'SCRIPT_CHANGED');
});

test('env-only credentials, minimal environment and cross-chunk redaction on both streams/nonzero failure', async t => {
  const secret = 'synthetic-SECRET-938572';
  const f = await fixture(t, `const s=process.env.TEST_TOKEN; if(process.env.HOME || process.env.NODE_OPTIONS || process.argv.includes(s)) throw Error('unsafe child environment'); process.stdout.write(s.slice(0,7)); setTimeout(()=>{process.stdout.write(s.slice(7));process.stderr.write(s);process.stderr.write(s.slice(0,6));process.exitCode=4;},30);`, { credentials: [{ id: 'token', env: 'TEST_TOKEN' }] });
  let approved = false;
  const tools = createManagedSkillTools({ enabled: true, ...f, credentialProvider: ({ credentialIds }) => {
    assert.equal(approved, true); assert.deepEqual(credentialIds, ['token']); return { token: secret };
  }, approveAndRun: async (r, executor) => { assert.ok(!JSON.stringify(r).includes(secret)); approved = true; return executor(); } });
  const result = await tools.execute('run_skill_script', f.input);
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '[redacted]'); assert.equal(result.stderr, '[redacted][redacted]');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('cancellation, timeout, hung credential lookup, output limit and descendant group cleanup are bounded', async t => {
  const f = await fixture(t, `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setInterval(()=>{},1000);`, { timeoutSeconds: 1 });
  const tools = createManagedSkillTools({ enabled: true, ...f, approveAndRun: approve });
  const controller = new AbortController();
  const pending = tools.execute('run_skill_script', f.input, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  const pid = Number(result.stdout.trim());
  if (pid) {
    // A killed descendant may briefly be a zombie until the system reaper collects it.
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.match(stat, /\) Z /); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  assert.equal((await tools.execute('run_skill_script', f.input)).status, 'timed_out');
  f.catalog[0].entrypoints.main.credentials = [{ id: 'token', env: 'TEST_TOKEN' }];
  const hung = createManagedSkillTools({ enabled: true, ...f, credentialProvider: () => new Promise(() => {}), approveAndRun: approve });
  assert.equal((await hung.execute('run_skill_script', f.input)).status, 'timed_out');
  await writeFile(path.join(f.root, 'script.mjs'), 'process.stdout.write("x".repeat(100000));');
  const overflow = await tools.execute('run_skill_script', f.input);
  assert.equal(overflow.status, 'output_limit'); assert.equal(overflow.stdout, '');
});
