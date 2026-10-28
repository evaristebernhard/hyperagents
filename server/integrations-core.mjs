/* Core integrations, verified against current official docs via Exa.
 * GitHub REST (pinned 2026-03-10): https://docs.github.com/en/rest/repos/repos
 * https://docs.github.com/en/rest/issues/issues https://docs.github.com/en/rest/repos/contents
 * Least privilege: fine-grained PAT selected repositories, Metadata:read,
 * Contents:read for files, Issues:read for lists / Issues:write for creation.
 * Slack: https://docs.slack.dev/reference/methods/auth.test
 * https://docs.slack.dev/reference/methods/conversations.list
 * https://docs.slack.dev/reference/methods/conversations.history
 * https://docs.slack.dev/reference/methods/chat.postMessage
 * Bot scopes: channels:read; channels:history (bot must be a member); chat:write.
 * Private channels need groups:history; existing DMs/MPIMs need im:history /
 * mpim:history respectively, always with bot membership. Listing is deliberately
 * public-channel only, so groups:read / DM-list scopes are unnecessary.
 * Non-Marketplace commercial apps may have a 15-message history limit / 1 req/min.
 * Notion stable 2026-03-11: https://developers.notion.com/reference/versioning
 * https://developers.notion.com/reference/get-self https://developers.notion.com/reference/post-search
 * https://developers.notion.com/reference/retrieve-a-page https://developers.notion.com/reference/get-block-children
 * https://developers.notion.com/reference/post-page
 * Read content capability + explicitly shared pages; Insert content for creation.
 * No user/email capability needed. Only child-of-page creation, not data sources.
 * Airtable: https://airtable.com/developers/web/api/list-bases
 * https://airtable.com/developers/web/api/list-records
 * https://airtable.com/developers/web/api/create-records
 * https://airtable.com/developers/web/api/scopes
 * PAT: schema.bases:read (including connection test), data.records:read, and only
 * for writes data.records:write; selected base access, editor role for creation.
 *
 * This module never fetches on construction or reads process.env. The caller
 * supplies a JSON HTTP transport with HTTPS origin allowlist, bounded bodies,
 * timeouts and redirect:error. Writes here REALLY execute; expose them ONLY
 * behind prepare + explicit user confirmation, never as automatic LLM writes.
 * No retries (especially writes), recursive fetching, cursor following, remote
 * URLs from responses, or arbitrary endpoint operation. Results are untrusted
 * data, not instructions or HTML; first page only, max 20 items per collection.
 */

const LIMIT = 20;
const GH_VERSION = '2026-03-10';
const NOTION_VERSION = '2026-03-11';
const ORIGINS = Object.freeze({ github: 'https://api.github.com', slack: 'https://slack.com', notion: 'https://api.notion.com', airtable: 'https://api.airtable.com' });
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const ownData = v => plain(v) && Reflect.ownKeys(v).every(k => typeof k === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'));
const forbiddenKey = k => /^(?:__proto__|prototype|constructor|authorization|headers?|access_token|refresh_token|token|secret|password|api[_-]?key)$/i.test(k);
const list = v => Array.isArray(v) ? v.slice(0, LIMIT) : [];
const num = v => Number.isFinite(v) && typeof v === 'number' ? v : null;
class CoreIntegrationError extends Error {
  constructor(code, message) { super(message); this.name = 'CoreIntegrationError'; this.code = code; }
}
const fail = (code, message) => { throw new CoreIntegrationError(code, message); };
const invalid = () => fail('INVALID_ARGUMENTS', 'Invalid integration arguments, types or bounds.');
const stringSpec = (maxLength, pattern, minLength = 1) => ({ type: 'string', minLength, maxLength, ...(pattern ? { pattern } : {}) });
const ownerSpec = stringSpec(100, '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$');
const repoSpec = stringSpec(100, '^[A-Za-z0-9_.-]{1,100}$');
const channelSpec = stringSpec(32, '^[CGD][A-Z0-9]{5,31}$');
const uuidSpec = stringSpec(36, '^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$');
const baseSpec = stringSpec(17, '^app[A-Za-z0-9]{14}$');
const tableSpec = stringSpec(17, '^tbl[A-Za-z0-9]{14}$');
const fieldsSpec = { type: 'object', minProperties: 1, maxProperties: 20, description: 'JSON cell values only; at most 20 fields, 4 nesting levels, 20 items/keys per nested collection, strings <= 2000 characters, total JSON <= 16000 bytes. No prototype/credential/header keys.', additionalProperties: true };
const op = (name, type, description, properties) => ({ name, type, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });

// These checks intentionally do not depend on the public, mutable JSON schemas.
function str(v, max, pattern, { empty = false, multiline = false } = {}) {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v) || (!multiline && /[\n\r\t]/.test(v)) || (pattern && !pattern.test(v))) invalid();
}
function keys(args, expected) {
  if (!ownData(args) || Reflect.ownKeys(args).length !== expected.length || expected.some(k => !Object.hasOwn(args, k)) || Reflect.ownKeys(args).some(k => !expected.includes(k))) invalid();
}
function repository(a) {
  str(a.owner, 100, /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/);
  str(a.repo, 100, /^[A-Za-z0-9_.-]{1,100}$/);
  if (a.repo === '.' || a.repo === '..') invalid();
}
function uuid(v) { str(v, 36, /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/); }
function channel(v) { str(v, 32, /^[CGD][A-Z0-9]{5,31}$/); }
function table(a) { str(a.baseId, 17, /^app[A-Za-z0-9]{14}$/); str(a.tableId, 17, /^tbl[A-Za-z0-9]{14}$/); }
function filePath(v) {
  str(v, 500);
  const segments = v.split('/');
  if (segments.length > 20 || /[\\%?#:]/.test(v) || segments.some(s => !s || s === '.' || s === '..')) invalid();
  return segments.map(s => encodeURIComponent(s)).join('/');
}
function fieldValues(v) {
  if (!ownData(v) || Reflect.ownKeys(v).length < 1) invalid();
  const visit = (x, depth) => {
    if (depth > 4) invalid();
    if (x === null || typeof x === 'boolean') return;
    if (typeof x === 'number') { if (!Number.isFinite(x)) invalid(); return; }
    if (typeof x === 'string') { str(x, 2000, undefined, { empty: true, multiline: true }); return; }
    if (Array.isArray(x)) {
      if (x.length > LIMIT || Reflect.ownKeys(x).some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= x.length)) || Object.keys(x).length !== x.length) invalid();
      for (let i = 0; i < x.length; i++) { const d = Object.getOwnPropertyDescriptor(x, String(i)); if (!d || !Object.hasOwn(d, 'value')) invalid(); visit(d.value, depth + 1); }
      return;
    }
    if (!ownData(x) || Reflect.ownKeys(x).length > LIMIT) invalid();
    for (const [k, value] of Object.entries(x)) { str(k, 100); if (forbiddenKey(k)) invalid(); visit(value, depth + 1); }
  };
  visit(v, 0);
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > 16000) invalid();
  // Snapshot validated JSON; callers cannot mutate a pending request body.
  return JSON.parse(JSON.stringify(v));
}
function validate(name, a) {
  switch (name) {
    case 'github_repositories': case 'slack_channels': case 'airtable_bases': keys(a, []); break;
    case 'github_issues': keys(a, ['owner', 'repo']); repository(a); break;
    case 'github_read_file': keys(a, ['owner', 'repo', 'path']); repository(a); filePath(a.path); break;
    case 'github_create_issue': keys(a, ['owner', 'repo', 'title', 'body']); repository(a); str(a.title, 256); str(a.body, 10000, undefined, { empty: true, multiline: true }); break;
    case 'slack_history': keys(a, ['channel']); channel(a.channel); break;
    case 'slack_send_message': keys(a, ['channel', 'text']); channel(a.channel); str(a.text, 4000, undefined, { multiline: true }); break;
    case 'notion_search': keys(a, ['query']); str(a.query, 200, undefined, { empty: true }); break;
    case 'notion_page': keys(a, ['pageId']); uuid(a.pageId); break;
    case 'notion_create_page': keys(a, ['parentPageId', 'title', 'text']); uuid(a.parentPageId); str(a.title, 200); str(a.text, 10000, undefined, { empty: true, multiline: true }); break;
    case 'airtable_records': keys(a, ['baseId', 'tableId']); table(a); break;
    case 'airtable_create_record': keys(a, ['baseId', 'tableId', 'fields']); table(a); fieldValues(a.fields); break;
    default: fail('UNKNOWN_OPERATION', 'Unknown integration operation.');
  }
}
function checkSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
  if (signal?.aborted) fail('CANCELLED', 'Integration request cancelled.');
}
function upstreamError(provider, code) {
  // Only fixed messages, never payloads, upstream messages, headers or cause.
  const descriptions = {
    '401': 'Authentication failed; check the server credential.', invalid_auth: 'Authentication failed; check the server credential.', token_revoked: 'Authentication failed; check the server credential.', not_authed: 'Authentication failed; check the server credential.', unauthorized: 'Authentication failed; check the server credential.', AUTHENTICATION_REQUIRED: 'Authentication failed; check the server credential.',
    '403': 'Access denied; check token scopes and resource sharing.', missing_scope: 'Access denied; check token scopes and resource sharing.', restricted_action: 'Access denied; check token scopes and resource sharing.', restricted_resource: 'Access denied; check token scopes and resource sharing.', INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: 'Access denied; check token scopes and resource sharing.',
    '404': 'Resource unavailable; check its ID and sharing.', channel_not_found: 'Resource unavailable; check its ID and sharing.', object_not_found: 'Resource unavailable; check its ID and sharing.', not_in_channel: 'The bot must be a member of this conversation.',
    '429': 'Rate limited; retry later.', ratelimited: 'Rate limited; retry later.', rate_limited: 'Rate limited; retry later.',
    '400': 'The API rejected this request; check fields and resource IDs.', '422': 'The API rejected this request; check fields and resource IDs.', validation_error: 'The API rejected this request; check fields and resource IDs.', INVALID_REQUEST_UNKNOWN: 'The API rejected this request; check fields and resource IDs.', INVALID_VALUE_FOR_COLUMN: 'The API rejected this request; check fields and resource IDs.',
  };
  fail('UPSTREAM_ERROR', `${provider}: ${Object.hasOwn(descriptions, code) ? descriptions[code] : 'API request failed; check credentials, permissions and API availability.'}`);
}

/** @param {{credentials?:Object,http?:Function}} options */
export function createCoreIntegrations({ credentials = {}, http } = {}) {
  const names = ['GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'NOTION_TOKEN', 'AIRTABLE_TOKEN'];
  const tokens = Object.fromEntries(names.map(k => {
    const value = plain(credentials) ? Object.getOwnPropertyDescriptor(credentials, k)?.value : undefined;
    return [k, typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value) ? value : null];
  }));
  const secrets = [...new Set(Object.values(tokens).filter(Boolean).flatMap(t => [t, encodeURIComponent(t), Buffer.from(t).toString('base64')]))].sort((a, b) => b.length - a.length);
  const text = (v, max = 300) => {
    if (typeof v !== 'string') return null;
    let value = v.slice(0, max + 4096);
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value.slice(0, max);
  };
  const safeUrl = v => {
    const value = text(v, 1000);
    if (!value || value.includes('[redacted]')) return null;
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? value : null; } catch { return null; }
  };
  const richText = v => text(list(v).map(t => text(typeof t?.plain_text === 'string' ? t.plain_text : t?.text?.content, 2000) ?? '').join(''), 2000);
  const issue = v => ({ number: num(v?.number), title: text(v?.title), state: text(v?.state, 20), body: text(v?.body, 2000), url: safeUrl(v?.html_url), isPullRequest: Boolean(v?.pull_request) });
  const page = v => ({ id: text(v?.id, 36), title: richText(Object.values(plain(v?.properties) ? v.properties : {}).find(p => p?.type === 'title')?.title ?? v?.title), url: safeUrl(v?.url), lastEditedTime: text(v?.last_edited_time, 40), inTrash: v?.in_trash === true });
  const cell = (v, depth = 0) => {
    if (depth > 4) return null;
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string') return text(v, 1000);
    if (Array.isArray(v)) return list(v).map(x => cell(x, depth + 1));
    if (plain(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !forbiddenKey(k)).slice(0, LIMIT).map(([k, x]) => [text(k, 100), cell(x, depth + 1)]));
    return null;
  };
  const record = v => ({ id: text(v?.id, 40), createdTime: text(v?.createdTime, 40), fields: cell(plain(v?.fields) ? v.fields : {}) });
  // One global text budget across each projected result, in addition to per-field
  // and per-collection bounds. Avoid huge nested Airtable/Notion cell payloads.
  const finish = value => {
    let budget = 48000;
    let nodes = 1000;
    const boundedText = (s, max) => {
      const safe = text(s, max);
      let result = ''; let bytes = 0;
      for (const ch of safe) { const size = Buffer.byteLength(ch, 'utf8'); if (bytes + size > budget) break; result += ch; bytes += size; }
      budget -= bytes;
      return result;
    };
    const walk = v => {
      if (--nodes < 0) return null;
      if (typeof v === 'string') return boundedText(v, 12000);
      if (Array.isArray(v)) return list(v).map(walk);
      if (plain(v)) {
        const entries = [];
        for (const [k, x] of Object.entries(v).slice(0, LIMIT)) {
          if (budget < Buffer.byteLength(text(k, 100), 'utf8') || nodes <= 0) break;
          const key = boundedText(k, 100); entries.push([key, walk(x)]);
        }
        return Object.fromEntries(entries);
      }
      return v;
    };
    const result = walk(value);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 65536) fail('RESULT_TOO_LARGE', 'Integration result exceeds the safe output limit.');
    return result;
  };
  function provider(id, name, env, operations, identity, execute) {
    const configured = Boolean(tokens[env] && typeof http === 'function');
    const operationNames = new Set(operations.map(o => o.name));
    async function request(path, signal, method = 'GET', body) {
      checkSignal(signal);
      const headers = { Authorization: `Bearer ${tokens[env]}`, Accept: 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      if (id === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = GH_VERSION; headers['User-Agent'] = 'Tonic-CoreIntegrations/1.0'; }
      if (id === 'notion') headers['Notion-Version'] = NOTION_VERSION;
      let result;
      try { result = await http(`${ORIGINS[id]}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), signal }); }
      catch (error) {
        if (signal?.aborted) fail('CANCELLED', 'Integration request cancelled.');
        const status = [400, 401, 403, 404, 422, 429].find(n => n === error?.status || n === error?.statusCode);
        upstreamError(name, String(status ?? 'unknown'));
      }
      checkSignal(signal);
      if (!result || typeof result !== 'object') upstreamError(name, 'unknown');
      if (id === 'slack' && result.ok !== true) upstreamError(name, typeof result.error === 'string' ? result.error : 'unknown');
      if (id === 'notion' && result.object === 'error') upstreamError(name, typeof result.code === 'string' ? result.code : 'unknown');
      if (id === 'airtable' && result.error) upstreamError(name, typeof result.error?.type === 'string' ? result.error.type : 'unknown');
      if (id === 'github' && !Array.isArray(result) && typeof result.message === 'string') upstreamError(name, String(result.status ?? 'unknown'));
      return result;
    }
    const available = () => { if (!configured) fail('UNAVAILABLE', `${name} unavailable; configure its server credential and HTTP transport.`); };
    return {
      id, name, env: [env], configured, operations,
      test: async signal => { available(); checkSignal(signal); return finish({ accountLabel: text(await identity((p, m, b) => request(p, signal, m, b)), 200) || name }); },
      run: async (operation, args, signal) => {
        available();
        if (!operationNames.has(operation)) fail('UNKNOWN_OPERATION', 'Unknown integration operation.');
        validate(operation, args); checkSignal(signal);
        return finish(await execute(operation, args, (p, m, b) => request(p, signal, m, b)));
      },
    };
  }
  const requireArray = v => { if (!Array.isArray(v)) upstreamError('Integration', 'unknown'); return v; };
  const requireObject = v => { if (!plain(v)) upstreamError('Integration', 'unknown'); return v; };
  return [
    provider('github', 'GitHub', 'GITHUB_TOKEN', [
      op('github_repositories', 'read', 'List the first 20 accessible repositories.', {}),
      op('github_issues', 'read', 'List the first 20 open repository issues (including pull requests, marked isPullRequest).', { owner: ownerSpec, repo: repoSpec }),
      op('github_read_file', 'read', 'Read a UTF-8 repository file (text preview up to 12000 characters); no download URL is followed.', { owner: ownerSpec, repo: repoSpec, path: stringSpec(500) }),
      op('github_create_issue', 'write', 'Create one issue; requires explicit user confirmation before execution.', { owner: ownerSpec, repo: repoSpec, title: stringSpec(256), body: stringSpec(10000, undefined, 0) }),
    ], async req => {
      const v = requireObject(await req('/user')); if (typeof v.login !== 'string' || !v.login) upstreamError('GitHub', 'unknown'); return v.login;
    }, async (name, a, req) => {
      if (name === 'github_repositories') {
        const v = requireArray(await req('/user/repos?per_page=20&sort=updated'));
        return { repositories: list(v).map(r => ({ id: num(r?.id), name: text(r?.name), fullName: text(r?.full_name), private: r?.private === true, description: text(r?.description, 500), url: safeUrl(r?.html_url) })), truncated: v.length >= LIMIT };
      }
      const root = `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
      if (name === 'github_issues') { const v = requireArray(await req(`${root}/issues?state=open&per_page=20`)); return { issues: list(v).map(issue), truncated: v.length >= LIMIT }; }
      if (name === 'github_create_issue') { const v = requireObject(await req(`${root}/issues`, 'POST', { title: a.title, body: a.body })); if (!Number.isInteger(v.number)) upstreamError('GitHub', 'unknown'); return { issue: issue(v) }; }
      const v = requireObject(await req(`${root}/contents/${filePath(a.path)}`));
      if (v.type !== 'file' || v.encoding !== 'base64' || typeof v.content !== 'string') fail('UNSUPPORTED_FILE', 'GitHub: only inline base64 file content is supported (files at most 1 MB).');
      // Decode only a bounded prefix; never follow download_url / symlink targets.
      const encoded = v.content.slice(0, 24000).replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) upstreamError('GitHub', 'unknown');
      const bytes = Buffer.from(encoded, 'base64');
      // streaming decode tolerates a final code point cut by the preview bound,
      // but still rejects malformed UTF-8 anywhere inside the decoded prefix.
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: v.content.length > 24000 }); }
      catch { fail('UNSUPPORTED_FILE', 'GitHub: only UTF-8 text files are supported.'); }
      if (decoded.includes('\u0000')) fail('UNSUPPORTED_FILE', 'GitHub: only UTF-8 text files are supported.');
      return { file: { path: text(v.path, 500), sha: text(v.sha, 80), size: num(v.size), text: text(decoded, 12000), truncated: v.content.length > 24000 || decoded.length > 12000 } };
    }),
    provider('slack', 'Slack', 'SLACK_BOT_TOKEN', [
      op('slack_channels', 'read', 'List the first 20 public channels visible to this workspace bot.', {}),
      op('slack_history', 'read', 'Read the first 15 recent messages; bot membership and appropriate history scope required.', { channel: channelSpec }),
      op('slack_send_message', 'write', 'Post one text message without link unfurls; requires explicit user confirmation.', { channel: channelSpec, text: stringSpec(4000) }),
    ], async req => {
      const v = await req('/api/auth.test', 'POST', {}); if (typeof v.team !== 'string' || !v.team) upstreamError('Slack', 'unknown'); return v.team;
    }, async (name, a, req) => {
      if (name === 'slack_channels') { const v = await req('/api/conversations.list?limit=20&exclude_archived=true&types=public_channel'); requireArray(v.channels); return { channels: list(v.channels).map(c => ({ id: text(c?.id, 32), name: text(c?.name), isMember: c?.is_member === true, topic: text(c?.topic?.value, 500) })), truncated: Boolean(v.response_metadata?.next_cursor) || v.channels.length > LIMIT }; }
      if (name === 'slack_history') { const v = await req(`/api/conversations.history?channel=${encodeURIComponent(a.channel)}&limit=15`); requireArray(v.messages); return { channel: a.channel, messages: list(v.messages).map(m => ({ ts: text(m?.ts, 40), user: text(m?.user, 32), text: text(m?.text, 2000), threadTs: text(m?.thread_ts, 40) })), truncated: v.has_more === true || Boolean(v.response_metadata?.next_cursor) || v.messages.length > LIMIT }; }
      const v = await req('/api/chat.postMessage', 'POST', { channel: a.channel, text: a.text, unfurl_links: false, unfurl_media: false });
      if (typeof v.ts !== 'string' || typeof v.channel !== 'string') upstreamError('Slack', 'unknown');
      return { channel: text(v.channel, 32), ts: text(v.ts, 40), text: text(v.message?.text, 4000) };
    }),
    provider('notion', 'Notion', 'NOTION_TOKEN', [
      op('notion_search', 'read', 'Search shared page titles, first 20 pages (empty query lists shared pages).', { query: stringSpec(200, undefined, 0) }),
      op('notion_page', 'read', 'Read page metadata/properties and first 20 direct child blocks; nested blocks are not followed.', { pageId: uuidSpec }),
      op('notion_create_page', 'write', 'Create a child page with title and paragraph text; requires explicit user confirmation.', { parentPageId: uuidSpec, title: stringSpec(200), text: stringSpec(10000, undefined, 0) }),
    ], async req => {
      const v = requireObject(await req('/v1/users/me')); if (v.object !== 'user') upstreamError('Notion', 'unknown'); return v.bot?.workspace_name || v.name || 'Notion bot';
    }, async (name, a, req) => {
      if (name === 'notion_search') { const v = await req('/v1/search', 'POST', { query: a.query, filter: { property: 'object', value: 'page' }, page_size: LIMIT }); requireArray(v.results); return { pages: list(v.results).map(page), truncated: v.has_more === true || v.results.length > LIMIT }; }
      if (name === 'notion_create_page') {
        const chunks = []; let chunk = '';
        // Chunk by code point to keep emoji surrogate pairs intact at API limits.
        for (const ch of a.text) { if (chunk.length + ch.length > 2000) { chunks.push(chunk); chunk = ''; } chunk += ch; }
        if (chunk) chunks.push(chunk);
        const v = await req('/v1/pages', 'POST', { parent: { page_id: a.parentPageId }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: a.title } }] } }, children: chunks.map(content => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } })) });
        if (v.object !== 'page') upstreamError('Notion', 'unknown'); return { page: page(v) };
      }
      const id = encodeURIComponent(a.pageId);
      const v = await req(`/v1/pages/${id}`); if (v.object !== 'page') upstreamError('Notion', 'unknown');
      const children = await req(`/v1/blocks/${id}/children?page_size=20`); requireArray(children.results);
      const properties = Object.entries(plain(v.properties) ? v.properties : {}).slice(0, LIMIT).map(([name, p]) => {
        const type = typeof p?.type === 'string' ? p.type : '';
        const value = p?.[type];
        let projected = null;
        if (type === 'title' || type === 'rich_text') projected = richText(value);
        else if (type === 'number') projected = num(value);
        else if (type === 'checkbox') projected = typeof value === 'boolean' ? value : null;
        else if (type === 'select' || type === 'status') projected = text(value?.name);
        else if (type === 'multi_select') projected = list(value).map(s => text(s?.name));
        else if (type === 'date') projected = { start: text(value?.start, 40), end: text(value?.end, 40) };
        else if (['url', 'email', 'phone_number', 'created_time', 'last_edited_time'].includes(type)) projected = text(value, 500);
        else if (type === 'relation') projected = list(value).map(r => ({ id: text(r?.id, 36) }));
        return { name: text(name, 100), type: text(type, 40), value: projected };
      });
      return { page: { ...page(v), properties, propertiesTruncated: Object.keys(v.properties ?? {}).length > LIMIT }, children: list(children.results).map(b => ({ id: text(b?.id, 36), type: text(b?.type, 40), text: richText(b?.[b?.type]?.rich_text ?? []) || text(b?.child_page?.title, 200), hasChildren: b?.has_children === true, inTrash: b?.in_trash === true })), truncated: children.has_more === true || children.results.length > LIMIT };
    }),
    provider('airtable', 'Airtable', 'AIRTABLE_TOKEN', [
      op('airtable_bases', 'read', 'List the first 20 bases accessible to this token.', {}),
      op('airtable_records', 'read', 'Read the first 20 records with bounded JSON cell values; table ID (not name) required.', { baseId: baseSpec, tableId: tableSpec }),
      op('airtable_create_record', 'write', 'Create exactly one record without automatic typecasting; requires explicit user confirmation.', { baseId: baseSpec, tableId: tableSpec, fields: fieldsSpec }),
    ], async req => {
      const v = await req('/v0/meta/bases'); requireArray(v.bases); return v.bases[0]?.name ? `Airtable · ${v.bases[0].name}` : 'Airtable (no accessible bases)';
    }, async (name, a, req) => {
      if (name === 'airtable_bases') { const v = await req('/v0/meta/bases'); requireArray(v.bases); return { bases: list(v.bases).map(b => ({ id: text(b?.id, 17), name: text(b?.name), permissionLevel: text(b?.permissionLevel, 30) })), truncated: Boolean(v.offset) || v.bases.length > LIMIT }; }
      const path = `/v0/${encodeURIComponent(a.baseId)}/${encodeURIComponent(a.tableId)}`;
      if (name === 'airtable_records') { const v = await req(`${path}?pageSize=20&maxRecords=20`); requireArray(v.records); return { records: list(v.records).map(record), truncated: Boolean(v.offset) || v.records.length >= LIMIT }; }
      const v = requireObject(await req(path, 'POST', { fields: fieldValues(a.fields), typecast: false }));
      if (typeof v.id !== 'string') upstreamError('Airtable', 'unknown'); return { record: record(v) };
    }),
  ];
}
