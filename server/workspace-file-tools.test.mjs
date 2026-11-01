import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceFileTools } from './workspace-file-tools.mjs';

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tools-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'scratch');
  const tools = createWorkspaceFileTools({ enabled: ['Files'], root, approveAndRun: async (_request, run) => run(), ...options });
  return { temp, root, ...tools };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code && !e.message.includes(os.tmpdir()));
const create = (tools, content = 'hello', file = 'note.txt') => tools.execute('write_file', { path: file, content, createExclusive: true });

test('Files gating, no callback, denial, lazy private scratch and full approval', async t => {
  const disabled = await fixture(t, { enabled: [] });
  assert.deepEqual(disabled.definitions, []);
  const noApproval = await fixture(t, { approveAndRun: undefined });
  assert.deepEqual(noApproval.definitions.map(d => d.function.name), ['list_files', 'read_file']);
  await rejects(create(noApproval), 'UNAVAILABLE');
  let request;
  const denied = await fixture(t, { approveAndRun: async req => { request = req; } });
  assert.deepEqual((await denied.execute('list_files', {})).entries, []);
  await rejects(create(denied), 'APPROVAL_REQUIRED');
  await assert.rejects(fs.stat(denied.root), { code: 'ENOENT' });
  assert.equal(request.kind, 'file'); assert.equal(request.cwd, denied.root);
  assert.equal(JSON.parse(request.command).content, 'hello');
  const approved = await fixture(t, { approveAndRun: async (req, run) => { request = req; await run(); } });
  const result = await create(approved, '你好 🌻');
  assert.equal(result.path, 'note.txt');
  assert.equal((await fs.stat(approved.root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(approved.root, 'note.txt'))).mode & 0o777, 0o600);
  assert.equal((await approved.execute('read_file', { path: 'note.txt' })).content, '你好 🌻');
  assert.equal(JSON.parse(request.command).sha256, result.sha256);
});

test('CAS, exact unique edit, atomic concurrent writes and full old/new approval', async t => {
  let request;
  const tools = await fixture(t, { approveAndRun: async (req, run) => { request = req; return run(); } });
  const initial = await create(tools, 'one two');
  await rejects(tools.execute('write_file', { path: 'note.txt', content: 'oops' }), 'HASH_CONFLICT');
  const changed = await tools.execute('edit_file', { path: 'note.txt', oldText: 'two', newText: 'three', expectedHash: initial.sha256 });
  assert.deepEqual(JSON.parse(request.command), { operation: 'edit_file', path: 'note.txt', expectedHash: initial.sha256, sha256: changed.sha256, oldText: 'two', newText: 'three' });
  await rejects(tools.execute('edit_file', { path: 'note.txt', oldText: 'one', newText: 'bad', expectedHash: initial.sha256 }), 'HASH_CONFLICT');
  const outcomes = await Promise.allSettled(['A', 'B'].map(content => tools.execute('write_file', { path: 'note.txt', content, expectedHash: changed.sha256 })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'HASH_CONFLICT');
  const overlap = await create(tools, 'aaa', 'repeat.txt');
  await rejects(tools.execute('edit_file', { path: 'repeat.txt', oldText: 'aa', newText: 'b', expectedHash: overlap.sha256 }), 'NON_UNIQUE_EDIT');
  assert.equal(await fs.readFile(path.join(tools.root, 'repeat.txt'), 'utf8'), 'aaa');
  assert.equal((await fs.readdir(tools.root)).some(n => n.startsWith('.workspace-tmp-')), false);
});

test('double CAS recheck after approval catches external change without overwriting', async t => {
  const tools = await fixture(t); const initial = await create(tools);
  const raced = createWorkspaceFileTools({ enabled: ['Files'], root: tools.root,
    approveAndRun: async (_req, run) => { await fs.writeFile(path.join(tools.root, 'note.txt'), 'changed'); await run(); } });
  await rejects(raced.execute('write_file', { path: 'note.txt', content: 'bad', expectedHash: initial.sha256 }), 'HASH_CONFLICT');
  assert.equal(await fs.readFile(path.join(tools.root, 'note.txt'), 'utf8'), 'changed');
});

test('reject traversal, absolute paths, secrets, all symlink components and hardlinks', async t => {
  const tools = await fixture(t); await create(tools);
  for (const file of ['../other', '/etc/passwd', 'a/../b', 'a\\b', '.env', '.env.local', '.git/config', '.ssh/id_ed25519', 'credentials.json', 'private-key.txt', 'key.pem']) {
    await rejects(tools.execute('read_file', { path: file }), 'UNSAFE_PATH');
  }
  await fs.writeFile(path.join(tools.temp, 'outside.txt'), 'outside');
  await fs.symlink(path.join(tools.temp, 'outside.txt'), path.join(tools.root, 'link.txt'));
  await fs.symlink(tools.temp, path.join(tools.root, 'dir'));
  await fs.link(path.join(tools.temp, 'outside.txt'), path.join(tools.root, 'hard.txt'));
  for (const file of ['link.txt', 'dir/outside.txt', 'hard.txt']) await rejects(tools.execute('read_file', { path: file }), 'UNSAFE_PATH');
  assert.deepEqual((await tools.execute('list_files', {})).entries.map(e => e.path), ['note.txt']);
  const rooted = createWorkspaceFileTools({ enabled: ['Files'], root: path.join(tools.root, 'dir'), approveAndRun: async (_, run) => run() });
  await rejects(rooted.execute('list_files', {}), 'UNSAFE_PATH');
  await rejects(tools.execute('read_file', { path: 'note.txt', root: tools.temp }), 'INVALID_ARGUMENTS');
});

test('bounded UTF-8, offset/limit, invalid binary, size, abort and private key content', async t => {
  const tools = await fixture(t); await create(tools, 'a🌻中文');
  const read = await tools.execute('read_file', { path: 'note.txt', offset: 1, limit: 2 });
  assert.equal(read.content, '🌻中'); assert.equal(read.totalCharacters, 4); assert.equal(read.truncated, true);
  await rejects(create(tools, 'a'.repeat(16001), 'long.txt'), 'INVALID_ARGUMENTS');
  await rejects(create(tools, '\ud800', 'bad.txt'), 'INVALID_UTF8');
  await rejects(create(tools, '\u0000', 'nul.txt'), 'INVALID_UTF8');
  await rejects(create(tools, '-----BEGIN RSA PRIVATE KEY-----', 'data.txt'), 'PROTECTED_CONTENT');
  await fs.writeFile(path.join(tools.root, 'invalid.txt'), Buffer.from([0xff]));
  await rejects(tools.execute('read_file', { path: 'invalid.txt' }), 'INVALID_UTF8');
  await fs.writeFile(path.join(tools.root, 'large.txt'), 'a'.repeat(64001));
  await rejects(tools.execute('read_file', { path: 'large.txt' }), 'TOO_LARGE');
  const controller = new AbortController(); controller.abort();
  await rejects(tools.execute('list_files', {}, controller.signal), 'ABORTED');
  const duringApproval = new AbortController();
  const aborted = createWorkspaceFileTools({ enabled: ['Files'], root: tools.root, approveAndRun: async (_, run) => { duringApproval.abort(); return run(); } });
  await rejects(aborted.execute('write_file', { path: 'aborted.txt', content: 'x', createExclusive: true }, duringApproval.signal), 'ABORTED');
  await assert.rejects(fs.stat(path.join(tools.root, 'aborted.txt')), { code: 'ENOENT' });
});

test('export invokes real persistence with exact bytes and returns only adapter metadata', async t => {
  let persisted;
  const tools = await fixture(t, { persistFile: async payload => {
    persisted = payload;
    await fs.writeFile(path.join(tools.temp, 'persisted.txt'), payload.bytes);
    return { fileId: 'real-file-id', filename: payload.filename, url: '/api/files/real-file-id' };
  } });
  await create(tools, 'export 中文');
  const result = await tools.execute('export_file', { path: 'note.txt' });
  assert.equal(await fs.readFile(path.join(tools.temp, 'persisted.txt'), 'utf8'), 'export 中文');
  assert.equal(persisted.mimeType, 'text/plain; charset=utf-8');
  assert.equal(persisted.filename, 'note.txt');
  assert.equal(result.file.fileId, 'real-file-id');
  assert.equal(JSON.stringify(result).includes(tools.root), false);
  const broken = createWorkspaceFileTools({ enabled: ['Files'], root: tools.root, persistFile: async () => { throw new Error(tools.root); } });
  await rejects(broken.execute('export_file', { path: 'note.txt' }), 'FILE_OPERATION_FAILED');
});
