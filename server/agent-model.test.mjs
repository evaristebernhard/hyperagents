import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentModel, AGENT_MODEL_LIMITS } from './agent-model.mjs';

const definition = { type: 'function', function: { name: 'lookup', description: 'Look up one fact.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['query'], additionalProperties: false } } };
const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'hello' }];
const delta = (value, finish_reason = null) => ({ choices: [{ index: 0, delta: value, finish_reason }] });
function response(events, { done = true, split = false } = {}) {
  const encoded = new TextEncoder().encode(events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) { if (split) for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7)); else controller.enqueue(encoded); controller.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const adapter = events => createAgentModel({ apiKey: 'test-key', fetchImpl: async () => response(events) });
const toolTurn = (args, extra = {}) => [delta({ tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name: 'lookup', arguments: args }, ...extra }] }), delta({}, 'tool_calls')];

test('streams visible text only and retains private reasoning for the next provider turn', async () => {
  const sent = [], visible = [];
  const model = createAgentModel({ apiKey: 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    sent.push(JSON.parse(init.body));
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return response([delta({ reasoning_content: 'private scratchpad' }), delta({ content: '你好' }), delta({ content: '！' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, secret: 'no' } }], { split: true });
  } });
  const result = await model.step({ messages, onDelta: text => visible.push(text) });
  assert.deepEqual(visible, ['你好', '！']);
  assert.equal(result.text, '你好！');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.assistantMessage.reasoning_content, 'private scratchpad');
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
  await model.step({ messages: [...messages, result.assistantMessage, { role: 'user', content: 'continue' }] });
  assert.equal(sent[1].messages[2].reasoning_content, 'private scratchpad');
  assert.equal(sent[0].thinking.type, 'enabled');
  assert.equal(sent[0].stream, true);
  assert.ok(!JSON.stringify(visible).includes('scratchpad'));
});

test('reassembles interleaved streamed calls and validates JSON objects against supplied schemas', async () => {
  const model = adapter([
    delta({ reasoning_content: 'reason' }),
    delta({ tool_calls: [{ index: 1, id: 'call_two', type: 'function', function: { name: 'look', arguments: '{"query":' } }, { index: 0, id: 'call_', type: 'function', function: { name: 'lookup', arguments: '{"query":"first' } }] }),
    delta({ tool_calls: [{ index: 0, id: 'one', function: { arguments: '"}' } }, { index: 1, function: { name: 'up', arguments: '"second"}' } }] }),
    delta({}, 'tool_calls'),
  ]);
  const result = await model.step({ messages, tools: [definition] });
  assert.deepEqual(result.toolCalls, [{ id: 'call_one', name: 'lookup', arguments: { query: 'first' } }, { id: 'call_two', name: 'lookup', arguments: { query: 'second' } }]);
  assert.equal(result.assistantMessage.content, null);
  assert.equal(result.assistantMessage.reasoning_content, 'reason');
  assert.equal(result.assistantMessage.tool_calls[0].function.arguments, '{"query":"first"}');
});

test('malformed, non-object, extra-field and prototype tool arguments fail without retry', async () => {
  for (const args of ['{', '[]', 'null', '{"query":1}', '{"query":"x","url":"https://evil.test"}', '{"query":"x","__proto__":{}}']) {
    let requests = 0;
    const model = createAgentModel({ apiKey: 'test-key', fetchImpl: async () => { requests++; return response(toolTurn(args)); } });
    await assert.rejects(model.step({ messages, tools: [definition] }), /argument/i);
    assert.equal(requests, 1);
  }
});

test('unknown tools, duplicate call IDs, unexpected tool output and truncated turns are rejected', async () => {
  const badCases = [
    toolTurn('{"query":"x"}', { function: { name: 'not_registered', arguments: '{}' } }),
    [delta({ tool_calls: [0, 1].map(index => ({ index, id: 'duplicate', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } })) }), delta({}, 'tool_calls')],
    [delta({ tool_calls: [{ index: 8, id: 'call_bad', function: { name: 'lookup', arguments: '{}' } }] }), delta({}, 'tool_calls')],
    [delta({ content: 'partial' }, 'length')],
    [delta({ content: 'partial' })],
  ];
  for (const events of badCases) await assert.rejects(adapter(events).step({ messages, tools: [definition] }));
  await assert.rejects(adapter(toolTurn('{"query":"x"}')).step({ messages }), /Unexpected/);
  await assert.rejects(createAgentModel({ apiKey: 'test-key', fetchImpl: async () => response([delta({ content: 'partial' }, 'stop')], { done: false }) }).step({ messages }), /complete turn/);
});

test('text, reasoning and tool argument deltas share one output byte budget', async () => {
  const events = Array.from({ length: 32 }, () => delta({ reasoning_content: 'r'.repeat(8192) }));
  events.push(delta({ content: 'extra' }, 'stop'));
  assert.equal(32 * 8192, AGENT_MODEL_LIMITS.outputBytes);
  await assert.rejects(adapter(events).step({ messages }), /byte limit/);
});

test('invalid model, missing credentials and oversized request fail before transport', async () => {
  let requests = 0;
  const model = createAgentModel({ apiKey: 'test-key', fetchImpl: async () => { requests++; throw Error('unexpected'); } });
  await assert.rejects(model.step({ model: 'other-provider', messages }), /Unsupported/);
  await assert.rejects(model.step({ messages: [] }), /messages/);
  await assert.rejects(model.step({ messages: [{ role: 'user', content: 'x'.repeat(AGENT_MODEL_LIMITS.requestBytes) }] }), /byte limit/);
  await assert.rejects(createAgentModel().step({ messages }), { code: 'LLM_NOT_CONFIGURED' });
  assert.equal(requests, 0);
});

test('transport failures are sanitized and cancellation interrupts a stalled reader', async () => {
  const bad = createAgentModel({ apiKey: 'super-secret', fetchImpl: async () => { throw Error('super-secret in transport'); } });
  await assert.rejects(bad.step({ messages }), error => error.code === 'AGENT_MODEL_UPSTREAM' && !error.message.includes('super-secret'));
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const slow = createAgentModel({ apiKey: 'test-key', fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = slow.step({ messages, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' });
  assert.equal(cancelled, true);
});
