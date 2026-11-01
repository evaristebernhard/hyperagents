export type ActivityState = 'running' | 'success' | 'error';
export interface ActivityInput {
  id: string;
  name: string;
  status: ActivityState;
  summary: string;
}
export interface ActivityResult {
  title: string;
  url?: string;
  domain?: string;
  initial?: string;
  excerpt?: string;
}
export interface ActivityModel {
  id: string;
  label: string;
  state: ActivityState;
  statusText: string;
  outcome?: 'approval' | 'prepared';
  text: string;
  query?: string;
  results: ActivityResult[];
  omittedResults: number;
  raw?: string;
}

const MAX_PARSE = 65536;
const MAX_RESULTS = 8;
const labels: Record<string, string> = {
  exa_search: 'Searching the web', exasearch: 'Searching the web',
  web_search: 'Searching the web', workspace_search: 'Searching workspace',
  search_workspace: 'Searching workspace', exa_contents: 'Reading web pages',
  exacontents: 'Reading web pages', browser_navigate: 'Opening a page',
  browsernavigate: 'Opening a page', browser_action: 'Using the browser',
  browseraction: 'Using the browser', read_file: 'Reading a file',
  write_file: 'Writing a file', edit_file: 'Editing a file',
  search_integrations: 'Finding integrations', execute_integration: 'Using an integration',
  bash: 'Running a command', read: 'Reading a file', write: 'Writing a file',
  edit: 'Editing a file',
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedText(value: unknown, max = 600): string {
  if (typeof value !== 'string') return '';
  // Strip control characters, not meaningful whitespace or Unicode text.
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return clean.length > max ? clean.slice(0, Math.max(0, max - 1)) + '…' : clean;
}
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function toolLabel(name: string): string {
  const short = name.split(/[./:]/).pop() || name;
  const key = short.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : undefined;
  if (known) return known;
  const readable = boundedText(short.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '), 100);
  return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : 'Tool activity';
}
function firstText(obj: Record<string, unknown>, keys: string[], max: number): string {
  for (const key of keys) {
    const text = boundedText(obj[key], max);
    if (text) return text;
  }
  return '';
}
function resultItem(value: unknown): ActivityResult | undefined {
  if (!record(value)) return undefined;
  const title = firstText(value, ['title', 'name'], 180);
  const excerpt = firstText(value, ['excerpt', 'snippet', 'description', 'summary'], 360);
  const url = safeExternalUrl(value.url);
  if (!title && !excerpt && !url) return undefined;
  const domain = url ? new URL(url).hostname.replace(/^www\./, '') : undefined;
  return {
    title: title || domain || excerpt,
    ...(excerpt && excerpt !== title && (title || domain) ? { excerpt } : {}),
    ...(url ? { url, domain, initial: domain?.charAt(0).toUpperCase() || '↗' } : {}),
  };
}

/** Pure, bounded, serializable view model; no React, network calls, or invented metadata. */
export function formatToolActivity(run: ActivityInput): ActivityModel {
  const source = typeof run.summary === 'string' ? run.summary : '';
  let parsed: unknown;
  let isJson = false;
  if (source.length <= MAX_PARSE) {
    try { parsed = JSON.parse(source); isJson = true; } catch { /* Includes clipped JSON. */ }
  }
  // Look only through conventional envelope fields, with a hard traversal bound.
  const envelopes: Record<string, unknown>[] = [];
  if (record(parsed)) envelopes.push(parsed);
  for (let i = 0; i < envelopes.length && i < 12; i++) {
    for (const key of ['data', 'result', 'output', 'response']) {
      const child = envelopes[i][key];
      if (record(child) && envelopes.length < 12) envelopes.push(child);
    }
  }
  let outcome: ActivityModel['outcome'];
  for (const obj of envelopes) {
    const status = firstText(obj, ['status', 'state', 'outcome'], 100).toLowerCase().replace(/[ -]/g, '_');
    if (obj.approval_required === true || obj.requiresApproval === true || obj.requires_approval === true ||
        ['pending_approval', 'approval_required', 'awaiting_approval', 'requires_approval'].includes(status)) {
      outcome = 'approval'; break;
    }
    if (['prepared', 'draft', 'draft_created', 'ready_for_review'].includes(status) || obj.prepared === true) outcome = 'prepared';
  }
  const humanText = envelopes.map(obj => firstText(obj, ['message', 'summary', 'error', 'description'], 600)).find(Boolean) || '';
  const plain = !isJson ? boundedText(source, 600) : (typeof parsed === 'string' ? boundedText(parsed, 600) : '');
  // A successful tool call may only have prepared an action or requested approval.
  const outcomeText = humanText || plain;
  if (/(?:^|[.!;\n]\s*)(?:pending approval|awaiting approval|approval required|requires (?:your |user )?approval)\b/i.test(outcomeText)) outcome = 'approval';
  else if (!outcome && /^(?:(?:a |the )?draft (?:created|saved)|prepared\b|ready for (?:your )?review\b)/i.test(outcomeText)) outcome = 'prepared';

  const results: ActivityResult[] = [];
  let omittedResults = 0;
  const list = envelopes.flatMap(obj => ['results', 'tools'].map(key => obj[key])).find(Array.isArray);
  if (Array.isArray(list)) {
    // Do not scan arbitrarily large arrays merely to count eligible entries.
    for (const entry of list.slice(0, MAX_RESULTS)) {
      const item = resultItem(entry);
      if (item) results.push(item);
    }
    omittedResults = Math.max(0, list.length - MAX_RESULTS);
  }
  const query = envelopes.map(obj => firstText(obj, ['query'], 160)).find(Boolean);
  const declaredCount = envelopes.map(obj => obj.returnedCount).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) as number | undefined;
  if (declaredCount !== undefined) omittedResults = Math.max(omittedResults, declaredCount - results.length);
  let text = humanText || plain;
  if (!text && isJson && !results.length) {
    if (Array.isArray(list) && list.length === 0) text = 'No results returned.';
    else if (parsed === null) text = 'No details returned.';
    else if (typeof parsed === 'number' || typeof parsed === 'boolean') text = String(parsed);
    else text = 'Structured details returned.';
  }
  if (!text && !results.length) text = run.status === 'running' ? 'Waiting for an update.' : 'No details returned.';
  const state: ActivityState = ['running', 'success', 'error'].includes(run.status) ? run.status : 'error';
  const statusText = state === 'error' ? 'Error' : state === 'running' ? 'Running' :
    outcome === 'approval' ? 'Awaiting approval' : outcome === 'prepared' ? 'Prepared' : 'Completed';
  let raw: string | undefined;
  if (isJson && typeof parsed === 'object' && parsed !== null) {
    try { raw = boundedText(JSON.stringify(parsed, null, 2), 6000); }
    catch { raw = boundedText(source, 6000); } // Very deeply nested JSON can exceed stringify's stack.
  } else if (source.trim().length > 600) raw = boundedText(source, 6000);
  return { id: run.id, label: toolLabel(run.name), state, statusText,
    ...(outcome ? { outcome } : {}), ...(query ? { query } : {}), text, results, omittedResults, ...(raw ? { raw } : {}) };
}
