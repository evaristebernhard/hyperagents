import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.mjs';
import { emptyState } from './validation.mjs';

// Real HTTP, sessions, SQLite, durable runs and commits; provider bytes are
// deliberately synthetic. No .env, production database or model is accessed.
const at = '2026-11-11T12:00:00.000Z';
const firstPreference = '饮茶偏好：推荐无糖绿茶，偏好标记 PREFERENCE_A。';
const editedPreference = '饮茶偏好：推荐清香乌龙茶，偏好标记 PREFERENCE_B。';
const settings = { model: 'deepseek-flash', reasoning: 'Low', provider: 'DeepSeek', mode: 'Execute', agentId: 'companion', tools: [] };
const question = '我想喝茶，请根据我的习惯推荐。';
const message = id => ({ id, role: 'user', text: question, createdAt: at });
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const providerResponse = () => new Response(frame({ choices: [{ delta: { content: 'Synthetic completed answer.' }, finish_reason: 'stop' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });

function fixture() {
  const state = emptyState(), data = state.workspaces[0].data;
  data.agents.push({ id: 'companion', name: '个人分身', description: 'Self-chat companion', prompt: '请根据主人确认的背景回答。', companion: true, memoryReadScope: 'all', tools: [] });
  data.threads.push({ id: 'self', title: '私密自聊', summary: '', time: '', companionAgentId: 'companion', config: structuredClone(settings), messages: [message('question-one')] },
    { id: 'ordinary', title: '普通聊天', summary: '', time: '', config: structuredClone(settings), messages: [message('ordinary-question')] });
  data.memories.push({ id: 'tea-memory', content: firstPreference, category: '喜好', importance: 3, pinned: true,
    companion: { agentId: 'companion', status: 'pending', visibility: 'private', createdAt: at, updatedAt: at,
      history: [{ action: 'create', content: firstPreference, status: 'pending', visibility: 'private', at }] } });
  return state;
}
async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
async function harness(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'companion-flow-'));
  const requests = [];
  let app, base, cookie, csrf;
  const start = async () => {
    app = await createApp({ dataDir: dir, shellRoot: dir, port: 0, deepseekApiKey: 'synthetic-companion-test-key',
      llmFetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return providerResponse(); } });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
  };
  await start();
  t.after(async () => { try { if (app) await app.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const call = (route, options = {}) => {
    const headers = new Headers({ Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) });
    for (const [name, value] of Object.entries(options.headers || {})) value === null ? headers.delete(name) : headers.set(name, value);
    return fetch(base + route, { ...options, headers, signal: AbortSignal.timeout(4500), body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  };
  const state = () => call('/api/state').then(json);
  const put = (value, revision, headers = {}) => call('/api/state', { method: 'PUT', headers: { 'If-Match': String(revision), ...headers }, body: { state: value } });
  const mutate = async edit => {
    const current = await state();
    edit(current.state);
    await json(await put(current.state, current.revision));
    return state();
  };
  const events = async (run, scope) => {
    const all = []; let after = 0;
    for (;;) {
      const page = await json(await call(`/api/runs/${run.id}/events?${new URLSearchParams({ ...scope, after: String(after) })}`));
      for (const row of page.events) { assert.equal(row.seq, after + 1); after = row.seq; all.push(row.event); }
      assert.equal(page.nextCursor, after);
      if (!page.hasMore) return all;
    }
  };
  const run = async (userMessageId, threadId = 'self', workspaceId = 'personal') => {
    const scope = { workspaceId, threadId };
    const run = (await json(await call('/api/runs', { method: 'POST', body: { ...scope, userMessageId } }), 202)).run;
    let latest;
    const deadline = Date.now() + 4000;
    do {
      latest = (await json(await call(`/api/runs/${run.id}?${new URLSearchParams(scope)}`))).run;
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(latest.status)) break;
      await delay(10);
    } while (Date.now() < deadline);
    assert.equal(latest.status, 'succeeded', JSON.stringify(latest));
    assert.equal(latest.resultSaved, true);
    const history = await events(run, scope);
    assert.deepEqual(history.at(-1), { type: 'run_status', status: 'succeeded' });
    assert.ok(history.some(event => event.type === 'done'));
    const hints = history.find(event => event.type === 'knowledge_hints')?.knowledgeHints;
    const saved = await state();
    const answer = saved.state.workspaces.find(w => w.id === workspaceId).data.threads.find(t => t.id === threadId).messages.find(m => m.id === 'run-answer-' + run.id);
    assert.equal(answer.text, 'Synthetic completed answer.');
    assert.deepEqual(answer.knowledgeHints, hints, 'run events and final committed message retain the same context evidence');
    return { run: latest, answer, request: requests.at(-1), state: saved };
  };
  return { call, state, put, mutate, run, requests,
    async setup() {
      const response = await call('/api/setup', { method: 'POST', body: { password: 'synthetic-companion-test-password' } });
      cookie = response.headers.get('set-cookie')?.split(';')[0];
      csrf = (await json(response)).csrfToken;
    },
    async restart() { await app.close(); app = undefined; await start(); },
  };
}
function recordEdit(memory, status, content = memory.content, action = 'edit') {
  memory.content = content;
  memory.companion.status = status;
  memory.companion.updatedAt = '2026-11-11T12:01:00.000Z';
  memory.companion.history.push({ action, content, status, visibility: memory.companion.visibility, at: memory.companion.updatedAt });
}

test('HTTP companion lifecycle gates real managed-run context and preserves historical snapshots', { timeout: 15000 }, async t => {
  const h = await harness(t);
  await h.setup(); await h.mutate(state => Object.assign(state, fixture()));
  assert.equal((await h.state()).state.workspaces[0].data.memories[0].companion.status, 'pending');
  const pending = await h.run('question-one');
  assert.ok(!JSON.stringify(pending.request).includes(firstPreference));
  assert.deepEqual(pending.answer.knowledgeHints, { skillIds: [], memoryIds: [] });

  await h.mutate(state => {
    const data = state.workspaces[0].data;
    recordEdit(data.memories[0], 'active', firstPreference, 'confirm');
    data.threads[0].messages.push(message('question-two'));
  });
  const confirmed = await h.run('question-two');
  assert.ok(confirmed.request.messages[0].content.includes(firstPreference));
  assert.deepEqual(confirmed.answer.knowledgeHints.memoryIds, ['tea-memory']);
  assert.deepEqual(confirmed.answer.knowledgeHints.memorySnapshots, [{ id: 'tea-memory', content: firstPreference, visibility: 'private', agentId: 'companion' }]);
  assert.ok(!JSON.stringify(confirmed.request).includes('synthetic-companion-test-key'));

  await h.mutate(state => {
    const data = state.workspaces[0].data;
    recordEdit(data.memories[0], 'active', editedPreference);
    data.threads[0].messages.push(message('question-three'));
  });
  const edited = await h.run('question-three');
  assert.ok(edited.request.messages[0].content.includes(editedPreference));
  assert.ok(!JSON.stringify(edited.request).includes(firstPreference), 'old private snapshots are evidence, not implicit future model context');
  assert.equal(edited.answer.knowledgeHints.memorySnapshots[0].content, editedPreference);

  await h.mutate(state => {
    const data = state.workspaces[0].data;
    recordEdit(data.memories[0], 'pending', editedPreference, 'withdraw');
    data.threads[0].messages.push(message('question-four'));
  });
  const withdrawn = await h.run('question-four');
  assert.ok(!JSON.stringify(withdrawn.request).includes(firstPreference));
  assert.ok(!JSON.stringify(withdrawn.request).includes(editedPreference));
  assert.deepEqual(withdrawn.answer.knowledgeHints, { skillIds: [], memoryIds: [] });
  await h.restart();
  const reopened = (await h.state()).state.workspaces[0].data;
  const answers = reopened.threads[0].messages.filter(m => m.role === 'assistant');
  assert.equal(answers[1].knowledgeHints.memorySnapshots[0].content, firstPreference);
  assert.equal(answers[2].knowledgeHints.memorySnapshots[0].content, editedPreference);
  assert.equal(reopened.memories[0].companion.status, 'pending');
  assert.deepEqual(reopened.memories[0].companion.history.map(entry => entry.action), ['create', 'confirm', 'edit', 'withdraw']);
  assert.equal(h.requests.length, 4, 'reopening the service does not replay model calls');
});

test('HTTP runs isolate private memories from ordinary threads and other workspaces', { timeout: 10000 }, async t => {
  const h = await harness(t);
  await h.setup();
  const state = fixture(), foreign = fixture().workspaces[0];
  state.workspaces[0].data.memories[0].companion.status = 'active';
  foreign.id = 'foreign'; foreign.name = 'Other workspace';
  foreign.data.memories[0].content = '饮茶偏好：FOREIGN_PRIVATE_PREFERENCE。';
  foreign.data.memories[0].companion.status = 'active';
  state.workspaces.push(foreign); state.active = 'foreign';
  await h.mutate(current => Object.assign(current, state));
  const normal = await h.run('ordinary-question', 'ordinary');
  assert.ok(!JSON.stringify(normal.request).includes(firstPreference));
  assert.ok(!JSON.stringify(normal.request).includes('FOREIGN_PRIVATE_PREFERENCE'));
  assert.deepEqual(normal.answer.knowledgeHints, { skillIds: [], memoryIds: [] });
  const personal = await h.run('question-one');
  assert.ok(personal.request.messages[0].content.includes(firstPreference));
  assert.ok(!JSON.stringify(personal.request).includes('FOREIGN_PRIVATE_PREFERENCE'));
  const other = await h.run('question-one', 'self', 'foreign');
  assert.ok(other.request.messages[0].content.includes('FOREIGN_PRIVATE_PREFERENCE'));
  assert.ok(!JSON.stringify(other.request).includes(firstPreference));
  assert.equal(other.answer.knowledgeHints.memorySnapshots[0].content, foreign.data.memories[0].content);
});

test('HTTP companion saves and runs require owner authentication, CSRF and current revisions', { timeout: 10000 }, async t => {
  const h = await harness(t), state = fixture();
  await json(await h.call('/api/state'), 401);
  await json(await h.put(state, 0), 401);
  await json(await h.call('/api/runs', { method: 'POST', body: { workspaceId: 'personal', threadId: 'self', userMessageId: 'question-one' } }), 401);
  await h.setup(); const initial = await h.state();
  await json(await h.put(state, initial.revision));
  const saved = await h.state();
  const changed = structuredClone(saved.state); recordEdit(changed.workspaces[0].data.memories[0], 'active', firstPreference, 'confirm');
  await json(await h.put(changed, saved.revision, { 'X-CSRF-Token': 'incorrect' }), 403);
  await json(await h.put(changed, saved.revision, { Origin: 'https://untrusted.invalid' }), 403);
  await json(await h.put(changed, initial.revision), 409);
  assert.deepEqual(await h.state(), saved, 'rejected edits never confirm a candidate or change revision');
  const request = { workspaceId: 'personal', threadId: 'self', userMessageId: 'question-one' };
  await json(await h.call('/api/runs', { method: 'POST', body: request, headers: { 'X-CSRF-Token': 'incorrect' } }), 403);
  await json(await h.call('/api/runs', { method: 'POST', body: request, headers: { Origin: 'https://untrusted.invalid' } }), 403);
  assert.equal(h.requests.length, 0, 'unauthorized HTTP requests never reach the provider');
});
