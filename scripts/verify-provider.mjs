// Explicit live smoke test. Never touches the owner's database or prints credentials.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadLocalEnv } from './env.mjs';
import { createApp } from '../server/app.mjs';
import { emptyState } from '../server/validation.mjs';
import { parseSSE } from '../server/llm.mjs';

if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--confirm') {
  console.log('Usage: node scripts/verify-provider.mjs --confirm');
  console.log('Makes two small paid DeepSeek requests: connection probe and streamed reply. Uses a temporary database, never your workspace.');
  process.exit(2);
}
loadLocalEnv();
const apiKey = process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
if (!apiKey?.trim()) { console.error('DEEPSEEK_API_KEY is not configured in the server environment or private .env.'); process.exit(1); }
let app, dir, stage = 'initialize';
try {
  dir = await mkdtemp(path.join(tmpdir(), 'hyperagents-live-'));
  app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', deepseekApiKey: apiKey });
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`;
  let cookie, csrf;
  const call = (route, options = {}) => fetch(base + route, { ...options, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const setup = await call('/api/setup', { method: 'POST', body: { password: randomBytes(24).toString('hex') } });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrfToken;
  stage = 'provider-probe';
  const probe = await (await call('/api/llm/test', { method: 'POST', body: { model: 'deepseek-flash', confirmed: true } })).json();
  if (probe.status !== 'verified') throw Error('Provider test: ' + (probe.code || 'failed'));
  console.log(`PASS real provider authorization and completion (${probe.latencyMs} ms)`);
  const current = await (await call('/api/state')).json(), state = emptyState();
  const thread = { id: 'live-smoke-thread', title: 'Temporary live smoke test', summary: '', time: '', messages: [{ id: 'live-user', role: 'user', text: 'Reply with exactly HYPERAGENTS_E2E_OK. Do not add anything else.', context: { settings: { model: 'deepseek-flash', reasoning: 'Low', provider: 'DeepSeek', mode: 'Execute', tools: [] } } }] };
  state.workspaces[0].data.threads.push(thread);
  async function save(revision) {
    const response = await call('/api/state', { method: 'PUT', headers: { 'If-Match': String(revision) }, body: { state } });
    assert.equal(response.status, 200); return (await response.json()).revision;
  }
  stage = 'save-user-message';
  const revision = await save(current.revision);
  stage = 'real-stream';
  const response = await call('/api/llm/chat', { method: 'POST', body: { workspaceId: 'personal', threadId: thread.id, userMessageId: 'live-user' } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  let text = '', done = false, deltas = 0;
  for await (const frame of parseSSE(response.body.getReader(), new AbortController().signal)) {
    const event = JSON.parse(frame);
    if (event.type === 'delta') { text += event.text; deltas++; }
    if (event.type === 'error') throw Error('Stream returned a sanitized provider error.');
    if (event.type === 'done') done = true;
  }
  assert.ok(done && deltas > 0 && text.includes('HYPERAGENTS_E2E_OK'));
  console.log('PASS authenticated real SSE stream and completion marker');
  stage = 'save-answer';
  thread.messages.push({ id: 'live-assistant', role: 'assistant', text });
  await save(revision);
  const reloaded = await (await call('/api/state')).json();
  assert.equal(reloaded.state.workspaces[0].data.threads[0].messages[1].text, text);
  console.log('PASS revision-checked answer save and SQLite reload');
  stage = 'restart-persistence';
  await app.close(); app = undefined;
  app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const restarted = await app.listen(), restartBase = `http://127.0.0.1:${restarted.port}`;
  // Existing owner session and stored answer must survive a server restart.
  const persisted = await fetch(restartBase + '/api/state', { headers: { Cookie: cookie, Origin: restartBase } });
  assert.equal(persisted.status, 200);
  assert.equal((await persisted.json()).state.workspaces[0].data.threads[0].messages[1].text, text);
  console.log('PASS stored answer survives backend restart; owner workspace untouched');
} catch (error) {
  // Do not print exceptions or provider bodies: they may contain sensitive transport data.
  console.error('Live verification failed at ' + stage + '. Use the signed-in Connection diagnostics panel to inspect the sanitized provider status. No owner data was modified.');
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}
