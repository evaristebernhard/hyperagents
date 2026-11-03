import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.mjs';

// The HTTP boundary, authentication, revision checks and SQLite are real.
// Models and plugins below are deterministic local fixtures: no credentials or
// provider/external-service requests are used by this suite.
const options = { timeout: 12000 };
const scope = { workspaceId: 'personal' };
const taskRequest = (requestId, text, extra = {}) => ({ ...scope, requestId, text, pluginIds: [], model: 'test-model', ...extra });
const done = text => ({ text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } });
const callTool = (id, name, args) => ({ text: '', toolCalls: [{ id, name, arguments: args }], assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
const noPlugins = { list: () => [], bind: () => ({ definitions: () => [], metadata: () => undefined, execute: () => { throw Error('Unknown tool'); } }) };

async function poll(get, accept, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await get();
    if (accept(last)) return last;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
async function json(response, expected = 200) {
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return JSON.parse(text);
}
async function harness(t, extra = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-api-'));
  const calls = [];
  const model = { configured: true, models: ['test-model'], step: async input => { calls.push(input); return done('Local test answer'); } };
  let app, base, cookie, csrf;
  t.after(async () => { try { if (app) await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function start(overrides = {}) {
    app = await createApp({ dataDir, port: 0, taskModel: model, taskPlugins: noPlugins, ...extra, ...overrides });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
  }
  await start();
  function request(url, init = {}) {
    const headers = new Headers({ Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) });
    for (const [name, value] of Object.entries(init.headers || {})) value === null ? headers.delete(name) : headers.set(name, value);
    return fetch(base + url, { ...init, headers, signal: init.signal || AbortSignal.timeout(6000), body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  async function setup() {
    const response = await request('/api/setup', { method: 'POST', body: { password: 'synthetic-task-api-password' } });
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    csrf = (await json(response)).csrfToken;
  }
  const create = async body => (await json(await request('/api/tasks', { method: 'POST', body }), 202)).task;
  const get = (id, workspaceId = 'personal') => request(`/api/tasks/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId })}`).then(json);
  const wait = (id, status = 'succeeded') => poll(() => get(id), value => value.task.status === status, `task ${id} ${status}`);
  const input = (id, text, requestId) => request(`/api/tasks/${encodeURIComponent(id)}/inputs`, { method: 'POST', body: { ...scope, text, requestId } });
  async function restart(overrides = {}) { await app.close(); app = undefined; await start(overrides); }
  return { request, setup, create, get, wait, input, restart, calls, dataDir };
}

test('task API requires owner authentication, CSRF and a trusted origin before model execution', options, async t => {
  const h = await harness(t);
  await json(await h.request('/api/agent-runtime?workspaceId=personal'), 401);
  await json(await h.request('/api/tasks?workspaceId=personal'), 401);
  await json(await h.request('/api/tasks', { method: 'POST', body: taskRequest('denied', 'Must not run') }), 401);
  await h.setup();
  await json(await h.request('/api/tasks', { method: 'POST', headers: { 'X-CSRF-Token': null }, body: taskRequest('no-csrf', 'Must not run') }), 403);
  await json(await h.request('/api/tasks', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: taskRequest('bad-origin', 'Must not run') }), 403);
  assert.equal(h.calls.length, 0);
  const created = await h.create(taskRequest('allowed', 'An authenticated task'));
  assert.ok(created.id);
  await h.wait(created.id);
  assert.equal(h.calls.length, 1);
});

test('task creation is durable and exact-request idempotent, with workspace-scoped reads', options, async t => {
  const h = await harness(t);
  await h.setup();
  const body = taskRequest('stable-request', 'Remember this task');
  const [a, b] = await Promise.all([h.create(body), h.create(body)]);
  assert.equal(a.id, b.id);
  const finished = await h.wait(a.id);
  assert.equal(finished.task.output, 'Local test answer');
  await json(await h.request('/api/tasks', { method: 'POST', body: { ...body, text: 'A different task' } }), 409);
  await json(await h.request(`/api/tasks/${a.id}?workspaceId=foreign-workspace`), 404);
  await json(await h.request(`/api/tasks/${a.id}/inputs`, { method: 'POST', body: { workspaceId: 'foreign-workspace', text: 'Wrong workspace', requestId: 'foreign-input' } }), 404);
  await h.restart();
  assert.equal((await h.get(a.id)).task.output, finished.task.output);
  assert.equal((await h.create(body)).id, a.id);
  assert.equal(h.calls.length, 1, 'reopening the application must not rerun a completed task');
  const listed = await json(await h.request('/api/tasks?workspaceId=personal'));
  assert.equal(listed.tasks.filter(task => task.id === a.id).length, 1);
});

test('a waiting task accepts one durable input and resumes after an application restart', options, async t => {
  const seen = [];
  const taskModel = { configured: true, models: ['test-model'], step: async ({ messages }) => {
    seen.push(structuredClone(messages));
    return messages.some(message => message.role === 'user' && String(message.content).includes('Use the blue option'))
      ? done('Selected the blue option')
      : callTool('question-1', 'request_user_input', { question: 'Which option should I use?' });
  } };
  const h = await harness(t, { taskModel });
  await h.setup();
  const task = await h.create(taskRequest('waiting-task', 'Choose an option with me'));
  await h.wait(task.id, 'waiting_input');
  await h.restart();
  assert.equal((await h.get(task.id)).task.status, 'waiting_input');
  const responses = await Promise.all([h.input(task.id, 'Use the blue option', 'answer-once'), h.input(task.id, 'Use the blue option', 'answer-once')]);
  for (const response of responses) await json(response, 202);
  const completed = await h.wait(task.id);
  assert.equal(completed.task.output, 'Selected the blue option');
  await json(await h.input(task.id, 'Use the red option', 'answer-once'), 409);
  const latest = seen.at(-1);
  assert.equal(latest.filter(message => message.role === 'user' && String(message.content).includes('Use the blue option')).length, 1);
  assert.equal(seen.length, 2, 'a duplicate input must not cause a second continuation');
});

test('runtime configuration reports model readiness and no task is admitted without a configured model', options, async t => {
  const h = await harness(t, { taskModel: { configured: false, models: ['test-model'], step: () => { assert.fail('unconfigured model must not be called'); } } });
  await h.setup();
  const config = await json(await h.request('/api/agent-runtime?workspaceId=personal'));
  assert.equal(config.configured, false);
  assert.deepEqual(config.models, ['test-model']);
  await json(await h.request('/api/tasks', { method: 'POST', body: taskRequest('unconfigured', 'Cannot execute') }), 503);
  assert.deepEqual((await json(await h.request('/api/tasks?workspaceId=personal'))).tasks, []);
});

test('task API rejects forged lineage or unknown plugins instead of admitting wider authority', options, async t => {
  const h = await harness(t);
  await h.setup();
  for (const extra of [{ role: 'worker' }, { parentTaskId: 'forged-parent' }, { status: 'succeeded' }]) {
    await json(await h.request('/api/tasks', { method: 'POST', body: taskRequest('forged', 'Do not execute', extra) }), 400);
  }
  const response = await h.request('/api/tasks', { method: 'POST', body: taskRequest('unknown-plugin', 'Do not execute', { pluginIds: ['unknown-plugin'] }) });
  assert.ok([400, 422].includes(response.status), await response.text());
  assert.equal(h.calls.length, 0);
});

test('the real document plugin saves a worker deliverable through the app persistence callback once', options, async t => {
  let workerWrites = 0;
  const taskModel = { configured: true, models: ['test-model'], step: async ({ messages, tools }) => {
    const router = tools.some(definition => definition.function.name === 'delegate_task');
    if (router) {
      if (!messages.some(message => message.role === 'tool')) return callTool('create-writer', 'delegate_task', { task: 'Write a real workspace document', pluginIds: ['documents'] });
      if (messages.some(message => message.role === 'user' && String(message.content).includes('[Runtime event; source=child]'))) return done('The document is saved');
      return callTool('wait-writer', 'wait_for_tasks', {});
    }
    if (messages.some(message => message.role === 'tool')) return done('Saved document confirmed');
    workerWrites++;
    assert.ok(tools.some(definition => definition.function.name === 'task_save_document'));
    return callTool('save-document', 'task_save_document', { title: 'Actual task deliverable', content: '# Durable document\n\nExact test content.' });
  } };
  const h = await harness(t, { taskModel, taskPlugins: undefined, freeSearchDisabled: true, publicFetch: () => { assert.fail('This workflow must not make network requests'); } });
  await h.setup();
  const body = taskRequest('real-document', 'Create a document through a worker', { pluginIds: ['documents'] });
  const task = await h.create(body);
  const completed = await h.wait(task.id);
  assert.equal(completed.children.length, 1);
  assert.equal(completed.children[0].status, 'succeeded');
  const state = await json(await h.request('/api/state'));
  const artifacts = state.state.workspaces[0].data.artifacts;
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].title, 'Actual task deliverable');
  assert.equal(artifacts[0].content, '# Durable document\n\nExact test content.');
  assert.equal(artifacts[0].kind, 'Document');
  await h.restart();
  assert.equal((await h.create(body)).id, task.id);
  assert.equal((await json(await h.request('/api/state'))).state.workspaces[0].data.artifacts.length, 1);
  assert.equal(workerWrites, 1);
});
