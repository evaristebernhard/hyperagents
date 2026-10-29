import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from './tools.mjs';

const enabled = ['Thread Search', 'Documents', 'Webpages', 'Tables'];
function snapshot() {
  const data = () => ({ threads: [{ id: 't', title: 'Local thread', summary: 'needle summary', projectId: 'p', messages: [{ role: 'user', text: 'needle message', context: { attachments: [{ id: 'f', name: 'notes.txt', size: 10, mimeType: 'text/plain', createdAt: '2026-01-01', workspaceId: 'w' }], integrationIds: ['secret-connection'] } }] }, { id: 'other', title: 'Other', messages: [] }], projects: [{ id: 'p', name: 'needle project', description: 'description', goal: 'goal' }], skills: [{ id: 's', name: 'needle skill', documentation: 'actual docs', description: 'desc' }], memories: [{ id: 'm', content: 'needle memory', category: 'fact' }], artifacts: [{ id: 'a', title: 'needle artifact', kind: 'Document', content: 'original', threadId: 't', projectId: 'p', createdAt: '2026-01-01', updatedAt: '2026-01-02', versions: [{ id: 'v', content: 'old history', createdAt: '2025-01-01' }] }, { id: 'foreign-thread', title: 'Other artifact', kind: 'Document', content: 'other', threadId: 'other', createdAt: '2026-01-01', updatedAt: '2026-01-02', versions: [] }], connections: [{ id: 'secret-connection', label: 'needle private', endpoint: 'SECRET' }] });
  const foreign = data(); foreign.threads = [{ id: 'foreign-t', title: 'FOREIGN-SECRET' }]; foreign.artifacts = [{ id: 'foreign-a', title: 'FOREIGN-SECRET', content: 'FOREIGN-SECRET' }];
  return { version: 1, active: 'foreign', workspaces: [{ id: 'w', name: 'W', data: data() }, { id: 'foreign', name: 'Foreign', data: foreign }] };
}
const runtime = (options = {}) => createWorkspaceTools({ state: snapshot(), workspaceId: 'w', threadId: 't', enabled, ...options });

test('resolves exact workspace and thread, never active workspace', async () => {
  const r = runtime();
  const result = await r.execute('workspace_search', { query: 'FOREIGN-SECRET' });
  assert.deepEqual(result.results, []);
  await assert.rejects(r.execute('resource_read', { type: 'artifact', id: 'foreign-a' }), /not found/);
  assert.throws(() => runtime({ workspaceId: 'unknown' }), /not found/);
  assert.throws(() => runtime({ threadId: 'foreign-t' }), /not found/);
  const found = await r.execute('workspace_search', { query: 'needle' });
  assert.equal(found.results.length, 5);
  assert.ok(!JSON.stringify(found).includes('SECRET'));
  assert.deepEqual((await r.execute('workspace_search', { query: 'private' })).results, []);
});

test('create/read/update use isolated overlay, preserve history and original base', async () => {
  const state = snapshot(), original = structuredClone(state);
  const r = runtime({ state });
  const created = await r.execute('create_artifact', { title: ' New ', kind: 'Document', content: 'initial' });
  assert.equal(created.status, 'prepared');
  assert.match(created.id, /^artifact-[0-9a-f-]{36}$/);
  await r.execute('update_artifact', { id: created.id, content: 'final' });
  assert.equal((await r.execute('resource_read', { type: 'artifact', id: created.id })).content, 'final');
  await r.execute('update_artifact', { id: 'a', content: 'second', title: 'Renamed' });
  await r.execute('update_artifact', { id: 'a', content: 'third' });
  const patches = r.patches();
  assert.equal(patches.length, 2);
  assert.equal(patches[0].base, undefined);
  assert.equal(patches[0].artifact.threadId, 't');
  assert.equal(patches[0].artifact.projectId, 'p');
  assert.equal(patches[0].artifact.versions[0].content, 'initial');
  assert.deepEqual(patches[1].base, { title: 'needle artifact', content: 'original', updatedAt: '2026-01-02' });
  assert.deepEqual(patches[1].artifact.versions.map(v => v.content), ['old history', 'original', 'second']);
  assert.equal(patches[1].artifact.createdAt, '2026-01-01');
  assert.equal(patches[1].artifact.content, 'third');
  patches[1].base.content = 'tampered'; patches[1].artifact.content = 'tampered';
  assert.equal(r.patches()[1].base.content, 'original');
  assert.equal(r.patches()[1].artifact.content, 'third');
  assert.deepEqual(state, original);
});

test('refuses foreign-thread updates and unauthorized artifact kinds', async () => {
  const r = runtime({ enabled: ['Documents'] });
  await assert.rejects(r.execute('update_artifact', { id: 'foreign-thread', content: 'overwrite' }), /current thread/);
  await assert.rejects(r.execute('create_artifact', { title: 'x', kind: 'Webpage', content: 'html' }), /disabled/);
  await assert.rejects(r.execute('create_table', { title: 'x', columns: ['a'], rows: [] }), /disabled/);
  assert.deepEqual(r.patches(), []);
  const search = runtime({ enabled: ['Thread Search'] });
  assert.deepEqual(search.definitions.map(d => d.function.name), ['workspace_search', 'resource_read', 'resource_read_page']);
  await assert.rejects(search.execute('update_artifact', { id: 'a', content: 'bad' }), /disabled/);
  const none = runtime({ enabled: ['Browser'] });
  assert.deepEqual(none.definitions, []);
  await assert.rejects(none.execute('resource_read', { type: 'thread', id: 't' }), /disabled/);
});

test('schemas and runtime reject extra keys, missing fields, wrong types and empty search', async () => {
  for (const d of runtime().definitions) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.parameters.additionalProperties, false);
    assert.ok(Array.isArray(d.function.parameters.required));
  }
  const invalid = [
    ['workspace_search', { query: '' }], ['workspace_search', { query: '  ' }],
    ['workspace_search', { query: 'x', workspaceId: 'foreign' }], ['resource_read', { type: 'connection', id: 'secret-connection' }],
    ['resource_read', { type: 'thread' }], ['create_artifact', { title: 'x', kind: 'Document', content: 42 }],
    ['create_artifact', { title: 'x', kind: 'File', content: 'x' }], ['update_artifact', { id: 'a', content: 'x', threadId: 'other' }],
    ['resource_read', null], ['resource_read', []], ['resource_read', '{"type":"thread"}'],
  ];
  for (const [name, args] of invalid) await assert.rejects(runtime().execute(name, args), /Invalid/);
  await assert.rejects(runtime().execute('exec', { command: 'ls' }), /unavailable/);
});

test('file reads authorize workspace metadata before injected reader, unreadable is explicit', async () => {
  const calls = [];
  const r = runtime({ readAttachment: async (meta, workspaceId) => { calls.push({ meta, workspaceId }); meta.name = 'mutation'; return 'actual bytes'; } });
  assert.equal((await r.execute('resource_read', { type: 'file', id: 'f' })).content, 'actual bytes');
  assert.equal(calls[0].workspaceId, 'w');
  assert.equal((await r.execute('workspace_search', { query: 'notes', type: 'file' })).results[0].title, 'notes.txt');
  await assert.rejects(r.execute('resource_read', { type: 'file', id: 'foreign-file' }), /not found/);
  assert.equal(calls.length, 1);
  const mismatched = snapshot();
  mismatched.workspaces[0].data.threads[0].messages[0].context.attachments[0].workspaceId = 'foreign';
  await assert.rejects(runtime({ state: mismatched }).execute('resource_read', { type: 'file', id: 'f' }), /not found/);
  assert.equal((await runtime().execute('resource_read', { type: 'file', id: 'f' })).status, 'unreadable');
  await assert.rejects(runtime({ readAttachment: async () => { throw new Error('SECRET path'); } }).execute('resource_read', { type: 'file', id: 'f' }), /^Error: Attachment could not be read\.$/);
});

test('read and search outputs are bounded; no attachment reader called by search', async () => {
  const state = snapshot();
  state.workspaces[0].data.artifacts = Array.from({ length: 15 }, (_, i) => ({ id: `long-${i}`, title: 'match', kind: 'Document', content: 'match '.repeat(5000), versions: [] }));
  const r = runtime({ state, readAttachment: () => { throw new Error('must not run'); } });
  const found = await r.execute('workspace_search', { query: 'match', type: 'artifact' });
  assert.equal(found.results.length, 10); assert.equal(found.truncated, true);
  assert.ok(found.results.every(x => x.excerpt.length <= 500));
  const read = await r.execute('resource_read', { type: 'artifact', id: 'long-0' });
  assert.equal(read.content.length, 12000); assert.equal(read.truncated, true);
});

test('content, aggregate patch bytes and call limits fail atomically', async () => {
  await assert.rejects(runtime().execute('create_artifact', { title: 'x', kind: 'Document', content: 'x'.repeat(100001) }), /Invalid content/);
  const r = runtime();
  for (let i = 0; i < 2; i++) await r.execute('create_artifact', { title: 'x', kind: 'Document', content: 'x'.repeat(100000) });
  await assert.rejects(r.execute('create_artifact', { title: 'x', kind: 'Document', content: 'x'.repeat(100000) }), /patch limit/);
  assert.equal(r.patches().length, 2);
  await assert.rejects(r.execute('update_artifact', { id: r.patches()[0].artifact.id, content: 'y'.repeat(100000) }), /patch limit/);
  assert.equal(r.patches()[0].artifact.content, 'x'.repeat(100000));
  const calls = runtime();
  for (let i = 0; i < 10; i++) await calls.execute('workspace_search', { query: 'absent' });
  await assert.rejects(calls.execute('workspace_search', { query: 'absent' }), /call limit/);
  const unicode = runtime();
  await assert.rejects(unicode.execute('create_artifact', { title: 'x', kind: 'Document', content: '界'.repeat(100000) }), /patch limit/);
});

test('tables validate rectangular string-only bounded data and retain formula text as JSON', async () => {
  const r = runtime({ enabled: ['Tables'] });
  const result = await r.execute('create_table', { title: 'Budget', columns: ['Name', 'Value'], rows: [['item', '=1+1']] });
  assert.equal(result.kind, 'Table'); assert.equal(result.status, 'prepared');
  assert.deepEqual(JSON.parse(r.patches()[0].artifact.content), { columns: ['Name', 'Value'], rows: [['item', '=1+1']] });
  await r.execute('update_artifact', { id: result.id, content: JSON.stringify({ columns: ['A'], rows: [['b']] }) });
  assert.equal(r.patches()[0].artifact.versions.length, 1);
  const invalid = [ { columns: [], rows: [] }, { columns: ['A'], rows: [[1]] }, { columns: ['A'], rows: [[]] }, { columns: ['A'], rows: Array.from({ length: 501 }, () => ['x']) }, { columns: Array(31).fill('A'), rows: [] }, { columns: ['A'], rows: ['x'] }, { columns: 'A', rows: [] }, { columns: ['A'], rows: null }, { columns: [null], rows: [] }, { columns: Array(1), rows: [] }, { columns: ['A'], rows: [Array(1)] } ];
  for (const args of invalid) await assert.rejects(runtime().execute('create_table', { title: 'T', ...args }), /Invalid|table row/);
  await assert.rejects(r.execute('update_artifact', { id: result.id, content: '{' }), /table JSON/);
  await assert.rejects(r.execute('update_artifact', { id: result.id, content: JSON.stringify({ columns: ['A'], rows: [[false]] }) }), /table cell/);
});
