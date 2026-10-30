import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from './tools.mjs';

const initial = { columns: ['名称', 'Value'], rows: [['一', ''], ['two', '2'], ['three', '3']] };
function snapshot() {
  const artifact = (id, threadId) => ({ id, threadId, title: 'Table', kind: 'Table', content: JSON.stringify(initial), createdAt: '2026-01-01', updatedAt: '2026-01-02', versions: [] });
  return { workspaces: [{ id: 'w', data: { threads: [{ id: 't' }, { id: 'other' }], artifacts: [artifact('a', 't'), artifact('other-table', 'other'), { ...artifact('doc', 't'), kind: 'Document' }] } }, { id: 'foreign', data: { artifacts: [artifact('secret', 't')] } }] };
}
const runtime = (options = {}) => createWorkspaceTools({ state: snapshot(), workspaceId: 'w', threadId: 't', enabled: ['Tables'], maxCalls: 50, ...options });

test('table operations stage an isolated overlay with original CAS base and versions', async () => {
  const state = snapshot(), original = structuredClone(state), r = runtime({ state });
  await r.execute('add_table_rows', { id: 'a', rows: [['四', '4']] });
  await r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: 'changed' });
  await r.execute('delete_table_rows', { id: 'a', rowIndices: [2, 1] });
  const result = await r.execute('get_table', { id: 'a' });
  assert.deepEqual(result.rows, [['一', 'changed'], ['四', '4']]);
  assert.ok(!Object.hasOwn(result, 'rowIds'));
  result.rows[0][0] = 'tamper';
  assert.equal((await r.execute('get_table', { id: 'a' })).rows[0][0], '一');
  const [patch] = r.patches();
  assert.deepEqual(patch.base, { title: 'Table', content: JSON.stringify(initial), updatedAt: '2026-01-02' });
  assert.equal(patch.artifact.versions.length, 3);
  assert.ok(Date.parse(patch.artifact.updatedAt) > Date.parse(patch.base.updatedAt));
  assert.deepEqual(state, original);
  const created = await r.execute('create_table', { title: 'New', columns: ['X'], rows: [] });
  await r.execute('add_table_rows', { id: created.id, rows: [['']] });
  assert.equal(r.patches()[1].base, undefined);
});

test('Tables gate and exact workspace/thread boundaries apply to all operations', async () => {
  const disabled = runtime({ enabled: ['Documents'], persistFile: async () => ({ id: 'file' }) });
  for (const name of ['get_table', 'add_table_rows', 'update_table_cell', 'delete_table_rows', 'export_table']) {
    assert.ok(!disabled.definitions.some(d => d.function.name === name));
    await assert.rejects(disabled.execute(name, { id: 'a' }), /disabled/);
  }
  const r = runtime();
  assert.deepEqual((await r.execute('get_table', { id: 'other-table' })).rows, initial.rows);
  for (const [name, args] of [ ['add_table_rows', { rows: [['x', 'y']] }], ['update_table_cell', { rowIndex: 0, columnIndex: 0, value: 'x' }], ['delete_table_rows', { rowIndices: [0] }] ]) {
    await assert.rejects(r.execute(name, { id: 'other-table', ...args }), /current thread/);
  }
  await assert.rejects(r.execute('get_table', { id: 'secret' }), /not found/);
  await assert.rejects(r.execute('get_table', { id: 'doc' }), /not a table/);
  assert.deepEqual(r.patches(), []);
});

test('indices, duplicate deletes, shape and schemas reject atomically', async () => {
  const r = runtime();
  const invalid = [
    ['delete_table_rows', { rowIndices: [0, 0] }], ['delete_table_rows', { rowIndices: [0, 3] }],
    ['delete_table_rows', { rowIndices: [] }], ['delete_table_rows', { rowIndices: [-1] }],
    ['update_table_cell', { rowIndex: 0.5, columnIndex: 0, value: 'x' }],
    ['update_table_cell', { rowIndex: 3, columnIndex: 0, value: 'x' }],
    ['update_table_cell', { rowIndex: 0, columnIndex: 2, value: 'x' }],
    ['update_table_cell', { rowIndex: '0', columnIndex: 0, value: 'x' }],
    ['update_table_cell', { rowIndex: 0, columnIndex: 0, value: false }],
    ['add_table_rows', { rows: [['x']] }], ['add_table_rows', { rows: [[1, 'x']] }],
    ['add_table_rows', { rows: [] }], ['add_table_rows', { rows: Array(1) }],
    ['get_table', { rowId: 'fake' }],
  ];
  for (const [name, args] of invalid) await assert.rejects(r.execute(name, { id: 'a', ...args }), /Invalid|bounds|column count/);
  assert.deepEqual(r.patches(), []);
  assert.deepEqual((await r.execute('get_table', { id: 'a' })).rows, initial.rows);
});

test('row, content, and aggregate patch-byte budgets preserve the last successful state', async () => {
  const r = runtime();
  await r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: 'ok' });
  const before = r.patches();
  await assert.rejects(r.execute('add_table_rows', { id: 'a', rows: Array.from({ length: 498 }, () => ['', '']) }), /dimensions/);
  await assert.rejects(r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: 'x'.repeat(100000) }), /content/);
  await assert.rejects(r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: '界'.repeat(90000) }), /byte limit/);
  assert.deepEqual(r.patches(), before);
  await r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: 'x'.repeat(90000) });
  const staged = r.patches();
  await assert.rejects(r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: '界'.repeat(60000) }), /patch limit/);
  assert.deepEqual(r.patches(), staged);
});

test('exports save exact UTF-8 CSV/JSON and only return real file references after save', async () => {
  const saved = [];
  const r = runtime({ persistFile: async input => { saved.push(input); return { id: `file-${saved.length}`, workspaceId: 'w' }; } });
  await r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: 'a,"b"\r\nc' });
  const csv = await r.execute('export_table', { id: 'a', format: 'csv' });
  assert.equal(saved[0].content, '名称,Value\r\n一,"a,""b""\r\nc"\r\ntwo,2\r\nthree,3\r\n');
  assert.equal(saved[0].workspaceId, 'w'); assert.equal(saved[0].threadId, 't');
  assert.equal(csv.file.id, 'file-1');
  assert.equal(csv.file.size, Buffer.byteLength(saved[0].content, 'utf8'));
  assert.ok(!JSON.stringify(csv).includes('url'));
  const json = await r.execute('export_table', { id: 'a', format: 'json' });
  assert.equal(json.file.id, 'file-2');
  assert.deepEqual(JSON.parse(saved[1].content).rows, (await r.execute('get_table', { id: 'a' })).rows);
  assert.equal(r.patches().length, 1);
  await r.execute('update_table_cell', { id: 'a', rowIndex: 0, columnIndex: 1, value: '=1+1' });
  const safe = await r.execute('export_table', { id: 'a', format: 'csv' });
  assert.equal(safe.formulaPolicy, 'apostrophe-prefix');
  assert.ok(saved[2].content.includes("'=1+1"));
  await r.execute('export_table', { id: 'a', format: 'json' });
  assert.equal(JSON.parse(saved[3].content).rows[0][1], '=1+1');
});

test('exports are unavailable without storage and failed or invalid saves never return references', async () => {
  const r = runtime();
  assert.ok(!r.definitions.some(d => d.function.name === 'export_table'));
  await assert.rejects(r.execute('export_table', { id: 'a', format: 'csv' }), /unavailable/);
  for (const persistFile of [async () => { throw new Error('secret'); }, async () => null, async () => ({ url: '/fake' }), async () => ({ id: 'f', workspaceId: 'foreign' })]) {
    const attempt = runtime({ persistFile });
    await assert.rejects(attempt.execute('export_table', { id: 'a', format: 'json' }), /could not be saved|valid file reference/);
    assert.deepEqual(attempt.patches(), []);
  }
});
