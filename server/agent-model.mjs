import { MODELS, parseSSE } from './llm.mjs';
import { createToolRegistry, validateToolArguments } from './tool-registry.mjs';
import { ApiError } from './validation.mjs';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const AGENT_MODEL_LIMITS = Object.freeze({ outputBytes: 256 * 1024, requestBytes: 2 * 1024 * 1024, toolCalls: 8, messages: 256, tools: 128 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (status, message, code = 'AGENT_MODEL') => { throw new ApiError(status, message, code); };

function jsonValue(value, depth = 0) {
  if (depth > 12) fail(422, 'Tool arguments are too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (!plain(value)) fail(422, 'Tool arguments must contain JSON values.');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(422, 'Invalid tool argument key.');
    jsonValue(item, depth + 1);
  }
}

function safeUsage(value) {
  if (!plain(value)) return undefined;
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : undefined;
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One provider turn, independent of HTTP responses and task scheduling.
 * onDelta receives visible text only. assistantMessage is PRIVATE provider history:
 * retain its reasoning_content for subsequent tool turns; never publish it to UI/events.
 * This adapter does not execute tools or retry malformed provider responses.
 */
export function createAgentModel({ apiKey, fetchImpl = globalThis.fetch, model = 'deepseek-flash' } = {}) {
  if (!MODELS.includes(model)) fail(422, 'Unsupported model.');
  const configured = typeof apiKey === 'string' && !!apiKey.trim() && typeof fetchImpl === 'function';
  return {
    configured,
    models: [...MODELS],
    async step({ model: selected = model, messages, tools = [], signal: callerSignal, onDelta } = {}) {
      if (!configured) fail(503, 'DeepSeek is not configured.', 'LLM_NOT_CONFIGURED');
      if (!MODELS.includes(selected)) fail(422, 'Unsupported model.');
      if (!Array.isArray(messages) || !messages.length || messages.length > AGENT_MODEL_LIMITS.messages || messages.some(message => !plain(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role))) fail(422, 'Invalid agent messages.');
      if (!Array.isArray(tools) || tools.length > AGENT_MODEL_LIMITS.tools) fail(422, 'Invalid agent tool definitions.');
      if (onDelta !== undefined && typeof onDelta !== 'function') fail(422, 'Invalid text callback.');
      if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) fail(422, 'Invalid cancellation signal.');
      // Reuse the same authored schema checks as the execution host.
      const definitions = createToolRegistry([{ source: 'managed', effect: 'orchestration', definitions: tools, execute() {} }], { catalog: false }).definitions();
      const schemas = new Map(definitions.map(definition => [definition.function.name, definition.function.parameters]));
      let body;
      try {
        body = JSON.stringify({ model: selected, messages, ...(definitions.length ? { tools: definitions } : {}), thinking: { type: 'enabled' }, reasoning_effort: 'high', stream: true, stream_options: { include_usage: true }, max_tokens: 8192 });
      } catch { fail(422, 'Agent messages must be serializable.'); }
      if (Buffer.byteLength(body) > AGENT_MODEL_LIMITS.requestBytes) fail(413, 'Agent context exceeds the request byte limit.');

      const signal = callerSignal ?? AbortSignal.timeout(120000);
      let reader, upstream, text = '', reasoning = '', outputBytes = 0, finished = false, finishReason, usage;
      const calls = new Map();
      const append = value => {
        if (typeof value !== 'string') fail(502, 'Invalid provider response.');
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > AGENT_MODEL_LIMITS.outputBytes) fail(502, 'Provider output exceeds the byte limit.');
        return value;
      };
      try {
        signal.throwIfAborted();
        upstream = await abortable(fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' }, body, signal }), signal);
        if (!upstream.ok || !upstream.body || !/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') || '')) fail(502, 'DeepSeek did not return a valid event stream.');
        reader = upstream.body.getReader();
        for await (const data of parseSSE(reader, signal)) {
          if (data === '[DONE]') { finished = true; break; }
          let chunk;
          try { chunk = JSON.parse(data); } catch { fail(502, 'Invalid provider event JSON.'); }
          if (!plain(chunk) || chunk.error || !Array.isArray(chunk.choices) || chunk.choices.length > 1) fail(502, 'Invalid provider event.');
          usage = safeUsage(chunk.usage) ?? usage;
          const choice = chunk.choices[0];
          if (!choice) continue; // Usage-only final event.
          if (!plain(choice) || (choice.delta !== undefined && !plain(choice.delta))) fail(502, 'Invalid provider choice.');
          const delta = choice.delta || {};
          if (delta.reasoning_content != null) reasoning += append(delta.reasoning_content);
          if (delta.content != null) {
            const visible = append(delta.content);
            text += visible;
            if (visible && onDelta) await onDelta(visible);
          }
          if (delta.function_call !== undefined) fail(502, 'Legacy function calls are unsupported.');
          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls) || !definitions.length) fail(502, 'Unexpected provider tool calls.');
            for (const part of delta.tool_calls) {
              if (!plain(part) || !Number.isInteger(part.index) || part.index < 0 || part.index >= AGENT_MODEL_LIMITS.toolCalls || (part.type !== undefined && part.type !== 'function') || (part.function !== undefined && !plain(part.function))) fail(502, 'Invalid provider tool call.');
              const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (part.id !== undefined) call.id += append(part.id);
              if (part.function?.name !== undefined) call.function.name += append(part.function.name);
              if (part.function?.arguments !== undefined) call.function.arguments += append(part.function.arguments);
              calls.set(part.index, call);
            }
          }
          if (choice.finish_reason != null) {
            if (finishReason !== undefined && choice.finish_reason !== finishReason) fail(502, 'Conflicting provider finish reasons.');
            finishReason = choice.finish_reason;
          }
        }
        if (!finished || !['stop', 'tool_calls'].includes(finishReason) || (calls.size > 0) !== (finishReason === 'tool_calls')) fail(502, 'Provider stream ended before a complete turn.');
        const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        if (ordered.some(call => !/^[-_A-Za-z0-9]{1,200}$/.test(call.id) || !schemas.has(call.function.name)) || new Set(ordered.map(call => call.id)).size !== ordered.length) fail(502, 'Provider returned an unknown tool or invalid call identity.');
        const toolCalls = ordered.map(call => {
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { fail(502, 'Provider returned invalid tool argument JSON.'); }
          if (!plain(args)) fail(502, 'Provider tool arguments must be a JSON object.');
          try { jsonValue(args); validateToolArguments(schemas.get(call.function.name), args); }
          catch { fail(502, 'Provider tool arguments do not match the tool schema.'); }
          return { id: call.id, name: call.function.name, arguments: args };
        });
        const assistantMessage = { role: 'assistant', content: text || null, reasoning_content: reasoning, ...(ordered.length ? { tool_calls: ordered } : {}) };
        return { text, toolCalls, assistantMessage, ...(usage ? { usage } : {}) };
      } catch (error) {
        if (signal.aborted) fail(499, 'Agent generation cancelled.', 'AGENT_CANCELLED');
        if (error instanceof ApiError) throw error;
        // Provider error bodies and transport messages can contain credentials.
        fail(502, 'Agent model request failed.', 'AGENT_MODEL_UPSTREAM');
      } finally {
        if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
        else if (upstream?.body) void upstream.body.cancel().catch(() => {});
      }
    },
  };
}
