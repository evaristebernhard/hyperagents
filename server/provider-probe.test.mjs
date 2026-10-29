import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';
import { createProviderProbe } from './provider-probe.mjs';
const request = { model: 'deepseek-flash', confirmed: true };
const success = () => Response.json({ choices: [{ message: { content: 'OK' } }] });
const key = 'unit-test-secret-never-return';

test('provider probe requires configured key, explicit confirmation and allowlisted model', async () => {
  let calls = 0;
  const probe = createProviderProbe({ apiKey: key, fetchImpl: () => { calls++; return success(); } });
  for (const body of [null, [], {}, { ...request, confirmed: false }, { ...request, apiKey: 'client-key' }]) await assert.rejects(probe(body), e => e.status === 400);
  await assert.rejects(probe({ ...request, model: 'arbitrary-model' }), e => e.status === 422);
  await assert.rejects(createProviderProbe({ fetchImpl: success })(request), e => e.status === 503);
  assert.equal(calls, 0);
});

test('fixed small non-streaming request, sanitized result and per-model cooldown', async () => {
  let calls = 0, now = Date.now();
  const probe = createProviderProbe({ apiKey: key, clock: () => now, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const body = JSON.parse(init.body); assert.equal(body.max_tokens, 16); assert.equal(body.stream, false);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.messages.length, 1);
    return Response.json({ choices: [{ message: { content: 'provider private body ' + key } }], sensitive: key });
  } });
  assert.equal((await probe(request)).status, 'verified');
  const cached = await probe(request); assert.equal(cached.cached, true); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(cached), /unit-test-secret|provider private|sensitive/);
  await probe({ ...request, model: 'deepseek-v4-pro' }); assert.equal(calls, 2);
  now += 30001; assert.equal((await probe(request)).cached, false); assert.equal(calls, 3);
});

for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'AUTH_REJECTED'], [402, 'INSUFFICIENT_BALANCE'], [429, 'RATE_LIMITED'], [400, 'MODEL_UNAVAILABLE'], [404, 'MODEL_UNAVAILABLE'], [422, 'MODEL_UNAVAILABLE'], [500, 'PROVIDER_ERROR']]) {
  test(`sanitizes provider HTTP ${status}`, async () => {
    const probe = createProviderProbe({ apiKey: key, fetchImpl: async () => new Response('private ' + key, { status }) });
    const result = await probe(request); assert.equal(result.code, code); assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes(key));
  });
}

test('invalid, missing, oversized and thrown provider responses are safe failures', async () => {
  for (const fetchImpl of [async () => new Response('<html>login</html>'), async () => Response.json({}), async () => Response.json({ choices: [{ message: { content: '' } }] }), async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }), async () => { throw Error(key); }]) {
    const result = await createProviderProbe({ apiKey: key, fetchImpl })(request);
    assert.equal(result.code, 'CONNECTION_ERROR'); assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('deadline covers both stalled fetch and stalled response body; concurrent tests blocked', async () => {
  // Keep the test process alive while the production timeout uses unref.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
      const probe = createProviderProbe({ apiKey: key, timeoutMs: 25, fetchImpl });
      const first = probe(request);
      await assert.rejects(probe({ ...request, model: 'deepseek-v4-pro' }), e => e.status === 409);
      assert.equal((await first).code, 'TIMEOUT');
    }
  } finally { clearInterval(keepAlive); }
});

test('diagnostics and paid test enforce session, Origin, CSRF, exact body and rate limit; database unchanged', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-probe-'));
  let calls = 0;
  const app = await createApp({ dataDir: dir, port: 0, deepseekApiKey: key, llmProbeFetch: async () => { calls++; return success(); } });
  const addr = await app.listen(), base = `http://127.0.0.1:${addr.port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  let cookie, csrf;
  const call = (route, options = {}) => fetch(base + route, { ...options, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  assert.equal((await call('/api/diagnostics')).status, 401);
  assert.equal((await call('/api/llm/test', { method: 'POST', body: request })).status, 401);
  const setup = await call('/api/setup', { method: 'POST', body: { password: 'local-probe-testing-password' } });
  cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrfToken;
  const before = await (await call('/api/state')).json();
  const diagnostics = await (await call('/api/diagnostics')).json();
  assert.equal(diagnostics.database.status, 'ready'); assert.equal(diagnostics.database.revision, before.revision); assert.equal(diagnostics.provider.configured, true); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(diagnostics), /unit-test-secret|workspace.sqlite|workspaces|password/);
  assert.equal((await call('/api/llm/test', { method: 'POST', body: request, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/llm/test', { method: 'POST', body: request, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await (await call('/api/llm/test', { method: 'POST', body: request })).json()).status, 'verified');
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/llm/test', { method: 'POST', body: request })).status, 200);
  assert.equal((await call('/api/llm/test', { method: 'POST', body: request })).status, 429);
  assert.equal(calls, 1); assert.deepEqual(await (await call('/api/state')).json(), before);
});
