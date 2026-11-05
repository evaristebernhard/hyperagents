import { setTimeout as delay } from 'node:timers/promises';

export const GENERATION_MAX_TOKENS = 32768;
export class ProviderError extends Error {
  constructor(code, message, status) { super(message); this.code=code; this.status=status; }
}

// Retry only before accepting a stream. Never rerun tools or replay partial output.
export async function fetchProvider(fetchImpl, url, init, {onRetry, wait=delay}={}) {
  for(let attempt=0;attempt<3;attempt++) {
    init.signal.throwIfAborted();
    let response;
    try { response=await fetchImpl(url,init); }
    catch(error) {
      if(init.signal.aborted)throw init.signal.reason;
      // Unknown adapter/programming errors are not transient network failures.
      if(!(error instanceof TypeError) || attempt===2)throw new ProviderError('PROVIDER_NETWORK','The model connection failed before a response was received.');
    }
    if(response?.ok)return response;
    const status=response?.status;
    if(response)void response.body?.cancel().catch(()=>{});
    if(response && ![408,429,500,502,503,504].includes(status))throw new ProviderError('PROVIDER_REJECTED',`The model provider rejected the request (HTTP ${status}).`,status);
    if(attempt===2)throw new ProviderError('PROVIDER_UNAVAILABLE',`The model provider remained unavailable after 3 attempts (HTTP ${status}).`,status);
    const retryAfter=Number(response?.headers.get('retry-after'));
    const delayMs=Math.min(10000,Math.max(500*2**attempt,Number.isFinite(retryAfter)?retryAfter*1000:0));
    await onRetry?.({attempt:attempt+2,delayMs,...(status?{status}:{})});
    await wait(delayMs,undefined,{signal:init.signal});
  }
}

export function generationFailure(error, {signal,timedOut=false}={}) {
  if(signal?.aborted)return {code:timedOut?'GENERATION_TIMEOUT':'GENERATION_CANCELLED',message:timedOut?'Generation exceeded its time limit.':'Generation was cancelled.'};
  if(error instanceof ProviderError)return {code:error.code,message:error.message,...(error.status?{providerStatus:error.status}:{})};
  const known={
    'incomplete stream':['PROVIDER_INCOMPLETE','The model stream ended before a complete response. Partial tool arguments were not executed.'],
    'output limit':['OUTPUT_LIMIT','Generation exceeded the output byte limit.'],
    'tool round limit':['ROUND_LIMIT','The agent exhausted its model-turn budget before completing the task.'],
    'tool call limit':['TOOL_LIMIT','The agent exhausted its tool-call budget.'],
    'context budget exhausted':['CONTEXT_LIMIT','The agent context exceeded its size limit.'],
  };
  const [code,message]=known[error?.message]||['PROVIDER_STREAM_ERROR','The model stream was malformed or interrupted.'];
  return {code,message};
}
