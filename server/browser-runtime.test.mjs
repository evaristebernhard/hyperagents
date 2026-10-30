import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTools, normalizeBrowserUrl } from './browser-runtime.mjs';
const availability = { configured: true, provider: 'moli' };
const driver = (extra = {}) => ({ close: async () => {}, navigate: async url => ({ status: 'succeeded', url }), observe: async () => ({ text: 'Example' }), content: async () => ({ content: 'Example' }), extract: async () => ({ rows: [{ name: 'Example' }] }), screenshot: async () => Buffer.from('PNG'), ...extra });
test('browser tools expose only explicitly selected DOM subset and reject local targets', async () => {
  assert.equal(createBrowserTools({ enabled: [], availability }).definitions.length, 0);
  const tools = createBrowserTools({ enabled: ['Browser'], availability });
  assert.ok(tools.definitions.some(d => d.function.name === 'browser_navigate'));
  assert.ok(!tools.definitions.some(d => /click|login|evaluate|screenshot/.test(d.function.name)));
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.com', 'file:///etc/passwd', 'https://example.internal']) assert.throws(() => normalizeBrowserUrl(url));
  assert.equal(normalizeBrowserUrl('https://example.com/a'), 'https://example.com/a');
});
test('session handles are run-local and close is idempotent', async () => {
  let closes = 0;
  const a = createBrowserTools({ enabled: ['Browser'], availability, driverFactory: async () => driver({ close: async () => closes++ }) });
  const b = createBrowserTools({ enabled: ['Browser'], availability, driverFactory: async () => driver() });
  const session = await a.execute('browser_session', { action: 'create' });
  assert.equal((await a.execute('browser_navigate', { sessionId: session.sessionId, url: 'https://example.com' })).provider, 'moli');
  await assert.rejects(b.execute('browser_get_content', { sessionId: session.sessionId }), /not found in this run/);
  await a.close(); await a.close(); assert.equal(closes, 1);
  await assert.rejects(a.execute('browser_observe', { sessionId: session.sessionId }), /not found/);
});
test('screenshot returns only the real persistence result and extraction rejects unsafe fields', async () => {
  const saved = { id: 'file-test', workspaceId: 'w', mimeType: 'image/png' };
  const tools = createBrowserTools({ enabled: ['Browser'], availability, driverFactory: async () => driver(), persistFile: async input => { assert.equal(input.mimeType, 'image/png'); assert.equal(input.bytes.toString(), 'PNG'); return saved; } });
  const { sessionId } = await tools.execute('browser_session', { action: 'create' });
  const result = await tools.execute('browser_screenshot', { sessionId }); assert.deepEqual(result.file, saved);
  await assert.rejects(tools.execute('browser_extract', { sessionId, fields: [{ name: 'constructor', selector: 'h1' }] }), /safe/);
  await tools.close();
});
test('per-session operations are ordered and cancelled calls cannot start work', async () => {
  const order = [];
  const tools = createBrowserTools({ enabled: ['Browser'], availability, driverFactory: async () => driver({ navigate: async () => { order.push('navigate'); return {}; }, observe: async () => { order.push('observe'); return {}; } }) });
  const { sessionId } = await tools.execute('browser_session', { action: 'create' });
  await Promise.all([tools.execute('browser_navigate', { sessionId, url: 'https://example.com' }), tools.execute('browser_observe', { sessionId })]);
  assert.deepEqual(order, ['navigate', 'observe']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.execute('browser_navigate', { sessionId, url: 'https://example.com' }, controller.signal), /cancelled/);
  assert.equal(order.length, 2); await tools.close();
});
