import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPlugins } from './agent-plugins.mjs';

function snapshot() {
  return { workspaces: [
    { id: 'w', data: { threads: [{ id: 'thread', title: 'A thread', messages: [{ role: 'user', text: 'needle conversation' }] }], agents: [{ id: 'researcher', name: 'Researcher', tools: ['Documents', 'Search'] }], projects: [], skills: [], memories: [], artifacts: [{ id: 'doc', kind: 'Document', title: 'needle document', content: 'Verified local text', versions: [] }] } },
    { id: 'foreign', data: { threads: [], agents: [], artifacts: [{ id: 'foreign-doc', kind: 'Document', title: 'foreign secret', content: 'FOREIGN SECRET' }] } },
  ] };
}
const definition = name => ({ type: 'function', function: { name, description: 'A test tool.', parameters: { type: 'object', properties: { value: { type: 'string', maxLength: 100 } }, required: ['value'], additionalProperties: false } } });
const custom = (options = {}) => ({ id: 'sample', name: 'Sample', description: 'A server-authored plugin.', available: true, defaultEnabled: false, tools: [{ definition: definition('sample_tool'), effect: 'write' }], bind: () => ({ execute: (_name, args) => ({ value: args.value }) }), ...options });
const options = (state = snapshot()) => ({ load: () => ({ state }), publicFetch: null, exaFetch: null });
const worker = (host, more = {}) => host.bind({ workspaceId: 'w', taskId: 'task-one', role: 'worker', ...more });

test('manifest reports actual configuration, selection is explicit, router binds no plugin tools', async () => {
  let bound = 0;
  const host = createAgentPlugins({ ...options(), plugins: [custom({ bind() { bound++; return { execute() {} }; } })] });
  const manifest = host.list();
  assert.equal(manifest.find(plugin => plugin.id === 'web-search').available, false);
  assert.equal(manifest.find(plugin => plugin.id === 'documents').available, false);
  assert.deepEqual(worker(host, { pluginIds: [] }).definitions(), []);
  const router = host.bind({ workspaceId: 'w', taskId: 'task-one', role: 'router', pluginIds: ['sample'] });
  assert.deepEqual(router.definitions(), []);
  assert.equal(bound, 0);
  await assert.rejects(router.execute('sample_tool', { value: 'x' }), /not enabled/);
  assert.throws(() => worker(host, { pluginIds: ['unknown'] }), /unavailable/);
  assert.throws(() => worker(host, { pluginIds: ['documents'] }), /unavailable/);
});

test('workspace reads reuse legacy readers without persisting a hidden thread or crossing workspaces', async () => {
  const state = snapshot(), original = structuredClone(state);
  const bound = worker(createAgentPlugins(options(state)), { pluginIds: ['workspace-read'] });
  const names = bound.definitions().map(item => item.function.name);
  assert.ok(names.includes('workspace_search') && names.includes('resource_read'));
  assert.ok(!names.includes('create_artifact') && !names.includes('update_artifact') && !names.includes('export_table'));
  assert.equal((await bound.execute('resource_read', { type: 'artifact', id: 'doc' })).content, 'Verified local text');
  assert.deepEqual((await bound.execute('workspace_search', { query: 'FOREIGN' })).results, []);
  await assert.rejects(bound.execute('resource_read', { type: 'artifact', id: 'foreign-doc' }), /not found/);
  assert.deepEqual(state, original);
  assert.throws(() => createAgentPlugins(options(state)).bind({ workspaceId: 'missing', taskId: 't', role: 'router' }), /not found/);
});

test('empty workspace can be read without creating any stored thread', async () => {
  const state = snapshot(); state.workspaces[0].data.threads = [];
  const bound = worker(createAgentPlugins(options(state)), { pluginIds: ['workspace-read'] });
  assert.equal((await bound.execute('read_document', { id: 'doc' })).content, 'Verified local text');
  assert.deepEqual((await bound.execute('search_threads', { query: 'agent-read' })).results, []);
  assert.deepEqual(state.workspaces[0].data.threads, []);
});

test('saved agent capabilities intersect selected plugins and are rechecked during execution', async () => {
  const state = snapshot(), host = createAgentPlugins(options(state));
  const bound = worker(host, { pluginIds: ['workspace-read'], agentId: 'researcher' });
  assert.deepEqual(bound.definitions().map(item => item.function.name), ['search_documents', 'read_document']);
  await assert.rejects(bound.execute('resource_read', { type: 'thread', id: 'thread' }), /not enabled/);
  state.workspaces[0].data.agents[0].tools = [];
  await assert.rejects(bound.execute('read_document', { id: 'doc' }), /no longer authorized/);
  assert.throws(() => worker(host, { agentId: 'foreign-agent' }), /not found/);
});

test('custom plugins are registered only as server objects; names and schemas cannot shadow core tools', async () => {
  assert.throws(() => createAgentPlugins({ ...options(), plugins: ['./untrusted.mjs'] }), /registration/);
  assert.throws(() => createAgentPlugins({ ...options(), plugins: [custom(), custom()] }), /Duplicate plugin/);
  assert.throws(() => createAgentPlugins({ ...options(), plugins: [custom({ tools: [{ definition: definition('delegate_task'), effect: 'read-only' }] })] }), /reserved/);
  assert.throws(() => createAgentPlugins({ ...options(), plugins: [custom({ tools: [{ definition: definition('read_document'), effect: 'read-only' }] })] }), /Duplicate/);
  let executed = 0;
  const bound = worker(createAgentPlugins({ ...options(), plugins: [custom({ bind: () => ({ execute() { executed++; } }) })] }), { pluginIds: ['sample'] });
  assert.deepEqual(bound.metadata('sample_tool'), { pluginId: 'sample', effect: 'write', replay: 'manual', approvalRequired: true });
  await assert.rejects(bound.execute('sample_tool', { value: 'x', endpoint: 'elsewhere' }), /Unexpected/);
  await assert.rejects(bound.execute('sample_tool', Object.defineProperty({}, 'value', { enumerable: true, get() { throw Error('getter ran'); } })), /Invalid tool argument property/);
  assert.equal(executed, 0);
});

test('documents are task-scoped, require stable effect IDs, and use the injected durable artifact store', async () => {
  const state = snapshot(), calls = [], saved = new Map();
  const host = createAgentPlugins({ ...options(state), persistArtifact: async input => {
    calls.push(input);
    if (!saved.has(input.effectId)) saved.set(input.effectId, { id: 'artifact-one', workspaceId: input.workspaceId });
    return saved.get(input.effectId);
  } });
  const bound = worker(host, { pluginIds: ['documents'], agentId: 'researcher' });
  assert.deepEqual(bound.metadata('task_save_document'), { pluginId: 'documents', effect: 'write', replay: 'safe', approvalRequired: false });
  const args = { title: '  Research ', content: '# Result\n\nFull deliverable.' };
  await assert.rejects(bound.execute('task_save_document', args), /effect ID/);
  const first = await bound.execute('task_save_document', args, { effectId: 'effect-one' });
  const again = await bound.execute('task_save_document', args, { effectId: 'effect-one' });
  assert.equal(first.id, again.id);
  assert.equal(saved.size, 1);
  assert.equal(calls[0].taskId, 'task-one');
  assert.equal(calls[0].workspaceId, 'w');
  assert.equal(calls[0].title, 'Research');
  assert.equal(calls[0].kind, 'Document');
  assert.equal(calls[0].threadId, undefined);
  assert.equal(state.workspaces[0].data.threads.length, 1);
  await bound.execute('task_save_document', args, { effectId: 'task-'.padEnd(50, 'a') + ':4:' + 'b'.repeat(200) });
  assert.equal(calls.at(-1).effectId.length, 253);
});

test('search delegates to configured Exa, falls back to keyless RSS only without Exa, and honors disable', async () => {
  const exaCalls = [];
  const exaHost = createAgentPlugins({ ...options(), exaApiKey: 'test-exa', exaFetch: async (url, init) => { exaCalls.push({ url, init }); return new Response(JSON.stringify({ results: [{ url: 'https://example.com/paper', title: 'Paper', highlights: ['Source fact'] }] }), { headers: { 'content-type': 'application/json' } }); } });
  const exaBound = worker(exaHost, { pluginIds: ['web-search'], agentId: 'researcher' });
  assert.deepEqual(exaBound.definitions().map(item => item.function.name), ['exa_search', 'exa_contents']);
  assert.equal((await exaBound.execute('exa_search', { query: 'agents' })).results[0].title, 'Paper');
  assert.equal(exaCalls[0].url, 'https://api.exa.ai/search');
  const rss = '<rss><channel><item><title>Fact</title><link>https://example.com/fact</link><description>Public fact</description></item></channel></rss>';
  const freeHost = createAgentPlugins({ ...options(), publicFetch: async () => new Response(rss) });
  const freeBound = worker(freeHost, { pluginIds: ['web-search'] });
  assert.deepEqual(freeBound.definitions().map(item => item.function.name), ['web_search']);
  assert.equal((await freeBound.execute('web_search', { query: 'agents' })).results[0].title, 'Fact');
  assert.equal(createAgentPlugins({ ...options(), publicFetch: async () => new Response(rss), freeSearchDisabled: true }).list().find(item => item.id === 'web-search').available, false);
});

test('bindings isolate concurrent execution context and close exactly once', async () => {
  const received = []; let closed = 0;
  const host = createAgentPlugins({ ...options(), plugins: [custom({ tools: [{ definition: definition('sample_tool'), effect: 'read-only' }], bind: context => ({ async execute(_name, args, execution) { await new Promise(resolve => setImmediate(resolve)); received.push({ taskId: context.taskId, ...args, effectId: execution.effectId }); return args; }, close() { closed++; } }) })] });
  const one = worker(host, { pluginIds: ['sample'] }), two = worker(host, { taskId: 'task-two', pluginIds: ['sample'] });
  await Promise.all([one.execute('sample_tool', { value: 'one' }, { effectId: 'e-one' }), two.execute('sample_tool', { value: 'two' }, { effectId: 'e-two' })]);
  assert.deepEqual(received.map(item => [item.taskId, item.effectId]), [['task-one', 'e-one'], ['task-two', 'e-two']]);
  await one.close(); await one.close(); assert.equal(closed, 1);
  await assert.rejects(one.execute('sample_tool', { value: 'one' }), /closed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(two.execute('sample_tool', { value: 'two' }, { signal: controller.signal }), /abort/i);
  await two.close(); assert.equal(closed, 2);
});

test('failed multi-plugin bind closes earlier resources despite synchronous and asynchronous cleanup failures', async () => {
  const closed = [];
  const plugin = (name, bind) => custom({ id: name, tools: [{ definition: definition(name + '_tool'), effect: 'read-only' }], bind });
  const host = createAgentPlugins({ ...options(), plugins: [
    plugin('first', () => ({ execute() {}, close() { closed.push('first'); throw Error('first cleanup'); } })),
    plugin('second', () => ({ execute() {}, close() { closed.push('second'); return Promise.reject(Error('second cleanup')); } })),
    plugin('third', () => { throw Error('binding failed'); }),
  ] });
  assert.throws(() => worker(host, { pluginIds: ['first', 'second', 'third'] }), /binding failed/);
  assert.deepEqual(closed, ['first', 'second']);
  await new Promise(resolve => setImmediate(resolve)); // Rejected cleanup promises must be observed.
});

test('normal close attempts every runtime even when an earlier close throws synchronously', async () => {
  const closed = [];
  const plugins = ['first', 'second', 'third'].map(name => custom({ id: name, tools: [{ definition: definition(name + '_tool'), effect: 'read-only' }], bind: () => ({ execute() {}, close() {
    closed.push(name);
    if (name === 'first') throw Error('first cleanup');
    if (name === 'second') return Promise.reject(Error('second cleanup'));
  } }) }));
  const bound = worker(createAgentPlugins({ ...options(), plugins }), { pluginIds: ['first', 'second', 'third'] });
  await assert.rejects(bound.close(), /first cleanup/);
  assert.deepEqual(closed, ['first', 'second', 'third']);
  await bound.close();
  assert.equal(closed.length, 3);
});
