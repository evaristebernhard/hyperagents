import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLlm } from './llm.mjs';
import { buildCapabilityManifest } from './capability-authority.mjs';
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
const reply = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const call = (name, args) => reply({ tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function snapshot(tools) { return { workspaces: [{ id: 'w', data: { threads: [{ id: 't', title: 'Batch two', messages: [{ id: 'm', role: 'user', text: 'Perform task', context: { settings: { tools, mode: 'Execute' } } }] }], projects: [], skills: [], memories: [], artifacts: [], connections: [] } }] }; }
async function run(state, extra) {
  const llm = createLlm({ apiKey: 'fake-model-key', load: () => ({ state }), ...extra });
  const req = new EventEmitter(), res = new EventEmitter(); let text = '';
  res.headersSent = false; res.destroyed = false; res.writeHead = () => res.headersSent = true; res.write = s => { text += s; return true; }; res.end = s => text += s || '';
  await llm.chat(req, res, { workspaceId: 'w', threadId: 't', userMessageId: 'm' });
  return text.split('\n\n').filter(Boolean).map(s => JSON.parse(s.slice(6)));
}
test('Slides tool routes structured content to an actual Slides patch, not a Webpage', async () => {
  let rounds = 0;
  const events = await run(snapshot(['Slides']), { fetchImpl: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (++rounds === 1) { assert.ok(body.tools.some(d => d.function.name === 'publish_slides')); return call('publish_slides', { title: 'Deck', slides: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }] }); }
    assert.equal(JSON.parse(body.messages.at(-1).content).kind, 'Slides'); return reply({ content: 'Deck prepared.' });
  } });
  const patch = events.find(e => e.type === 'artifact')?.patch;
  assert.equal(patch?.artifact.kind, 'Slides'); assert.equal(JSON.parse(patch.artifact.content).slides.length, 2);
  assert.ok(events.some(e => e.type === 'done')); assert.ok(!events.some(e => e.type === 'error'));
});
test('Exa config, binding, authenticated transport and source results remain separate from model secrets', async () => {
  const secret = 'fake-exa-key-for-test'; let rounds = 0, requests = 0;
  const events = await run(snapshot(['Search']), { exaApiKey: secret,
    exaFetch: async (url, opts) => { requests++; assert.equal(url, 'https://api.exa.ai/search'); assert.equal(opts.headers['x-api-key'], secret); return new Response(JSON.stringify({ results: [{ title: 'Source', url: 'https://exa.ai/docs', highlights: ['Evidence'] }] }), { headers: { 'Content-Type': 'application/json' } }); },
    fetchImpl: async (_url, opts) => {
      assert.ok(!opts.body.includes(secret));
      if (++rounds === 1) { assert.ok(JSON.parse(opts.body).tools.some(d => d.function.name === 'exa_search')); return call('exa_search', { query: 'agent tools' }); }
      const result = JSON.parse(JSON.parse(opts.body).messages.at(-1).content); assert.equal(result.results[0].url, 'https://exa.ai/docs'); return reply({ content: 'Found source.' });
    },
  });
  assert.equal(requests, 1); assert.ok(events.some(e => e.type === 'done')); assert.ok(!JSON.stringify(events).includes(secret));
  const manifest = buildCapabilityManifest({ enabled: ['Search'], moliPath: '/missing/browser', exaApiKey: undefined });
  assert.equal(manifest.capabilities.find(c => c.label === 'Search').executable, false);
});
