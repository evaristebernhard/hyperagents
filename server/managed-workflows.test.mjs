import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.mjs';
import { emptyState } from './validation.mjs';
const scope = { workspaceId: 'personal', threadId: 'root' };
const frame = v => 'data: ' + JSON.stringify(v) + '\n\n';
const response = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const tool = (name, args, id = 'call_test') => response({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function harness(t, tools, factory) {
  const dir = await mkdtemp(path.join(tmpdir(), 'managed-workflows-')), dataDir = path.join(dir, 'data'), shellRoot = path.join(dir, 'scripts'); await mkdir(shellRoot);
  const extra = await factory({ dir, dataDir, shellRoot });
  const app = await createApp({ dataDir, shellRoot, port: 0, runConcurrency: 1, deepseekApiKey: 'synthetic-model-key', ...extra });
  const base = 'http://127.0.0.1:' + (await app.listen()).port;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  let cookie, csrf;
  async function call(url, method = 'GET', body, extraHeaders = {}) {
    const res = await fetch(base + url, { method, headers: { Origin: base, ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return res;
  }
  async function json(res, status = 200) { const text = await res.text(); assert.equal(res.status, status, text); return JSON.parse(text); }
  const setup = await call('/api/setup', 'POST', { password: 'local-test-password-only' }); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await json(setup)).csrfToken;
  const state = emptyState(), settings = { model: 'deepseek-flash', provider: 'DeepSeek', reasoning: 'Low', mode: 'Execute', tools };
  state.workspaces[0].data.threads.push({ id: 'root', title: 'Root task', summary: '', time: '', config: settings, messages: [{ id: 'message', role: 'user', text: 'Execute a bounded task', context: { settings } }] });
  if (extra.agents) state.workspaces[0].data.agents.push(...extra.agents);
  const current = await json(await call('/api/state'));
  await json(await call('/api/state', 'PUT', { state }, { 'If-Match': String(current.revision) }));
  const run = (await json(await call('/api/runs', 'POST', { ...scope, userMessageId: 'message' }), 202)).run;
  const query = new URLSearchParams(scope);
  const get = async () => (await json(await call('/api/runs/' + run.id + '?' + query))).run;
  async function wait(status) { const until = Date.now() + 7000; let value; do { value = await get(); if (value.status === status) return value; if (['failed', 'interrupted', 'cancelled'].includes(value.status)) assert.fail(JSON.stringify(value)); await delay(10); } while (Date.now() < until); assert.fail('Run did not reach ' + status + ': ' + JSON.stringify(value)); }
  const decide = async (actionId, decision) => json(await call('/api/runs/' + run.id + '/approvals/' + actionId, 'POST', { ...scope, decision }));
  return { dir, dataDir, shellRoot, run, call, json, wait, decide };
}

test('managed Files wait for real approval, persist private scratch and attach a real export download', async t => {
  let round = 0;
  const h = await harness(t, ['Files'], async () => ({ llmFetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (++round === 1) return tool('write_file', { path: 'notes.txt', content: 'hello workspace', createExclusive: true });
    if (round === 2) { assert.ok(JSON.parse(body.messages.at(-1).content).sha256); return tool('export_file', { path: 'notes.txt' }, 'export'); }
    assert.ok(JSON.parse(body.messages.at(-1).content).file.id.startsWith('file-')); return response({ content: 'File saved and exported.' });
  } }));
  const waiting = await h.wait('waiting_approval'); assert.equal(waiting.approvals[0].kind, 'file');
  const target = path.join(h.dataDir, 'agent-files/personal/notes.txt'); assert.equal(existsSync(target), false);
  assert.match(waiting.approvals[0].command, /hello workspace/);
  await h.decide(waiting.approvals[0].id, 'approve');
  const done = await h.wait('succeeded'); assert.equal(done.resultSaved, true); assert.equal(done.approvals[0].status, 'completed');
  assert.equal(await readFile(target, 'utf8'), 'hello workspace');
  const saved = await h.json(await h.call('/api/state')), messages = saved.state.workspaces[0].data.threads.find(x => x.id === 'root').messages;
  const file = messages.at(-1).context.attachments[0]; assert.equal(file.workspaceId, 'personal'); assert.equal(file.mimeType, 'text/plain');
  const download = await h.call('/api/files/' + file.id + '?workspaceId=personal'); assert.equal(download.status, 200); assert.equal(await download.text(), 'hello workspace');
});

test('managed Skills use the same durable approval and resolve credentials only after approval', async t => {
  let round = 0, credentialReads = 0; const secret = 'synthetic-secret-value-never-log';
  const h = await harness(t, ['Skills'], async ({ shellRoot }) => {
    await writeFile(path.join(shellRoot, 'runner.mjs'), "console.log('result '+process.env.APP_TEST_CREDENTIAL)");
    return { skillRoot: shellRoot, skillCatalog: [{ id: 'safe-test', version: '1', entrypoints: { run: { interpreter: process.execPath, script: 'runner.mjs', args: [], inputArgs: { minItems: 0, maxItems: 0, maxLength: 100 }, credentials: [{ id: 'key', env: 'APP_TEST_CREDENTIAL' }], timeoutSeconds: 3 } } }],
      skillCredentialProvider: async () => { credentialReads++; return { key: secret }; },
      llmFetch: async (_url, init) => {
        assert.ok(!init.body.includes(secret));
        if (++round === 1) return tool('run_skill_script', { skillId: 'safe-test', entrypoint: 'run', args: [] });
        const result = JSON.parse(JSON.parse(init.body).messages.at(-1).content); assert.equal(result.status, 'succeeded'); assert.match(result.stdout, /\[redacted\]/); return response({ content: 'Script complete.' });
      },
    };
  });
  const waiting = await h.wait('waiting_approval'); assert.equal(waiting.approvals[0].kind, 'skill'); assert.equal(credentialReads, 0); assert.ok(!JSON.stringify(waiting).includes(secret));
  await h.decide(waiting.approvals[0].id, 'approve');
  const done = await h.wait('succeeded'); assert.equal(done.resultSaved, true); assert.equal(done.approvals[0].status, 'completed'); assert.equal(credentialReads, 1);
});

test('actual app delegation saves an isolated child thread, enforces read-only tools and returns its real result', async t => {
  let rootRound = 0, childRound = 0;
  const h = await harness(t, ['Delegation', 'Thread Search', 'Files'], async () => ({ agents: [{ id: 'reader', name: 'Reader-only agent', description: 'Read-only synthetic worker', prompt: 'Return the supplied task fact.', tools: ['Thread Search', 'Shell', 'Files', 'Delegation'] }],
    llmFetch: async (_url, init) => {
      const body = JSON.parse(init.body), names = (body.tools || []).map(d => d.function.name);
      if (body.messages[0].content.includes('Reader-only agent')) {
        assert.ok(!names.some(n => ['write_file', 'shell_execute', 'create_artifact', 'delegate_agent'].includes(n)));
        if (++childRound === 1) return tool('create_artifact', { title: 'Forbidden', kind: 'Document', content: 'not allowed' }, 'bad_child');
        assert.match(JSON.parse(body.messages.at(-1).content).error, /not enabled/);
        return response({ content: 'Verified child fact.' });
      }
      if (++rootRound === 1) return tool('delegate_agent', { agentId: 'reader', task: 'Return exactly: Verified child fact.' });
      if (rootRound === 2) return tool('wait_for_delegated_run', { runId: JSON.parse(body.messages.at(-1).content).runId, timeoutSeconds: 5 }, 'wait_child');
      const result = JSON.parse(body.messages.at(-1).content); assert.equal(result.status, 'succeeded'); assert.equal(result.resultSaved, true); assert.match(result.text, /Verified child fact/); return response({ content: 'Parent received the real child result.' });
    },
  }));
  const done = await h.wait('succeeded'); assert.equal(done.resultSaved, true); assert.equal(done.childCount, 1); assert.equal(childRound, 2);
  const saved = await h.json(await h.call('/api/state')), w = saved.state.workspaces[0].data;
  const child = w.threads.find(x => x.id !== 'root'); assert.ok(child); assert.deepEqual(child.config.tools, ['Thread Search']); assert.equal(child.messages[0].context.settings.agentId, 'reader'); assert.equal(child.messages[0].text, 'Return exactly: Verified child fact.'); assert.equal(child.messages.at(-1).text, 'Verified child fact.'); assert.equal(w.artifacts.length, 0);
});
