import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLlm } from './llm.mjs';
const frame = v => 'data: ' + JSON.stringify(v) + '\n\n';
const response = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const call = (name, args, id) => response({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
test('LLM loop discovers and executes browser tools and releases the session after completion', async () => {
  let round = 0, closed = 0, visits = 0;
  const state = { workspaces: [{ id: 'w', data: { threads: [{ id: 't', messages: [{ id: 'm', role: 'user', text: 'Read example.com', context: { settings: { mode: 'Execute', tools: ['Browser'] } } }] }], projects: [], skills: [], memories: [], artifacts: [], connections: [] } }] };
  const llm = createLlm({ apiKey: 'test-only', load: () => ({ state }), browserOptions: { availability: { configured: true }, driverFactory: async () => ({ close: async () => closed++, navigate: async url => { visits++; return { status: 'succeeded', url }; } }) }, fetchImpl: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (++round === 1) { assert.ok(body.tools.some(t => t.function.name === 'browser_session')); assert.ok(body.tools.some(t => t.function.name === 'tool_catalog')); return call('browser_session', { action: 'create' }, 'create'); }
    if (round === 2) return call('browser_navigate', { sessionId: JSON.parse(body.messages.at(-1).content).sessionId, url: 'https://example.com' }, 'navigate');
    assert.equal(JSON.parse(body.messages.at(-1).content).provider, 'moli'); return response({ content: 'Read complete.' });
  } });
  const req = new EventEmitter(), res = new EventEmitter(); let text = '';
  res.headersSent = false; res.destroyed = false; res.writeHead = () => res.headersSent = true; res.write = s => { text += s; return true; }; res.end = s => text += s || '';
  await llm.chat(req, res, { workspaceId: 'w', threadId: 't', userMessageId: 'm' });
  const events = text.split('\n\n').filter(Boolean).map(s => JSON.parse(s.slice(6)));
  assert.equal(visits, 1); assert.equal(closed, 1);
  assert.ok(events.some(e => e.type === 'tool_trace' && e.source === 'browser' && e.outcome === 'completed'));
  assert.ok(events.some(e => e.type === 'done'));
});

test('table export is wired to workspace-scoped file persistence with real metadata', async () => {
  let round = 0, saved = false;
  const timestamp = '2026-10-30T15:00:00.000Z';
  const state = { workspaces: [{ id: 'w', data: { threads: [{ id: 't', messages: [{ id: 'm', role: 'user', text: 'Export table', context: { settings: { tools: ['Tables'] } } }] }], projects: [], skills: [], memories: [], artifacts: [{ id: 'a', threadId: 't', title: 'Table', kind: 'Table', content: JSON.stringify({ columns: ['名称'], rows: [['中文']] }), createdAt: timestamp, updatedAt: timestamp, versions: [] }], connections: [] } }] };
  const llm = createLlm({ apiKey: 'test-only', load: () => ({ state }), persistVisual: async input => {
    assert.equal(input.workspaceId, 'w'); assert.equal(input.mimeType, 'text/csv'); assert.equal(input.bytes.toString('utf8'), '名称\r\n中文\r\n');
    saved = true; return { type: 'file', id: 'file-actual', name: input.filename, size: input.bytes.length, mimeType: input.mimeType, workspaceId: 'w', createdAt: timestamp };
  }, fetchImpl: async (_url, opts) => {
    if (++round === 1) return call('export_table', { id: 'a', format: 'csv' }, 'export');
    const result = JSON.parse(JSON.parse(opts.body).messages.at(-1).content);
    assert.equal(result.file.createdAt, timestamp); assert.equal(result.file.mimeType, 'text/csv'); assert.equal(result.file.workspaceId, 'w');
    return response({ content: 'Export saved.' });
  } });
  const req = new EventEmitter(), res = new EventEmitter(); let text = '';
  res.headersSent = false; res.destroyed = false; res.writeHead = () => res.headersSent = true; res.write = s => { text += s; return true; }; res.end = s => text += s || '';
  await llm.chat(req, res, { workspaceId: 'w', threadId: 't', userMessageId: 'm' });
  assert.equal(saved, true); assert.ok(text.includes('"type":"done"')); assert.ok(!text.includes('"type":"error"'));
});
