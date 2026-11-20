import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.mjs';
import { emptyState, validateState } from './validation.mjs';
import { createRunManager } from './agent-runs.mjs';

// Real owner auth, HTTP, SQLite, run lifecycle and temporary local shell effects.
// Only provider responses are synthetic; no owner data or environment is read.
const scope = { workspaceId: 'personal', threadId: 'work' };
const request = { ...scope, userMessageId: 'question' };
const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const reply = (text = 'Finished remaining work.') => new Response(frame({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
const partial = () => new Response(frame({ choices: [{ delta: { content: 'Saved partial observation.' } }] }), { headers: { 'Content-Type': 'text/event-stream' } });
const toolReply = () => new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'effect', type: 'function', function: { name: 'shell_execute', arguments: JSON.stringify({ command: 'printf x >> effect.txt' }) } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
const query = run => `/api/runs/${run.id}?${new URLSearchParams(scope)}`;
async function json(response, status = 200) { const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text); }
async function poll(get, accept) { const deadline = Date.now() + 5000; let value; do { value = await get(); if (accept(value)) return value; await delay(10); } while (Date.now() < deadline); assert.fail('State did not settle: ' + JSON.stringify(value)); }
function fixture(tools = []) {
  const state = emptyState();
  state.workspaces[0].data.threads.push({ id: 'work', title: 'Saved task', summary: '', time: '', config: { model: 'deepseek-flash', provider: 'DeepSeek', reasoning: 'Low', mode: 'Execute', tools }, messages: [{ id: 'question', role: 'user', text: 'Inspect the saved work and finish the remaining task.' }] });
  state.workspaces.push({ ...structuredClone(emptyState().workspaces[0]), id: 'other', name: 'Other' });
  return state;
}
async function harness(t, provider = () => reply()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'run-continuation-'));
  const requests = []; let app, base, cookie, csrf, upstream = provider;
  const start = async () => { app = await createApp({ dataDir: dir, shellRoot: dir, port: 0, deepseekApiKey: 'synthetic-continuation-test-key', llmFetch: async (url, init) => { const body = JSON.parse(init.body); requests.push(body); return upstream(url, init); } }); base = `http://127.0.0.1:${(await app.listen()).port}`; };
  await start(); t.after(async () => { try { if (app) await app.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const call = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(6000), headers: { Origin: base, Cookie: cookie || '', 'X-CSRF-Token': csrf || '', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const state = () => call('/api/state').then(response => json(response));
  return { dir, requests, call, state,
    async setup(tools = []) { const response = await call('/api/setup', { method: 'POST', body: { password: 'synthetic-continuation-owner-password' } }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await json(response)).csrfToken; const current = await state(); await json(await call('/api/state', { method: 'PUT', body: { state: fixture(tools) }, headers: { 'If-Match': String(current.revision) } })); },
    async mutate(edit) { const current = await state(); edit(current.state); return json(await call('/api/state', { method: 'PUT', body: { state: current.state }, headers: { 'If-Match': String(current.revision) } })); },
    async create() { return (await json(await call('/api/runs', { method: 'POST', body: request }), 202)).run; },
    async get(run) { return (await json(await call(query(run)))).run; },
    async wait(run, status) { return poll(() => this.get(run), value => value.status === status); },
    async next(run, requestId = 'continue-once') { return (await json(await call(`/api/runs/${run.id}/continue`, { method: 'POST', body: { ...scope, requestId } }), 202)).run; },
    async restart(next = provider) { upstream = next; await app.close(); app = undefined; await start(); },
  };
}

test('explicit saved-context continuation is idempotent, linked and durable across a real service restart', { timeout: 15000 }, async t => {
  const h = await harness(t, () => partial()); await h.setup();
  const original = await h.create(); await h.wait(original, 'failed');
  const old = await h.get(original), previousMessages = (await h.state()).state.workspaces[0].data.threads[0].messages;
  await h.restart(() => reply());
  const [one, two] = await Promise.all([h.next(original), h.next(original)]);
  assert.equal(one.id, two.id); assert.notEqual(one.id, original.id); assert.equal(one.continuedFromRunId, original.id);
  const finished = await h.wait(one, 'succeeded'); assert.equal(finished.resultSaved, true);
  const saved = await h.state(), messages = saved.state.workspaces[0].data.threads[0].messages;
  const continuation = messages.find(message => message.runContinuation);
  assert.equal(messages.filter(message => message.runContinuation).length, 1);
  assert.equal(continuation.runContinuation.sourceRunId, original.id);
  assert.ok(continuation.text.includes('Saved partial observation.'));
  assert.ok(continuation.text.includes('原审批不延续'));
  assert.equal(h.requests.length, 2, 'only original and explicit new run call the provider');
  assert.equal(h.requests.at(-1).messages.at(-1).content, continuation.text);
  assert.deepEqual(messages.slice(0, previousMessages.length), previousMessages);
  assert.deepEqual(await h.get(original), old, 'continuing never modifies the original run');
  await h.restart(() => { assert.fail('reopening and reading a saved continuation must not call the provider'); });
  assert.equal((await h.next(original)).id, one.id);
  assert.equal((await h.get(one)).continuedFromRunId, original.id);
  assert.equal((await h.state()).state.workspaces[0].data.threads[0].messages.filter(message => message.runContinuation).length, 1);
  const events = await json(await h.call(`/api/runs/${original.id}/events?${new URLSearchParams(scope)}`));
  assert.ok(events.events.some(entry => entry.event.type === 'delta' && entry.event.text === 'Saved partial observation.'));
  assert.equal((await h.call(`/api/runs/${original.id}/continue`, { method: 'POST', body: { ...scope, requestId: 'different' } })).status, 409);
});

test('a stopped server preserves completed shell effects, and continuing does not reuse approvals or replay the effect', { timeout: 15000 }, async t => {
  let calls = 0;
  const h = await harness(t, (_url, init) => {
    if (++calls === 1) return toolReply();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: 'Effect completed; remaining work is pending.' } }] }))); init.signal.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await h.setup(['Shell']); const original = await h.create();
  const waiting = await h.wait(original, 'waiting_approval');
  await json(await h.call(`/api/runs/${original.id}/approvals/${waiting.approvals[0].id}`, { method: 'POST', body: { ...scope, decision: 'approve' } }));
  await poll(() => h.get(original), value => value.approvals[0]?.status === 'completed' && calls === 2);
  assert.equal(await readFile(path.join(h.dir, 'effect.txt'), 'utf8'), 'x');
  await h.restart(() => reply());
  assert.equal((await h.get(original)).status, 'interrupted');
  const resumed = await h.next(original); await h.wait(resumed, 'succeeded');
  assert.equal(await readFile(path.join(h.dir, 'effect.txt'), 'utf8'), 'x');
  assert.equal((await h.get(resumed)).approvals.length, 0);
  assert.equal((await h.get(original)).approvals[0].status, 'completed');
  const last = h.requests.at(-1).messages.at(-1).content;
  assert.ok(last.includes('"status":"completed"'));
  assert.ok(last.includes('可能已经发生'));
});

test('continuation enforces mutation authentication, terminal/latest status and unchanged source before saving', { timeout: 15000 }, async t => {
  const h = await harness(t, () => partial()); await h.setup(); const original = await h.create(); await h.wait(original, 'failed');
  const endpoint = `/api/runs/${original.id}/continue`, body = { ...scope, requestId: 'safe-retry' };
  const count = () => h.state().then(saved => saved.state.workspaces[0].data.threads[0].messages.length);
  const before = await count();
  for (const [change, headers, expected] of [
    [{}, { Cookie: '' }, 401], [{}, { 'X-CSRF-Token': 'wrong' }, 403], [{}, { Origin: 'https://evil.example' }, 403],
    [{ workspaceId: 'other' }, {}, 404], [{ threadId: 'absent' }, {}, 404], [{ requestId: '' }, {}, 400], [{ arbitrary: true }, {}, 400],
  ]) assert.equal((await h.call(endpoint, { method: 'POST', body: { ...body, ...change }, headers })).status, expected);
  assert.equal(await count(), before); assert.equal(h.requests.length, 1);
  await h.mutate(state => state.workspaces[0].data.threads[0].messages.push({ id: 'new-question', role: 'user', text: 'A newer question' }));
  assert.equal((await h.call(endpoint, { method: 'POST', body })).status, 409);
  assert.equal(h.requests.length, 1);
  await h.mutate(state => { const messages = state.workspaces[0].data.threads[0].messages; messages.pop(); messages[0].text = 'Changed original'; });
  assert.equal((await h.call(endpoint, { method: 'POST', body })).status, 409);
});

test('a pending pre-restart approval cannot authorize a newly continued action', { timeout: 15000 }, async t => {
  let phase = 'first', afterDeny = false;
  const h = await harness(t, () => phase === 'first' || !afterDeny ? toolReply() : reply());
  await h.setup(['Shell']); const original = await h.create(); const before = await h.wait(original, 'waiting_approval');
  await h.restart(() => { if (!afterDeny) return toolReply(); return reply(); }); phase = 'continued';
  assert.equal((await h.get(original)).status, 'interrupted');
  const next = await h.next(original), waiting = await h.wait(next, 'waiting_approval');
  assert.notEqual(waiting.approvals[0].id, before.approvals[0].id);
  await json(await h.call(`/api/runs/${original.id}/approvals/${before.approvals[0].id}`, { method: 'POST', body: { ...scope, decision: 'approve' } }));
  assert.equal((await h.get(next)).status, 'waiting_approval');
  await assert.rejects(stat(path.join(h.dir, 'effect.txt')), { code: 'ENOENT' });
  afterDeny = true;
  await json(await h.call(`/api/runs/${next.id}/approvals/${waiting.approvals[0].id}`, { method: 'POST', body: { ...scope, decision: 'deny' } }));
  await h.wait(next, 'succeeded'); await assert.rejects(stat(path.join(h.dir, 'effect.txt')), { code: 'ENOENT' });
});

test('continuation distinguishes prepared tool output from artifacts actually committed to the workspace', { timeout: 15000 }, async t => {
  let turn = 0;
  const h = await harness(t, () => {
    if (++turn > 1) return partial();
    return new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'prepared-document', type: 'function', function: { name: 'create_artifact', arguments: JSON.stringify({ title: 'Only staged', kind: 'Document', content: 'Not committed' }) } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await h.setup(['Documents']); const source = await h.create(); await h.wait(source, 'failed');
  assert.equal((await h.state()).state.workspaces[0].data.artifacts.length, 0);
  await h.restart(() => reply()); const next = await h.next(source); await h.wait(next, 'succeeded');
  const text = h.requests.at(-1).messages.at(-1).content;
  const snapshot = JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2));
  assert.equal(snapshot.observedToolCalls[0].name, 'create_artifact');
  assert.equal(snapshot.observedToolCalls[0].outcome, 'prepared');
  assert.deepEqual(snapshot.savedArtifacts, []);
  assert.match(text, /不能当作产物已经保存/);
});

test('a saved continuation message can be retried after a crash boundary before run admission', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuation-boundary-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = fixture(); let manager, saves = 0, crash = true;
  const llm = { config: () => ({ configured: true, models: ['deepseek-flash'] }), async chat(_req, res) { res.write('data: ' + JSON.stringify({ type: 'error', message: 'synthetic interruption' }) + '\n\n'); } };
  const options = { dataDir: dir, shellRoot: dir, llm, load: () => ({ state }), persist: () => true,
    createContinuationMessage: async value => { const messages = state.workspaces[0].data.threads[0].messages; if (!messages.some(message => message.id === value.userMessageId)) { messages.push({ id: value.userMessageId, role: 'user', text: value.text, runContinuation: { sourceRunId: value.sourceRunId } }); saves++; } if (crash) throw Error('synthetic process loss after workspace commit'); return { ...scope, userMessageId: value.userMessageId }; } };
  manager = createRunManager(options); t.after(async () => manager?.close());
  const source = await manager.create(request); await poll(() => manager.get(source.id, scope), value => value.status === 'failed');
  await assert.rejects(manager.continue(source.id, { ...scope, requestId: 'durable-boundary' }), /synthetic process loss/);
  await manager.close(); manager = undefined; crash = false; manager = createRunManager(options);
  const next = await manager.continue(source.id, { ...scope, requestId: 'durable-boundary' });
  assert.equal(saves, 1); assert.equal(next.continuedFromRunId, source.id);
  assert.equal(state.workspaces[0].data.threads[0].messages.filter(message => message.runContinuation).length, 1);
  assert.equal((await manager.continue(source.id, { ...scope, requestId: 'durable-boundary' })).id, next.id);
});

test('machine-generated continuation snapshots cannot become companion human-source evidence', () => {
  const state = fixture(), data = state.workspaces[0].data, at = '2026-11-11T12:00:00.000Z';
  data.agents.push({ id: 'personal-agent', name: 'Self', description: '', prompt: 'Help', companion: true });
  data.threads[0].companionAgentId = 'personal-agent'; data.threads[0].config.agentId = 'personal-agent';
  data.threads[0].messages[0].runContinuation = { sourceRunId: 'old-run' };
  data.memories.push({ id: 'memory', content: 'candidate', category: '想法', importance: 3, pinned: false, companion: { agentId: 'personal-agent', status: 'pending', visibility: 'private', createdAt: at, updatedAt: at, source: { threadId: 'work', messageId: 'question', quote: data.threads[0].messages[0].text } } });
  assert.throws(() => validateState(state), /human source/);
});
