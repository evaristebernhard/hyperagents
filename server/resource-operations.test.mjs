import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from './tools.mjs';

const originalContent = '# Intro\nintro\n## Plan\nold\n### Child\nchild\n## End\nuntouched\n';
function snapshot() {
  const doc = { id: 'd', kind: 'Document', title: 'Doc', threadId: 't', content: originalContent, updatedAt: '2026-01-01', versions: [{ content: 'historic', context: 'SECRET' }] };
  return { workspaces: [{ id: 'w', data: {
    threads: [
      { id: 't', title: 'Needle title', summary: 'safe', messages: [{ id: 'm1', role: 'user', text: 'needle message', createdAt: '2026-01-01', context: { secret: 'SECRET' }, config: 'SECRET' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `m${i + 2}`, role: 'assistant', text: 'x'.repeat(6000) }))] },
      { id: 'other', title: 'needle', messages: [] },
      ...[{ archived: true }, { excluded: true }, { isSearchable: false }, { workspaceId: 'foreign' }].map((flags, i) => ({ id: `hidden${i}`, title: 'needle hidden', ...flags })),
    ],
    artifacts: [doc, { ...doc, id: 'other-doc', threadId: 'other' }, { ...doc, id: 'html', kind: 'Webpage' }, { ...doc, id: 'dup', content: '# Same\na\n# Same\nb' }, { ...doc, id: 'fenced', content: '```md\n# Plan\n```\nPlan\n====\nbody\n# Next\nkeep' }, { ...doc, id: 'archived', archived: true }],
  } }, { id: 'foreign', data: { threads: [{ id: 'foreign', title: 'needle SECRET' }], artifacts: [{ ...doc, id: 'foreign-doc' }] } }] };
}
const runtime = (options = {}) => createWorkspaceTools({ state: snapshot(), workspaceId: 'w', threadId: 't', enabled: ['Thread Search', 'Documents'], maxCalls: 100, ...options });

test('capability gates do not imply permissions for newly enabled tools', async () => {
  for (const [enabled, denied] of [[['Tables', 'Webpages'], ['search_threads', 'get_thread_messages', 'read_document', 'update_document_section']], [['Documents'], ['search_threads', 'get_thread_messages']], [['Thread Search'], ['read_document', 'update_document_section']]]) {
    const r = runtime({ enabled });
    for (const name of denied) {
      assert.ok(!r.definitions.some(d => d.function.name === name));
      await assert.rejects(r.execute(name, {}), /disabled/);
    }
  }
});

test('thread search is bounded, projects safe fields, and excludes hidden/foreign records', async () => {
  const r = runtime();
  const result = await r.execute('search_threads', { query: 'NEEDLE', limit: 1 });
  assert.equal(result.results.length, 1); assert.equal(result.truncated, true);
  assert.ok(result.results[0].excerpt.length <= 500);
  assert.deepEqual((await r.execute('search_threads', { query: 'needle' })).results.map(t => t.id), ['t', 'other']);
  assert.deepEqual((await r.execute('search_threads', { query: 'SECRET' })).results, []);
  for (const id of ['foreign', 'hidden0', 'hidden1', 'hidden2', 'hidden3']) await assert.rejects(r.execute('get_thread_messages', { thread_id: id }), /not found/);
});

test('message paging projects only four fields and enforces per-message/aggregate budgets', async () => {
  const r = runtime();
  const first = await r.execute('get_thread_messages', { thread_id: 't', limit: 1 });
  assert.deepEqual(Object.keys(first.messages[0]), ['id', 'role', 'text', 'createdAt']);
  assert.equal(first.next_offset, 1); assert.ok(!JSON.stringify(first).includes('SECRET'));
  const next = await r.execute('get_thread_messages', { thread_id: 't', offset: first.next_offset, limit: 50 });
  assert.equal(next.messages.length, 3); assert.equal(next.next_offset, 4);
  assert.ok(next.messages.every(m => m.text.length <= 4000));
  assert.equal(next.messages.reduce((n, m) => n + m.text.length, 0), 12000);
  assert.equal((await r.execute('get_thread_messages', { thread_id: 't', offset: 6 })).next_offset, null);
  await assert.rejects(r.execute('get_thread_messages', { thread_id: 't', offset: 7 }), /bounds/);
});

test('Document reads select explicit history only, truncate, and reject webpages and foreign artifacts', async () => {
  const state = snapshot(); state.workspaces[0].data.artifacts[0].content = 'a'.repeat(15000);
  const r = runtime({ state });
  assert.equal((await r.execute('read_document', { id: 'd', version_index: 0 })).content, 'historic');
  const result = await r.execute('read_document', { id: 'd' });
  assert.equal(result.content.length, 12000); assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal((await r.execute('read_document', { id: 'other-doc' })).kind, 'Document');
  for (const id of ['foreign-doc', 'archived']) await assert.rejects(r.execute('read_document', { id }), /not found/);
  await assert.rejects(r.execute('read_document', { id: 'html' }), /not a Document/);
  await assert.rejects(r.execute('read_document', { id: 'd', version_index: 1 }), /bounds/);
});

test('section edits preserve headings, history, source snapshot and original CAS through successive operations', async () => {
  const state = snapshot(), before = structuredClone(state), r = runtime({ state });
  await r.execute('update_document_section', { id: 'd', section_name: 'Plan', operation: 'replace', content: 'new' });
  await r.execute('update_document_section', { id: 'd', section_name: 'Plan', operation: 'prepend', content: 'first' });
  await r.execute('update_document_section', { id: 'd', section_name: 'Plan', operation: 'append', content: 'last' });
  const [patch] = r.patches();
  assert.equal(patch.artifact.content, '# Intro\nintro\n## Plan\nfirst\nnew\nlast\n## End\nuntouched\n');
  assert.equal(patch.artifact.versions.length, 4);
  assert.deepEqual(patch.base, { title: 'Doc', content: originalContent, updatedAt: '2026-01-01' });
  assert.deepEqual(state, before);
  await r.execute('update_document_section', { id: 'fenced', section_name: 'Plan', operation: 'replace', content: 'changed' });
  assert.equal(r.patches()[1].artifact.content, '```md\n# Plan\n```\nPlan\n====\nchanged\n# Next\nkeep');
});

test('strict schemas, missing/ambiguous headings, byte and aggregate patch limits fail atomically', async () => {
  const r = runtime();
  const edit = { id: 'd', section_name: 'Plan', operation: 'replace', content: 'ok' };
  await r.execute('update_document_section', edit);
  const before = r.patches();
  const invalid = [
    ['search_threads', { query: 'x', limit: 21 }], ['search_threads', { query: ' ' }],
    ['get_thread_messages', { thread_id: 't', offset: -1 }], ['get_thread_messages', { thread_id: 't', limit: 1.1 }],
    ['read_document', { id: 'd', version_index: -1 }], ['read_document', { id: 'd', extra: true }],
    ['read_document', JSON.parse('{"id":"d","__proto__":{}}')], ['read_document', { id: 'd', constructor: 'x' }],
    ['read_document', Object.assign(Object.create({ inherited: true }), { id: 'd' })],
    ...[{ section_name: 'missing' }, { id: 'dup', section_name: 'Same' }, { id: 'other-doc' }, { operation: 'delete' }, { content: '界'.repeat(40000) }].map(change => ['update_document_section', { ...edit, ...change }]),
  ];
  for (const [name, args] of invalid) await assert.rejects(r.execute(name, args));
  assert.deepEqual(r.patches(), before);
  await r.execute('update_document_section', { ...edit, content: 'x'.repeat(90000) });
  await r.execute('update_document_section', { ...edit, content: 'y'.repeat(90000) });
  const large = r.patches();
  await assert.rejects(r.execute('update_document_section', { ...edit, content: 'z'.repeat(90000) }), /patch limit/);
  assert.deepEqual(r.patches(), large);
});
