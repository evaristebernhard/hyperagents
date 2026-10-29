import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.mjs';
import { emptyState } from './validation.mjs';

// All provider responses and credentials are synthetic. Shell effects are confined
// to per-test temporary directories; no real model or external service is called.
const options = { timeout: 10000 };
const request = { workspaceId: 'personal', threadId: 'thread-1', userMessageId: 'message-1' };
const scope = { workspaceId: 'personal', threadId: 'thread-1' };
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = text => ({ choices: [{ delta: { content: text } }] });
const response = wire => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
const success = (text = 'Durable final answer') => response(frame(delta(text)) + frame('[DONE]'));
const tool = (id, name, args, index = 0) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = calls => response(frame({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'));
const settings = (tools = ['Shell'], extra = {}) => ({ model: 'deepseek-flash', reasoning: 'Low', provider: 'DeepSeek', mode: 'Execute', tools, ...extra });
const thread = (id = 'thread-1', text = 'Saved question') => ({ id, title: 'Runtime test', summary: '', time: '', messages: [{ id: 'message-1', role: 'user', text }] });
function snapshot(count = 1) {
  const state = emptyState();
  for (let i = 1; i <= count; i++) state.workspaces[0].data.threads.push(thread(`thread-${i}`));
  return state;
}
const route = (id, suffix = '', query = scope) => `/api/runs/${id}${suffix}?${new URLSearchParams(query)}`;

async function poll(get, accept, label, milliseconds = 4000) {
  const deadline = Date.now() + milliseconds;
  let last;
  do {
    last = await get();
    if (accept(last)) return last;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}
async function json(res, status = 200) {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return JSON.parse(text);
}
function heldProvider() {
  const calls = [];
  const fetch = async (_url, init) => {
    const call = { signal: init.signal, body: JSON.parse(init.body) };
    calls.push(call);
    return new Response(new ReadableStream({ start(controller) {
      let ended = false;
      controller.enqueue(new TextEncoder().encode(frame(delta('Partial '))));
      const close = () => { if (!ended) { ended = true; controller.close(); } };
      call.finish = (text = 'answer') => {
        assert.equal(ended, false, 'provider should still be connected');
        controller.enqueue(new TextEncoder().encode(frame(delta(text)) + frame('[DONE]')));
        close();
      };
      init.signal.addEventListener('abort', close, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { calls, fetch };
}

// The authentication and revision-checked save harness follows llm.test.mjs.
async function harness(t, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-runs-'));
  const dataDir = path.join(dir, 'data'), shellRoot = path.join(dir, 'shell');
  await mkdir(shellRoot);
  let app, base, cookie, csrf;
  t.after(async () => { try { if (app) await app.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  async function start(overrides = {}) {
    app = await createApp({ dataDir, shellRoot, port: 0, deepseekApiKey: 'synthetic-runtime-test-key', llmFetch: () => success(), ...extra, ...overrides });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
  }
  await start();
  function call(url, opts = {}) {
    const headers = new Headers({ Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) });
    for (const [name, value] of Object.entries(opts.headers || {})) value == null ? headers.delete(name) : headers.set(name, value);
    return fetch(base + url, { ...opts, headers, signal: opts.signal || AbortSignal.timeout(4500), body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  }
  async function setup() {
    const res = await call('/api/setup', { method: 'POST', body: { password: 'local-runtime-test-password' } });
    cookie = res.headers.get('set-cookie')?.split(';')[0];
    csrf = (await json(res)).csrfToken;
  }
  async function state() { return json(await call('/api/state')); }
  async function save(next = snapshot()) {
    const current = await state();
    await json(await call('/api/state', { method: 'PUT', headers: { 'If-Match': String(current.revision) }, body: { state: next } }));
  }
  async function create(body = request) { return (await json(await call('/api/runs', { method: 'POST', body }), 202)).run; }
  async function get(id, query = scope) { return (await json(await call(route(id, '', query)))).run; }
  async function wait(id, status = 'succeeded', query = scope) { return poll(() => get(id, query), run => run.status === status, `run ${id} to be ${status}`); }
  async function events(id, after = 0, query = scope) { return json(await call(route(id, '/events', { ...query, after }))); }
  async function decide(id, actionId, decision, body = scope) { return call(`/api/runs/${id}/approvals/${actionId}`, { method: 'POST', body: { ...body, decision } }); }
  async function cancel(id, body = scope) { return call(`/api/runs/${id}/cancel`, { method: 'POST', body }); }
  async function restart(overrides = {}) { await app.close(); app = undefined; await start(overrides); }
  async function upload(text) {
    const res = await fetch(base + '/api/files?workspaceId=personal', { method: 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'X-File-Name': 'fixture.txt', 'Content-Type': 'text/plain' }, body: text, signal: AbortSignal.timeout(4500) });
    return (await json(res, 201)).file;
  }
  return { call, setup, state, save, create, get, wait, events, decide, cancel, restart, upload, dir, dataDir, shellRoot };
}
async function shellFixture(t, command, extra = {}) {
  let turns = 0;
  const requests = [], signals = [];
  const h = await harness(t, { ...extra, llmFetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body); signals.push(init.signal); turns++;
    assert.ok(body.tools.some(t => t.function.name === 'shell_execute'));
    if (turns === 1) return toolResponse([tool('shell-call', 'shell_execute', { command, timeoutSeconds: 3 })]);
    return success('Shell decision handled');
  } });
  await h.setup(); const s = snapshot(); s.workspaces[0].data.threads[0].config = settings(); await h.save(s);
  const run = await h.create(); const waiting = await h.wait(run.id, 'waiting_approval');
  assert.equal(waiting.approvals.length, 1);
  return { ...h, run, action: waiting.approvals[0], requests, signals, turns: () => turns };
}

test('durable admission returns 202 and writes SQLite before provider completion; the server saves the final answer', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch });
  await h.setup(); await h.save(); const before = await h.state();
  const run = await h.create(); assert.ok(['queued', 'running'].includes(run.status)); assert.equal(run.resultSaved, false);
  await poll(() => provider.calls.length, n => n === 1, 'provider admission');
  const db = new DatabaseSync(path.join(h.dataDir, 'agent-runs.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT id FROM agent_runs WHERE id=?').get(run.id).id, run.id); assert.ok(db.prepare('SELECT count(*) AS n FROM run_events WHERE run_id=?').get(run.id).n >= 1); }
  finally { db.close(); }
  assert.equal((await stat(path.join(h.dataDir, 'agent-runs.sqlite'))).mode & 0o777, 0o600);
  provider.calls[0].finish('persisted without a client PUT');
  const done = await h.wait(run.id); assert.equal(done.resultSaved, true); assert.ok(done.finishedAt); assert.equal(done.model, 'deepseek-flash');
  const after = await h.state(), messages = after.state.workspaces[0].data.threads[0].messages;
  assert.equal(after.revision, before.revision + 1); assert.equal(messages.length, 2); assert.equal(messages[1].id, 'run-answer-' + run.id); assert.equal(messages[1].text, 'Partial persisted without a client PUT');
});

test('run routes enforce authentication, mutation CSRF/origin and workspace/thread scope before effects', options, async t => {
  let calls = 0;
  const h = await harness(t, { llmFetch: () => { calls++; return toolResponse([tool('approval', 'shell_execute', { command: 'printf safe' })]); } });
  const absent = '00000000-0000-0000-0000-000000000000';
  for (const [url, method, body] of [['/api/runtime', 'GET'], ['/api/runs', 'GET'], ['/api/runs', 'POST', request], [route(absent), 'GET'], [route(absent, '/events'), 'GET'], [`/api/runs/${absent}/cancel`, 'POST', scope], [`/api/runs/${absent}/approvals/${absent}`, 'POST', { ...scope, decision: 'approve' }]]) {
    await json(await h.call(url, { method, ...(body ? { body } : {}) }), 401);
  }
  await h.setup(); const s = snapshot(); s.workspaces[0].data.threads[0].config = settings(); await h.save(s);
  for (const headers of [{ 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': null }, { Origin: 'https://evil.invalid' }, { Origin: null }, { 'Sec-Fetch-Site': 'cross-site' }]) await json(await h.call('/api/runs', { method: 'POST', body: request, headers }), 403);
  assert.equal(calls, 0);
  const run = await h.create(), pending = await h.wait(run.id, 'waiting_approval'), action = pending.approvals[0];
  const mutations = [[`/api/runs/${run.id}/cancel`, scope], [`/api/runs/${run.id}/approvals/${action.id}`, { ...scope, decision: 'approve' }]];
  for (const [url, body] of mutations) for (const headers of [{ 'X-CSRF-Token': 'wrong' }, { Origin: 'https://evil.invalid' }, { Cookie: null }]) await json(await h.call(url, { method: 'POST', body, headers }), headers.Cookie === null ? 401 : 403);
  for (const query of [{ ...scope, workspaceId: 'other' }, { ...scope, threadId: 'other' }]) {
    for (const suffix of ['', '/events']) await json(await h.call(route(run.id, suffix, query)), 404);
    await json(await h.cancel(run.id, query), 404); await json(await h.decide(run.id, action.id, 'approve', query), 404);
  }
  await json(await h.cancel(run.id, {}), 400); await json(await h.decide(run.id, action.id, 'approve', {}), 400);
  await json(await h.decide(run.id, action.id, 'execute'), 422);
  await json(await h.decide(run.id, absent, 'approve'), 404);
  assert.equal((await h.get(run.id)).status, 'waiting_approval'); assert.equal(calls, 1);
  await json(await h.cancel(run.id)); await h.wait(run.id, 'cancelled');
});

test('duplicate creation is idempotent while active and after completion, including after reopening the service', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch });
  await h.setup(); await h.save(); const first = await h.create();
  const duplicate = await h.create(); assert.equal(duplicate.id, first.id);
  await poll(() => provider.calls.length, n => n === 1, 'one provider call'); provider.calls[0].finish(); await h.wait(first.id);
  assert.equal((await h.create()).id, first.id); assert.equal(provider.calls.length, 1);
  let replayed = 0; await h.restart({ llmFetch: () => { replayed++; return success(); } });
  assert.equal((await h.create()).id, first.id); assert.equal((await h.get(first.id)).status, 'succeeded');
  assert.equal(replayed, 0); assert.equal((await h.state()).state.workspaces[0].data.threads[0].messages.length, 2);
  const listed = await json(await h.call('/api/runs?' + new URLSearchParams(scope))); assert.equal(listed.runs.length, 1); assert.equal(listed.runs[0].id, first.id);
});

test('simultaneous duplicate requests resolving real attachments admit exactly one durable run', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch });
  await h.setup(); await h.save(); const attachment = await h.upload('Synthetic attachment to exercise asynchronous source resolution');
  const s = snapshot(); s.workspaces[0].data.threads[0].messages[0].context = { attachments: [attachment] }; await h.save(s);
  const admitted = await Promise.all(Array.from({ length: 6 }, () => h.create()));
  assert.equal(new Set(admitted.map(r => r.id)).size, 1, 'same source must have one run even across concurrent admission');
  assert.equal((await json(await h.call('/api/runs?' + new URLSearchParams(scope)))).runs.length, 1);
  assert.equal(provider.calls.length, 1);
});

test('event polling has monotonic resumable cursors, bounded pages and durable terminal events', options, async t => {
  const wire = Array.from({ length: 230 }, (_, i) => frame(delta(String(i) + '|'))).join('') + frame('[DONE]');
  const h = await harness(t, { llmFetch: () => response(wire) }); await h.setup(); await h.save();
  const run = await h.create(); await h.wait(run.id);
  let after = 0, all = [], pages = 0;
  for (;;) {
    const page = await h.events(run.id, after); pages++; assert.ok(page.events.length <= 200);
    for (const item of page.events) { assert.equal(item.seq, after + 1); after = item.seq; all.push(item.event); }
    assert.equal(page.nextCursor, after); if (!page.hasMore) break; assert.ok(pages < 5);
  }
  assert.equal(pages, 2); assert.equal(all.filter(e => e.type === 'delta').length, 230);
  assert.deepEqual(all.at(-1), { type: 'run_status', status: 'succeeded' }); assert.equal(all.at(-2).type, 'done');
  const empty = await h.events(run.id, after); assert.deepEqual(empty.events, []); assert.equal(empty.nextCursor, after); assert.equal(empty.hasMore, false);
  for (const cursor of ['-1', '1.2', 'NaN', '10000000000', '']) await json(await h.call(route(run.id, '/events', { ...scope, after: cursor })), 400);
  await h.restart(); assert.deepEqual((await h.events(run.id, 200)).events.map(e => e.event), all.slice(200));
});

test('orderly service close, unlike viewer disconnect, aborts active work and preserves interrupted status', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch });
  await h.setup(); await h.save(); const run = await h.create();
  await poll(() => provider.calls.length, n => n === 1, 'fake provider');
  const controller = new AbortController(); const pollResponse = await h.call(route(run.id, '/events'), { signal: controller.signal });
  await pollResponse.body.cancel(); controller.abort();
  await h.restart({ llmFetch: () => success() });
  // A server restart is deliberately not a viewer disconnect: it interrupts work.
  assert.equal(provider.calls[0].signal.aborted, true); assert.equal((await h.get(run.id)).status, 'interrupted');
});

test('closing only a viewer connection preserves a running provider and the finished server-side answer', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch }); await h.setup(); await h.save();
  const controller = new AbortController(); const admission = await h.call('/api/runs', { method: 'POST', body: request, signal: controller.signal });
  const run = (await json(admission, 202)).run; controller.abort();
  await poll(() => provider.calls.length, n => n === 1, 'provider started');
  const viewer = await h.call(route(run.id, '/events'), { headers: { Connection: 'close' } }); await viewer.body.cancel();
  // Round-trip another request to let the server observe the closed connection.
  await h.get(run.id); assert.equal(provider.calls[0].signal.aborted, false);
  provider.calls[0].finish('survived viewer disconnect'); const final = await h.wait(run.id); assert.equal(final.resultSaved, true);
  const answer = (await h.state()).state.workspaces[0].data.threads[0].messages[1]; assert.equal(answer.text, 'Partial survived viewer disconnect');
});

test('two concurrent runs execute, a third queues and starts when a slot is released', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch }); await h.setup(); await h.save(snapshot(3));
  const runs = [];
  for (let i = 1; i <= 3; i++) runs.push(await h.create({ ...request, threadId: `thread-${i}` }));
  await poll(() => provider.calls.length, n => n === 2, 'two active providers');
  assert.equal((await h.get(runs[2].id, { ...scope, threadId: 'thread-3' })).status, 'queued');
  provider.calls[0].finish('first'); await h.wait(runs[0].id);
  await poll(() => provider.calls.length, n => n === 3, 'queued provider promotion');
  assert.equal(provider.calls[2].body.messages.at(-1).content, 'Saved question');
  provider.calls[1].finish('second'); provider.calls[2].finish('third');
  for (let i = 0; i < 3; i++) assert.equal((await h.wait(runs[i].id, 'succeeded', { ...scope, threadId: `thread-${i + 1}` })).resultSaved, true);
});

test('cancelling a queued run prevents provider admission; cancelling a running run aborts its provider', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch }); await h.setup(); await h.save(snapshot(3));
  const runs = []; for (let i = 1; i <= 3; i++) runs.push(await h.create({ ...request, threadId: `thread-${i}` }));
  await poll(() => provider.calls.length, n => n === 2, 'two providers');
  await json(await h.cancel(runs[2].id, { ...scope, threadId: 'thread-3' })); await h.wait(runs[2].id, 'cancelled', { ...scope, threadId: 'thread-3' });
  await json(await h.cancel(runs[0].id)); await h.wait(runs[0].id, 'cancelled');
  assert.equal(provider.calls[0].signal.aborted, true); assert.equal(provider.calls.length, 2);
  provider.calls[1].finish(); await h.wait(runs[1].id, 'succeeded', { ...scope, threadId: 'thread-2' });
  await json(await h.cancel(runs[0].id)); assert.equal((await h.get(runs[0].id)).status, 'cancelled'); assert.equal(provider.calls.length, 2);
  assert.match((await h.state()).state.workspaces[0].data.threads[0].messages[1].text, /Stopped — partial answer/);
});

test('invalid request/source/model and workspace-local resources are rejected before provider execution', options, async t => {
  let calls = 0; const h = await harness(t, { llmFetch: () => { calls++; return success(); } }); await h.setup(); await h.save();
  for (const body of [null, [], {}, { ...request, messages: [] }, { ...request, threadId: '../escape' }, { ...request, userMessageId: 42 }]) await json(await h.call('/api/runs', { method: 'POST', body }), 400);
  for (const model of ['gpt-4', null, 'deepseek-flash ']) await json(await h.call('/api/runs', { method: 'POST', body: { ...request, model } }), 422);
  for (const body of [{ ...request, workspaceId: 'missing' }, { ...request, threadId: 'missing' }]) await json(await h.call('/api/runs', { method: 'POST', body }), 404);
  await json(await h.call('/api/runs', { method: 'POST', body: { ...request, userMessageId: 'missing' } }), 409);
  for (const mutate of [t => t.messages.push({ id: 'answered', role: 'assistant', text: 'Already answered' }), t => t.messages[0].text = ' ', t => t.messages[0].text = 'x'.repeat(16001), t => t.messages.push({ ...t.messages[0] }), t => t.archived = true]) {
    const s = snapshot(); mutate(s.workspaces[0].data.threads[0]); await h.save(s);
    const expected = s.workspaces[0].data.threads[0].archived ? 404 : s.workspaces[0].data.threads[0].messages[0].text.length > 16000 ? 413 : 409;
    await json(await h.call('/api/runs', { method: 'POST', body: request }), expected);
  }
  for (const context of [{ memoryIds: ['foreign-memory'] }, { skillIds: ['foreign-skill'] }, { artifactIds: ['foreign-artifact'] }, { projectId: 'foreign-project' }, { settings: settings([], { agentId: 'foreign-agent' }) }]) {
    const s = snapshot(); const foreign = emptyState().workspaces[0]; foreign.id = 'foreign'; s.workspaces.push(foreign);
    foreign.data.threads.push(thread('foreign-thread'));
    foreign.data.memories.push({ id: 'foreign-memory', content: 'Not authorized', category: 'fact', importance: 3, pinned: true, tags: [] });
    s.workspaces[0].data.threads[0].messages[0].context = context; await h.save(s);
    await json(await h.call('/api/runs', { method: 'POST', body: request }), 422);
    await json(await h.call('/api/runs', { method: 'POST', body: { ...request, threadId: 'foreign-thread' } }), 404);
  }
  assert.equal(calls, 0); await json(await h.call('/api/runs'), 400); await json(await h.call('/api/runs?workspaceId=personal&threadId=missing'), 404);
});

test('an injected fetch cannot bypass the requirement for an explicitly configured provider key', options, async t => {
  let calls = 0; const h = await harness(t, { deepseekApiKey: undefined, llmFetch: () => { calls++; return success(); } }); await h.setup(); await h.save();
  await json(await h.call('/api/runs', { method: 'POST', body: request }), 503); assert.equal(calls, 0);
});

test('artifact tools persist document updates and tables atomically with the answer, without client patches', options, async t => {
  let turns = 0, documentId;
  const h = await harness(t, { llmFetch: async (_url, init) => {
    turns++; const body = JSON.parse(init.body);
    if (turns === 1) return toolResponse([tool('create-doc', 'create_artifact', { title: 'Durable document', kind: 'Document', content: '# First' })]);
    const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (turns === 2) { documentId = results[0].id; return toolResponse([tool('update-doc', 'update_artifact', { id: documentId, content: '# Final' }), tool('create-table', 'create_table', { title: 'Durable table', columns: ['Name'], rows: [['Value']] }, 1)]); }
    assert.equal(results.length, 3); return success('Artifacts persisted by server');
  } });
  await h.setup(); const s = snapshot(); s.workspaces[0].data.threads[0].config = settings(['Documents', 'Tables']); await h.save(s);
  const run = await h.create(); const done = await h.wait(run.id); assert.equal(done.resultSaved, true); assert.equal(done.toolCount, 3);
  const data = (await h.state()).state.workspaces[0].data; assert.equal(data.artifacts.length, 2); assert.equal(data.threads[0].messages[1].text, 'Artifacts persisted by server');
  const doc = data.artifacts.find(a => a.id === documentId); assert.equal(doc.content, '# Final'); assert.ok(doc.versions.some(v => v.content === '# First')); assert.equal(doc.threadId, 'thread-1');
  assert.deepEqual(JSON.parse(data.artifacts.find(a => a.kind === 'Table').content), { columns: ['Name'], rows: [['Value']] });
  const logged = await h.events(run.id); assert.equal(logged.events.filter(e => e.event.type === 'artifact').length, 2);
  await h.restart(); assert.deepEqual((await h.state()).state.workspaces[0].data.artifacts, data.artifacts); assert.equal((await h.create()).id, run.id);
});

test('approved real shell command executes exactly once, exposes output to the next model turn and saves the answer', options, async t => {
  const h = await shellFixture(t, "printf 'one\\n' >> effects.txt; printf 'visible stdout'; printf 'visible stderr' >&2");
  const marker = path.join(h.shellRoot, 'effects.txt'); assert.equal(existsSync(marker), false); assert.equal(h.turns(), 1);
  assert.equal(h.action.status, 'pending'); assert.equal(h.action.cwd, h.shellRoot); assert.equal(h.action.timeoutSeconds, 3);
  const before = await h.events(h.run.id); assert.ok(before.events.some(e => e.event.type === 'shell_approval' && e.event.command === h.action.command)); assert.ok(!before.events.some(e => e.event.type === 'shell_result'));
  const approvals = await Promise.all([h.decide(h.run.id, h.action.id, 'approve'), h.decide(h.run.id, h.action.id, 'approve')]); for (const res of approvals) await json(res);
  const done = await h.wait(h.run.id); assert.equal(done.resultSaved, true); assert.equal(done.approvals[0].status, 'completed'); assert.equal(h.turns(), 2);
  assert.equal(await readFile(marker, 'utf8'), 'one\n');
  const result = JSON.parse(h.requests[1].messages.find(m => m.role === 'tool').content); assert.equal(result.status, 'executed'); assert.equal(result.stdout, 'visible stdout'); assert.equal(result.stderr, 'visible stderr'); assert.equal(result.exitCode, 0);
  await json(await h.decide(h.run.id, h.action.id, 'approve')); assert.equal(await readFile(marker, 'utf8'), 'one\n'); assert.equal(h.turns(), 2);
  assert.equal((await h.state()).state.workspaces[0].data.threads[0].messages[1].text, 'Shell decision handled');
});

test('denying a shell proposal has no effect and passes an explicit denial to the provider', options, async t => {
  const h = await shellFixture(t, 'printf forbidden > denied.txt'); const marker = path.join(h.shellRoot, 'denied.txt');
  await json(await h.decide(h.run.id, h.action.id, 'deny')); const done = await h.wait(h.run.id);
  assert.equal(done.approvals[0].status, 'denied'); assert.equal(existsSync(marker), false); assert.equal(h.turns(), 2);
  const result = JSON.parse(h.requests[1].messages.find(m => m.role === 'tool').content); assert.equal(result.status, 'denied'); assert.equal(result.executed, false);
  await json(await h.decide(h.run.id, h.action.id, 'approve')); assert.equal(existsSync(marker), false); assert.equal(h.turns(), 2);
});

test('cancelling a pending shell approval aborts the provider and prevents subsequent approval from executing', options, async t => {
  const h = await shellFixture(t, 'printf forbidden > cancelled.txt'); const marker = path.join(h.shellRoot, 'cancelled.txt');
  await json(await h.cancel(h.run.id)); const done = await h.wait(h.run.id, 'cancelled'); assert.equal(done.approvals[0].status, 'cancelled');
  assert.equal(h.signals[0].aborted, true);
  await json(await h.decide(h.run.id, h.action.id, 'approve')); assert.equal(existsSync(marker), false); assert.equal(h.turns(), 1);
  assert.ok(!(await h.events(h.run.id)).events.some(e => e.event.type === 'shell_result'));
});

test('approved shell stdout/stderr cannot inherit synthetic parent/provider environment secrets', options, async t => {
  const name = 'AGENT_RUN_TEST_PRIVATE_SECRET', prior = process.env[name]; process.env[name] = 'synthetic-parent-secret-do-not-copy';
  t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  const h = await shellFixture(t, `printf 'secret=%s key=%s home=%s\\n' "\${${name}-unset}" "\${DEEPSEEK_API_KEY-unset}" "$HOME"; /usr/bin/env; printf 'stderr=%s' "\${${name}-unset}" >&2`);
  await json(await h.decide(h.run.id, h.action.id, 'approve')); await h.wait(h.run.id);
  const result = JSON.parse(h.requests[1].messages.find(m => m.role === 'tool').content);
  assert.match(result.stdout, /secret=unset key=unset/); assert.ok(result.stdout.includes('HOME=' + h.shellRoot)); assert.equal(result.stderr, 'stderr=unset');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-parent-secret-do-not-copy|synthetic-runtime-test-key/);
  assert.doesNotMatch(JSON.stringify((await h.events(h.run.id)).events), /synthetic-parent-secret-do-not-copy|synthetic-runtime-test-key/);
});

test('a real process restart interrupts queued/running/approval-waiting runs and never replays shell actions', options, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-runs-crash-')), dataDir = path.join(dir, 'data'), shellRoot = path.join(dir, 'shell'); await mkdir(shellRoot);
  let child, app, base, cookie, csrf, diagnostic = '';
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await poll(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'child cleanup', 1500); }
    try { if (app) await app.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  // Start a separate process so startup recovery is tested against an actual
  // unclean shutdown, not synthetic database rows or orderly close behavior.
  const source = `import {createApp} from ${JSON.stringify(new URL('./app.mjs', import.meta.url).href)};
    const frame=x=>'data: '+(typeof x==='string'?x:JSON.stringify(x))+'\\n\\n';
    const app=await createApp({dataDir:${JSON.stringify(dataDir)},shellRoot:${JSON.stringify(shellRoot)},port:0,deepseekApiKey:'synthetic-crash-key',llmFetch:async(_url,init)=>{
      const body=JSON.parse(init.body);
      if(body.messages.at(-1).content==='Request shell')return new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'crash-shell',type:'function',function:{name:'shell_execute',arguments:JSON.stringify({command:'printf forbidden > replayed.txt'})}}]},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'content-type':'text/event-stream'}});
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'before crash'}}]})));init.signal.addEventListener('abort',()=>c.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});
    }}); const address=await app.listen(); process.send({port:address.port});`;
  child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  let port; child.on('message', message => { port = message.port; });
  await poll(() => ({ port, ended: child.exitCode !== null || child.signalCode !== null }), value => { if (value.ended) assert.fail('Child exited: ' + diagnostic); return !!value.port; }, 'child listening', 3000);
  base = `http://127.0.0.1:${port}`;
  const call = (url, opts = {}) => fetch(base + url, { ...opts, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...opts.headers }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(4000) });
  const setup = await call('/api/setup', { method: 'POST', body: { password: 'local-restart-test-password' } }); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await json(setup)).csrfToken;
  const s = snapshot(3); s.workspaces[0].data.threads[0].config = settings(); s.workspaces[0].data.threads[0].messages[0].text = 'Request shell';
  await json(await call('/api/state', { method: 'PUT', headers: { 'If-Match': '0' }, body: { state: s } }));
  const runs = []; for (let i = 1; i <= 3; i++) runs.push((await json(await call('/api/runs', { method: 'POST', body: { ...request, threadId: `thread-${i}` } }), 202)).run);
  const get = async id => (await json(await call(`/api/runs/${id}`))).run;
  await poll(() => get(runs[0].id), run => run.status === 'waiting_approval', 'pre-crash approval');
  await poll(() => get(runs[1].id), run => run.status === 'running', 'pre-crash provider'); assert.equal((await get(runs[2].id)).status, 'queued');
  child.kill('SIGKILL'); await poll(() => child.signalCode, code => code === 'SIGKILL', 'actual process death', 2000);
  let replayed = 0; app = await createApp({ dataDir, shellRoot, port: 0, deepseekApiKey: 'synthetic-restart-key', llmFetch: () => { replayed++; return success(); } }); base = `http://127.0.0.1:${(await app.listen()).port}`;
  for (const run of runs) {
    const recovered = await get(run.id); assert.equal(recovered.status, 'interrupted'); assert.ok(recovered.finishedAt); assert.match(recovered.error, /restarted.*No commands were replayed/);
    const log = await json(await call(`/api/runs/${run.id}/events`)); assert.deepEqual(log.events.at(-1).event, { type: 'run_status', status: 'interrupted' });
    assert.equal((await json(await call('/api/runs', { method: 'POST', body: { ...request, threadId: recovered.threadId } }), 202)).run.id, run.id);
  }
  const pending = await get(runs[0].id); assert.equal(pending.approvals[0].status, 'expired');
  await json(await call(`/api/runs/${pending.id}/approvals/${pending.approvals[0].id}`, { method: 'POST', body: { ...scope, decision: 'approve' } }));
  assert.equal(replayed, 0); assert.equal(existsSync(path.join(shellRoot, 'replayed.txt')), false);
});

test('runtime capabilities accurately expose durability, concurrency, approval and bounded shell limits', options, async t => {
  const h = await harness(t); await h.setup();
  const capabilities = await json(await h.call('/api/runtime'));
  assert.equal(capabilities.durable, true); assert.equal(capabilities.concurrency, 2);
  assert.equal(capabilities.shell.available, true); assert.equal(capabilities.shell.approvalRequired, true);
  assert.equal(capabilities.shell.root, h.shellRoot); assert.equal(capabilities.shell.maxCommandSeconds, 300);
  assert.equal(capabilities.browser, false); assert.ok(capabilities.maxRunSeconds > 0); assert.ok(capabilities.maxToolCalls > 0);
});

test('editing the source of a queued run prevents its provider call when the queue advances', options, async t => {
  const provider = heldProvider(), h = await harness(t, { runConcurrency: 1, llmFetch: provider.fetch });
  await h.setup(); await h.save(snapshot(2)); const first = await h.create();
  const secondScope = { ...scope, threadId: 'thread-2' }, second = await h.create({ ...request, ...secondScope });
  assert.equal((await h.get(second.id, secondScope)).status, 'queued');
  const state = (await h.state()).state; state.workspaces[0].data.threads[1].messages[0].text = 'Changed after admission'; await h.save(state);
  provider.calls[0].finish(); await h.wait(first.id);
  const failed = await h.wait(second.id, 'failed', secondScope); assert.equal(failed.resultSaved, false); assert.equal(provider.calls.length, 1);
  const logged = await h.events(second.id, 0, secondScope); assert.ok(logged.events.some(e => e.event.type === 'error' && /source message changed/.test(e.event.message)));
  assert.equal((await h.state()).state.workspaces[0].data.threads[1].messages.length, 1);
});

test('cancelling an approved executing shell kills its process group before delayed effects', options, async t => {
  const h = await shellFixture(t, 'printf started > started.txt; sleep 2; printf forbidden > late.txt');
  await json(await h.decide(h.run.id, h.action.id, 'approve'));
  await poll(() => existsSync(path.join(h.shellRoot, 'started.txt')), Boolean, 'real shell startup', 2000);
  await json(await h.cancel(h.run.id)); const stopped = await h.wait(h.run.id, 'cancelled');
  assert.equal(h.signals[0].aborted, true); assert.equal(h.turns(), 1); assert.equal(stopped.approvals[0].status, 'cancelled');
  assert.equal(existsSync(path.join(h.shellRoot, 'late.txt')), false);
  const logged = await h.events(h.run.id); const result = logged.events.find(e => e.event.type === 'shell_result')?.event.result;
  assert.ok(result); assert.equal(result.cancelled, true); assert.equal(result.signal, 'SIGKILL');
});

test('a provider failure is sanitized, durably logged and persisted as a failed partial answer', options, async t => {
  const h = await harness(t, { llmFetch: () => { throw Error('synthetic-hidden-upstream-secret'); } }); await h.setup(); await h.save();
  const run = await h.create(), failed = await h.wait(run.id, 'failed'); assert.equal(failed.resultSaved, true);
  const logged = await h.events(run.id); assert.ok(logged.events.some(e => e.event.type === 'error')); assert.ok(!logged.events.some(e => e.event.type === 'done'));
  assert.doesNotMatch(JSON.stringify(logged), /synthetic-hidden-upstream-secret|synthetic-runtime-test-key/);
  assert.match((await h.state()).state.workspaces[0].data.threads[0].messages[1].text, /Interrupted — partial answer/);
});

test('idempotent run lookup still rejects unsupported explicit models rather than bypassing request validation', options, async t => {
  const provider = heldProvider(), h = await harness(t, { llmFetch: provider.fetch }); await h.setup(); await h.save();
  const run = await h.create();
  await json(await h.call('/api/runs', { method: 'POST', body: { ...request, model: 'unsupported-provider-model' } }), 422);
  assert.equal((await h.create()).id, run.id); assert.equal(provider.calls.length, 1);
});

test('foreign integration references are rejected at durable admission, not admitted as doomed work', options, async t => {
  let calls = 0; const h = await harness(t, { llmFetch: () => { calls++; return success(); } }); await h.setup();
  const state = snapshot(), foreign = emptyState().workspaces[0]; foreign.id = 'foreign'; state.workspaces.push(foreign);
  foreign.data.connections.push({ id: 'foreign-connection', provider: 'GitHub', label: 'Synthetic unavailable connection', endpoint: 'https://api.github.com', enabled: true, createdAt: new Date().toISOString() });
  state.workspaces[0].data.threads[0].messages[0].context = { integrationIds: ['foreign-connection'] }; await h.save(state);
  await json(await h.call('/api/runs', { method: 'POST', body: request }), 422);
  assert.equal(calls, 0); assert.deepEqual((await json(await h.call('/api/runs?' + new URLSearchParams(scope)))).runs, []);
});
