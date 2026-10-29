import { ApiError } from './validation.mjs';
import { MODELS } from './llm.mjs';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MAX_BYTES = 64 * 1024;
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// This is an explicit, tiny paid request, never a page-load health check.
export function createProviderProbe({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, cooldownMs = 30000, clock = Date.now }) {
  const cache = new Map();
  let busy = false;
  return async function probe(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['model', 'confirmed'].includes(k)) || body.confirmed !== true) throw new ApiError(400, 'Confirm the small provider test request.', 'PROBE_CONFIRMATION');
    const model = body.model;
    if (!MODELS.includes(model)) throw new ApiError(422, 'Unsupported model.', 'PROBE_MODEL');
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ApiError(503, 'DeepSeek is not configured on the server.', 'LLM_NOT_CONFIGURED');
    const previous = cache.get(model);
    if (previous && clock() - previous.time < cooldownMs) return { ...previous.result, cached: true };
    if (busy) throw new ApiError(409, 'A provider test is already running.', 'PROBE_BUSY');
    busy = true;
    const start = clock(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    let reader, result;
    try {
      const response = await untilAborted(fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 16, stream: false, thinking: { type: 'disabled' } }),
      }), controller.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = response.status;
        const code = [401, 403].includes(status) ? 'AUTH_REJECTED' : status === 402 ? 'INSUFFICIENT_BALANCE' : status === 429 ? 'RATE_LIMITED' : [400, 404, 422].includes(status) ? 'MODEL_UNAVAILABLE' : 'PROVIDER_ERROR';
        result = { status: 'failed', code };
      } else {
        if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw Error('invalid response');
        reader = response.body.getReader();
        let size = 0; const chunks = [];
        for (;;) {
          const { done, value } = await untilAborted(reader.read(), controller.signal);
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw Error('response limit');
          chunks.push(Buffer.from(value));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof value?.choices?.[0]?.message?.content !== 'string' || !value.choices[0].message.content.trim()) throw Error('missing answer');
        result = { status: 'verified' };
      }
    } catch {
      result = { status: 'failed', code: controller.signal.aborted ? 'TIMEOUT' : 'CONNECTION_ERROR' };
    } finally {
      clearTimeout(timer); void reader?.cancel().catch(() => {}); busy = false;
    }
    // Never return provider bodies, headers, URLs, exceptions or credentials.
    result = { ...result, model, checkedAt: new Date(clock()).toISOString(), latencyMs: Math.max(0, clock() - start), cached: false };
    cache.set(model, { time: clock(), result });
    return result;
  };
}
