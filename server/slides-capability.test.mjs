import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLlm } from './llm.mjs';
const frame = v => 'data: ' + JSON.stringify(v) + '\n\n';
const response = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const call = (name, args) => response({ tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function state(tools) { return { workspaces: [{ id: 'w', data: { threads: [{ id: 't', title: 'Slides test', messages: [{ id: 'm', role: 'user', text: 'Please call publish_slides for project X.', context: { settings: { tools, outputFormat: 'Slides', mode: 'Execute' } } }] }], projects: [], skills: [], memories: [], artifacts: [], connections: [] } }] }; }
async function run(snapshot, fetchImpl) {
  const llm = createLlm({ apiKey: 'fake-model-key', load: () => ({ state: snapshot }), fetchImpl });
  const req = new EventEmitter(), res = new EventEmitter(); let text = '';
  res.headersSent = false; res.destroyed = false; res.writeHead = () => res.headersSent = true; res.write = s => { text += s; return true; }; res.end = s => text += s || '';
  await llm.chat(req, res, { workspaceId: 'w', threadId: 't', userMessageId: 'm' });
  return text.split('\n\n').filter(Boolean).map(s => JSON.parse(s.slice(6)));
}
test('Slides format never grants a disabled tool and refuses Webpage substitution', async () => {
  let round = 0;
  const events = await run(state(['Thread Search', 'Documents', 'Webpages', 'Tables']), async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(!body.tools.some(d => d.function.name === 'publish_slides'));
    assert.ok(body.messages[0].content.includes('Slides is NOT enabled'));
    assert.ok(body.messages[0].content.includes('Do not silently substitute'));
    if (++round === 1) return call('create_artifact', { title: 'Fake deck', kind: 'Webpage', content: '<html>Not Slides</html>' });
    assert.match(JSON.parse(body.messages.at(-1).content).error, /Slides output requires publish_slides/);
    return response({ content: 'Enable Slides and send a new message.' });
  });
  assert.ok(!events.some(e => e.type === 'artifact'));
  assert.ok(events.some(e => e.type === 'tool' && e.status === 'error'));
  assert.ok(events.some(e => e.type === 'done'));
});
test('explicitly enabled Slides format routes to a genuine Slides artifact', async () => {
  let round = 0;
  const events = await run(state(['Slides']), async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (++round === 1) { assert.ok(body.tools.some(d => d.function.name === 'publish_slides')); return call('publish_slides', { title: 'X', slides: [{ title: 'Overview', body: 'User supplied facts' }] }); }
    assert.equal(JSON.parse(body.messages.at(-1).content).kind, 'Slides');
    return response({ content: 'Slides prepared.' });
  });
  assert.equal(events.find(e => e.type === 'artifact')?.patch.artifact.kind, 'Slides');
});
