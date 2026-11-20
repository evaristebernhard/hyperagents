import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from './tools.mjs';
import { createAgentPlugins } from './agent-plugins.mjs';

const enabled = ['Thread Search', 'Documents', 'Tables'];
const timestamp = '2026-11-11T12:00:00.000Z';
function snapshot() {
  const companion = (id, status, visibility, agentId = 'me') => ({
    id, content: `needle ${id}`, category: '喜好', pinned: true, importance: 3,
    companion: { agentId, status, visibility, createdAt: timestamp, updatedAt: timestamp },
  });
  const attachment = { id: 'private-file', name: 'needle-private.txt', workspaceId: 'w', mimeType: 'text/plain' };
  const self = id => ({
    id, title: `needle ${id}`, summary: 'needle self summary', companionAgentId: 'me',
    config: { agentId: 'me' },
    messages: [{ id: `${id}-message`, role: 'user', text: 'needle private self words', context: { settings: { agentId: 'me' }, attachments: [attachment] } }],
  });
  const document = { id: 'private-document', title: 'needle private document', kind: 'Document', content: 'needle PRIVATE ARTIFACT', threadId: 'self', versions: [] };
  const table = { id: 'private-table', title: 'needle private table', kind: 'Table', content: JSON.stringify({ columns: ['Name'], rows: [['needle PRIVATE TABLE']] }), threadId: 'self', versions: [] };
  const data = {
    agents: [{ id: 'me', name: 'My companion', companion: true, tools: enabled }, { id: 'other-agent', companion: true, tools: enabled }],
    threads: [
      self('self'), self('other-self'),
      { id: 'ordinary', title: 'needle ordinary', config: { agentId: 'me' }, messages: [{ role: 'user', text: 'needle ordinary words' }] },
      { id: 'delegated', title: 'Task', config: { agentId: 'me' }, messages: [{ role: 'user', text: 'Task', context: { settings: { agentId: 'me' } } }] },
    ],
    memories: [
      { id: 'legacy', content: 'needle legacy memory', pinned: true },
      companion('private', 'active', 'private'), companion('shared', 'active', 'shared'),
      companion('pending', 'pending', 'private'), companion('rejected', 'rejected', 'shared'),
      companion('foreign-agent', 'active', 'shared', 'other-agent'),
    ],
    artifacts: [document, table, { ...document, id: 'ordinary-document', threadId: 'ordinary', content: 'needle ordinary artifact' }],
    projects: [], skills: [],
  };
  return { workspaces: [{ id: 'w', data }, { id: 'foreign', data: { threads: [{ id: 'foreign-thread', title: 'FOREIGN SECRET' }], memories: [companion('foreign-memory', 'active', 'shared')], artifacts: [] } }] };
}
const runtime = (state = snapshot(), threadId = 'self', options = {}) => createWorkspaceTools({ state, workspaceId: 'w', threadId, enabled, maxCalls: 100, ...options });
const memoryIds = async r => (await r.execute('workspace_search', { query: 'needle', type: 'memory' })).results.map(row => row.id).sort();

test('memory readers require confirmation, selected companion and private self context', async () => {
  const own = runtime();
  assert.deepEqual(await memoryIds(own), ['legacy', 'private', 'shared']);
  assert.match((await own.execute('resource_read', { type: 'memory', id: 'private' })).content, /needle private/);
  assert.match((await own.execute('resource_read_page', { type: 'memory', id: 'shared' })).content, /needle shared/);
  for (const id of ['pending', 'rejected', 'foreign-agent', 'foreign-memory']) {
    for (const name of ['resource_read', 'resource_read_page']) await assert.rejects(own.execute(name, { type: 'memory', id }), /not found/);
  }
  const normal = runtime(snapshot(), 'ordinary');
  assert.deepEqual(await memoryIds(normal), ['legacy', 'shared']);
  await assert.rejects(normal.execute('resource_read', { type: 'memory', id: 'private' }), /not found/);
  // A delegated thread can use only matching shared memories, never inherit the parent's self identity.
  assert.deepEqual(await memoryIds(runtime(snapshot(), 'delegated')), ['legacy', 'shared']);
});

test('saved message selection, room context and memory settings cannot bypass privacy', async () => {
  for (const mutate of [
    (data, thread) => { thread.messages[0].context.settings.agentId = 'other-agent'; },
    (data, thread) => { thread.roomId = 'room'; },
    (data, thread) => { thread.config.agentId = 'other-agent'; },
    data => { data.agents[0].archived = true; },
    data => { data.agents[0].memoryReadScope = 'off'; },
  ]) {
    const state = snapshot(), data = state.workspaces[0].data, thread = data.threads[0];
    mutate(data, thread);
    thread.messages[0].context.memoryIds = ['private', 'pending', 'rejected'];
    const r = runtime(state);
    for (const id of ['private', 'pending', 'rejected']) await assert.rejects(r.execute('resource_read', { type: 'memory', id }), /not found/);
    assert.ok(!(await memoryIds(r)).includes('private'));
  }
  const state = snapshot(), data = state.workspaces[0].data;
  data.agents[0].memoryReadScope = 'linked';
  assert.deepEqual(await memoryIds(runtime(state)), ['legacy']);
  data.threads[0].messages[0].context.memoryIds = ['private', 'pending'];
  assert.deepEqual(await memoryIds(runtime(state)), ['legacy', 'private']);
});

test('self threads and their documents, tables and attachments stay in the same self thread', async () => {
  let reads = 0;
  const state = snapshot();
  const own = runtime(state, 'self', { readAttachment: async () => { reads++; return 'PRIVATE FILE BYTES'; } });
  assert.equal((await own.execute('get_thread_messages', { thread_id: 'self' })).messages[0].text, 'needle private self words');
  assert.match((await own.execute('read_document', { id: 'private-document' })).content, /PRIVATE ARTIFACT/);
  assert.equal((await own.execute('get_table', { id: 'private-table' })).rows[0][0], 'needle PRIVATE TABLE');
  assert.equal((await own.execute('resource_read', { type: 'file', id: 'private-file' })).content, 'PRIVATE FILE BYTES');
  await assert.rejects(own.execute('get_thread_messages', { thread_id: 'other-self' }), /not found/);
  // Remove duplicate file references so the file is owned by the first self thread only.
  state.workspaces[0].data.threads[1].messages[0].context.attachments = [];
  for (const threadId of ['ordinary', 'delegated', 'other-self']) {
    const r = runtime(state, threadId, { readAttachment: async () => { reads++; return 'MUST NOT READ'; } });
    assert.deepEqual((await r.execute('search_threads', { query: 'private self words' })).results, threadId === 'other-self' ? [{ id: 'other-self', title: 'needle other-self', summary: 'needle self summary', excerpt: 'needle other-self\n\nneedle self summary\n\nneedle private self words' }] : []);
    assert.deepEqual((await r.execute('search_documents', { query: 'PRIVATE ARTIFACT' })).results, []);
    assert.deepEqual((await r.execute('search_tables', { query: 'PRIVATE TABLE' })).results, []);
    for (const [type, id] of [['thread', 'self'], ['artifact', 'private-document'], ['artifact', 'private-table'], ['file', 'private-file']]) {
      for (const name of ['resource_read', 'resource_read_page']) await assert.rejects(r.execute(name, { type, id }), /not found/);
      assert.deepEqual((await r.execute('workspace_search', { query: id === 'self' ? 'private self words' : 'PRIVATE', type })).results.filter(row => row.id === id), []);
    }
    await assert.rejects(r.execute('read_document', { id: 'private-document' }), /not found/);
    await assert.rejects(r.execute('get_table', { id: 'private-table' }), /not found/);
    assert.match((await r.execute('read_document', { id: 'ordinary-document' })).content, /ordinary artifact/);
  }
  assert.equal(reads, 1, 'denied files never reach the byte reader');
});

test('task plugin adapters cannot use synthetic threads to read companion resources', async () => {
  const state = snapshot(), original = structuredClone(state);
  const host = createAgentPlugins({ load: () => ({ state }), publicFetch: null, exaFetch: null });
  // Unrestricted owner tasks have broad readers, but no private self identity.
  const owner = host.bind({ workspaceId: 'w', taskId: 'task', role: 'worker', pluginIds: ['workspace-read'] });
  assert.deepEqual(await memoryIds(owner), ['legacy']);
  await assert.rejects(owner.execute('resource_read', { type: 'memory', id: 'private' }), /not found/);
  await assert.rejects(owner.execute('get_thread_messages', { thread_id: 'self' }), /not found/);
  await assert.rejects(owner.execute('read_document', { id: 'private-document' }), /not found/);
  const worker = host.bind({ workspaceId: 'w', taskId: 'child', role: 'worker', pluginIds: ['workspace-read'], agentId: 'me' });
  await assert.rejects(worker.execute('read_document', { id: 'private-document' }), /not found/);
  assert.deepEqual((await worker.execute('search_threads', { query: 'private self words' })).results, []);
  await owner.close(); await worker.close();
  assert.deepEqual(state, original, 'authorization adapters never persist a self-context marker');
});
