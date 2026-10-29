import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createShellRuntime } from './shell-runtime.mjs';

const LIMIT = 64 * 1024;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `${quote(process.execPath)} -e ${quote(source)}`;

function fixture(t, options = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gearbox-shell-'));
  const root = path.join(temporary, 'root');
  mkdirSync(root);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return { temporary, root, runtime: createShellRuntime({ root, ...options }) };
}

async function waitForFile(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filename) && readFileSync(filename, 'utf8').trim()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${filename}`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // Minimal container init processes sometimes leave reparented zombies behind.
  // A zombie is dead and cannot retain pipe fds or execute any more commands.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (/^\s*[ZX]\s/.test(stat.slice(stat.lastIndexOf(')') + 1))) return false;
  } catch (error) {
    if (error.code === 'ENOENT' && existsSync('/proc/self/stat')) return false;
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  return true;
}

async function assertProcessStopped(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await delay(20);
  }
  assert.fail(`Process ${pid} is still running`);
}

function checkResult(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    'exitCode', 'signal', 'stdout', 'stderr', 'truncated', 'timedOut', 'cancelled', 'durationMs',
  ].sort());
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.equal(typeof result.truncated, 'boolean');
  assert.equal(typeof result.timedOut, 'boolean');
  assert.equal(typeof result.cancelled, 'boolean');
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
}

test('configuration validates root and concurrency without starting any command', (t) => {
  const { root, temporary } = fixture(t);
  assert.throws(() => createShellRuntime(), /root/);
  for (const value of ['', null, 12, 'bad\0path']) {
    assert.throws(() => createShellRuntime({ root: value }), /root/);
  }
  for (const value of [0, -1, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => createShellRuntime({ root, maxConcurrent: value }), /maxConcurrent/);
  }
  const file = path.join(temporary, 'file');
  writeFileSync(file, '');
  assert.throws(() => createShellRuntime({ root: file }), /directory/);
  const alias = path.join(temporary, 'root-alias');
  symlinkSync(root, alias);
  assert.equal(createShellRuntime({ root: alias }).normalize({ command: 'true' }).cwd, realpathSync(root));
});

test('normalize validates the complete argument shape and command/timeout limits', (t) => {
  const { root, runtime } = fixture(t);
  assert.deepEqual(runtime.normalize({ command: 'printf ok' }), {
    command: 'printf ok', cwd: realpathSync(root), timeoutSeconds: 30,
  });
  assert.deepEqual(runtime.normalize(Object.assign(Object.create(null), { command: 'true' })), {
    command: 'true', cwd: realpathSync(root), timeoutSeconds: 30,
  });
  for (const args of [null, undefined, [], 'true', 1, new Date(), Object.create({ command: 'true' })]) {
    assert.throws(() => runtime.normalize(args), /plain object/);
  }
  for (const args of [
    { command: 'true', env: {} },
    { command: 'true', shell: '/bin/sh' },
    { command: 'true', approval: true },
    { command: 'true', [Symbol('extra')]: true },
  ]) assert.throws(() => runtime.normalize(args), /Unexpected/);
  const hiddenField = { command: 'true' };
  Object.defineProperty(hiddenField, 'secret', { value: 1 });
  assert.throws(() => runtime.normalize(hiddenField), /Unexpected/);
  for (const command of [undefined, null, 42, '', ' \n\t', 'echo\0no']) {
    assert.throws(() => runtime.normalize({ command }), /command/);
  }
  assert.equal(runtime.normalize({ command: 'x'.repeat(8192) }).command.length, 8192);
  assert.throws(() => runtime.normalize({ command: 'x'.repeat(8193) }), /8192/);
  for (const timeoutSeconds of [0, 301, -1, 1.5, '30', null, NaN, Infinity]) {
    assert.throws(() => runtime.normalize({ command: 'true', timeoutSeconds }), /timeoutSeconds/);
  }
  for (const timeoutSeconds of [1, 300]) {
    assert.equal(runtime.normalize({ command: 'true', timeoutSeconds }).timeoutSeconds, timeoutSeconds);
  }
});

test('cwd resolves real directories and rejects traversal, prefix tricks, files, and symlink escapes', (t) => {
  const { root, temporary, runtime } = fixture(t);
  const nested = path.join(root, 'nested');
  const outside = path.join(temporary, 'root-sibling');
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(path.join(root, 'file'), 'not a directory');
  symlinkSync(nested, path.join(root, 'inside-link'));
  symlinkSync(outside, path.join(root, 'outside-link'));
  for (const cwd of [nested, 'nested', './nested/..', 'inside-link']) {
    const expected = cwd === './nested/..' ? root : nested;
    assert.equal(runtime.normalize({ command: 'true', cwd }).cwd, realpathSync(expected));
  }
  for (const cwd of ['..', '../root-sibling', outside, 'outside-link']) {
    assert.throws(() => runtime.normalize({ command: 'true', cwd }), /within root/);
  }
  for (const cwd of ['', null, 1, 'nested\0']) {
    assert.throws(() => runtime.normalize({ command: 'true', cwd }), /cwd/);
  }
  assert.throws(() => runtime.normalize({ command: 'true', cwd: 'file' }), /directory/);
  assert.throws(() => runtime.normalize({ command: 'true', cwd: 'missing' }), /ENOENT/);
});

test('normalize never executes; execute re-normalizes changed arguments and symlinks', async (t) => {
  const { root, temporary, runtime } = fixture(t, { maxConcurrent: 1 });
  const marker = path.join(root, 'marker');
  const args = runtime.normalize({ command: `printf approved > ${quote(marker)}` });
  assert.equal(existsSync(marker), false);
  args.extra = true;
  await assert.rejects(runtime.execute(args), /Unexpected/);
  assert.equal(existsSync(marker), false);
  delete args.extra;
  const result = await runtime.execute(args);
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'approved');

  const inside = path.join(root, 'inside');
  const outside = path.join(temporary, 'outside');
  const link = path.join(root, 'link');
  mkdirSync(inside);
  mkdirSync(outside);
  symlinkSync(inside, link);
  const mutable = { command: 'true', cwd: link };
  runtime.normalize(mutable);
  rmSync(link);
  symlinkSync(outside, link);
  await assert.rejects(runtime.execute(mutable), /within root/);
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});

test('uses real bash, separates stdout/stderr, handles nonzero exits, and ignores stdin', async (t) => {
  const { root, runtime } = fixture(t);
  mkdirSync(path.join(root, 'nested'));
  const result = await runtime.execute({
    command: '[[ -n "$BASH_VERSION" ]] || exit 99; printf "%s\\n" "$PWD"; printf problem >&2; if read -r input; then exit 98; fi; exit 7',
    cwd: 'nested',
  });
  checkResult(result);
  assert.equal(result.stdout, `${realpathSync(path.join(root, 'nested'))}\n`);
  assert.equal(result.stderr, 'problem');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);

  const signalled = await runtime.execute({ command: 'kill -TERM $$' });
  assert.equal(signalled.exitCode, null);
  assert.equal(signalled.signal, 'SIGTERM');
  assert.equal(signalled.timedOut, false);
  assert.equal(signalled.cancelled, false);
});

test('only minimal environment is supplied; no parent sentinel leaks and HOME is root', async (t) => {
  const { root, runtime } = fixture(t);
  const name = 'GEARBOX_SHELL_RUNTIME_TEST_SENTINEL';
  const old = process.env[name];
  process.env[name] = 'synthetic-test-value-not-a-credential';
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
  const result = await runtime.execute({ command: nodeCommand('process.stdout.write(JSON.stringify(process.env))') });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(result.stdout);
  assert.equal(env[name], undefined);
  assert.equal(env.HOME, realpathSync(root));
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.TMPDIR, tmpdir());
  assert.ok(Object.keys(env).every((key) => ['PATH', 'HOME', 'LANG', 'TMPDIR', 'PWD', 'SHLVL', '_'].includes(key)));
});

test('combined output is capped at 64KiB and excess output is drained to successful completion', async (t) => {
  const { runtime } = fixture(t);
  const result = await runtime.execute({ command: nodeCommand(`
    process.stdout.write('a'.repeat(32768));
    process.stderr.write('b'.repeat(2 * 1024 * 1024));
    process.stdout.write('c'.repeat(2 * 1024 * 1024));
  `) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), LIMIT);
  assert.equal(result.timedOut, false);
  const exact = await runtime.execute({ command: nodeCommand(`process.stdout.write('x'.repeat(${LIMIT}))`) });
  assert.equal(exact.stdout.length, LIMIT);
  assert.equal(exact.truncated, false);
});

test('UTF-8 survives chunk splits and truncation never returns a partial code point', async (t) => {
  const { runtime } = fixture(t);
  const split = await runtime.execute({ command: nodeCommand(`
    process.stdout.write(Buffer.from([0xf0, 0x9f]));
    setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 20);
  `) });
  assert.equal(split.stdout, '😀');
  assert.equal(split.truncated, false);

  const capped = await runtime.execute({ command: nodeCommand(`
    process.stdout.write('x' + '😀'.repeat(40000));
    process.stderr.write('é'.repeat(40000));
  `) });
  assert.equal(capped.exitCode, 0);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr) <= LIMIT);
  assert.equal((capped.stdout + capped.stderr).includes('\ufffd'), false);
  assert.equal((capped.stdout + capped.stderr).isWellFormed(), true);
});

test('malformed UTF-8 cannot expand returned text beyond the byte budget', async (t) => {
  const { runtime } = fixture(t);
  const result = await runtime.execute({
    command: nodeCommand('process.stdout.write(Buffer.alloc(100000, 0xff)); process.stderr.write("end")'),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= LIMIT);
  assert.equal((result.stdout + result.stderr).isWellFormed(), true);
});

test('pre-aborted commands never spawn and release their slot', async (t) => {
  const { root, runtime } = fixture(t, { maxConcurrent: 1 });
  const controller = new AbortController();
  controller.abort();
  const marker = path.join(root, 'must-not-exist');
  const result = await runtime.execute({ command: `printf no > ${quote(marker)}` }, { signal: controller.signal });
  checkResult(result);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(existsSync(marker), false);
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});

test('abort kills bash and its process-group child, waits for pipes, and frees capacity', async (t) => {
  const { root, runtime } = fixture(t, { maxConcurrent: 1 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pidFile = path.join(root, 'child.pid');
  const pending = runtime.execute({ command: `sleep 30 & printf '%s' "$!" > ${quote(pidFile)}; printf ready; wait` }, { signal: controller.signal });
  await waitForFile(pidFile);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, 'ready');
  await assertProcessStopped(pid);
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});

test('timeout kills the process group and releases the slot', async (t) => {
  const { root, runtime } = fixture(t, { maxConcurrent: 1 });
  const pidFile = path.join(root, 'timeout-child.pid');
  const result = await runtime.execute({
    command: `sleep 30 & printf '%s' "$!" > ${quote(pidFile)}; printf started; wait`,
    timeoutSeconds: 1,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, 'started');
  assert.ok(result.durationMs >= 900 && result.durationMs < 10000);
  await assertProcessStopped(Number(readFileSync(pidFile, 'utf8')));
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});

test('root exit cleans lingering children immediately, even when they retain output pipes', async (t) => {
  const { runtime } = fixture(t);
  const result = await runtime.execute({ command: 'sleep 30 & printf "%s" "$!"; exit 0', timeoutSeconds: 5 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.ok(result.durationMs < 4000);
  const pid = Number(result.stdout);
  assert.ok(Number.isInteger(pid) && pid > 1);
  await assertProcessStopped(pid);
});

test('concurrency defaults to two, rejects excess rather than queuing, and recovers', async (t) => {
  const { root, runtime } = fixture(t);
  const controllers = [new AbortController(), new AbortController()];
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const jobs = controllers.map((controller, index) => runtime.execute({
    command: `printf ready > ${quote(path.join(root, `slot-${index}`))}; sleep 30`,
  }, { signal: controller.signal }));
  await Promise.all([0, 1].map((index) => waitForFile(path.join(root, `slot-${index}`))));
  const blockedMarker = path.join(root, 'blocked');
  await assert.rejects(runtime.execute({ command: `touch ${quote(blockedMarker)}` }), {
    code: 'SHELL_CONCURRENCY_LIMIT',
  });
  assert.equal(existsSync(blockedMarker), false);
  controllers.forEach((controller) => controller.abort());
  const results = await Promise.all(jobs);
  assert.ok(results.every((result) => result.cancelled));
  assert.equal((await runtime.execute({ command: 'exit 9' })).exitCode, 9);
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});

test('invalid calls reject without reserving capacity', async (t) => {
  const { runtime } = fixture(t, { maxConcurrent: 1 });
  await assert.rejects(runtime.execute({ command: 'true', env: {} }), /Unexpected/);
  await assert.rejects(runtime.execute({ command: 'true' }, { signal: {} }), /AbortSignal/);
  assert.equal((await runtime.execute({ command: 'true' })).exitCode, 0);
});
