import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreIntegrations } from './integrations-core.mjs';

// Every call uses this injected in-memory transport. No network or real tokens.
const credentials = { GITHUB_TOKEN: 'github-test-secret-0123456789', SLACK_BOT_TOKEN: 'slack-test-secret-0123456789', NOTION_TOKEN: 'notion-test-secret-0123456789', AIRTABLE_TOKEN: 'airtable-test-secret-0123456789' };
const pageId = '12345678-1234-1234-1234-123456789abc';
const baseId = 'app123456789ABCDE';
const tableId = 'tbl123456789ABCDE';
const channel = 'C12345678';
const tooMany = () => Array.from({ length: 25 }, (_, i) => i);
const identityPage = { object: 'page', id: pageId, url: `https://www.notion.so/${pageId}`, properties: { title: { type: 'title', title: [{ plain_text: 'Roadmap' }] } }, last_edited_time: '2026-10-01T00:00:00.000Z', in_trash: false };
function setup(responses = []) {
  const calls = [];
  const queue = [...responses];
  const http = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(queue.length, 'Unexpected HTTP call');
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(url, options) : value;
  };
  return { providers: createCoreIntegrations({ credentials, http }), calls, queue };
}
function use(id, responses) { const fixture = setup(responses); return { ...fixture, adapter: fixture.providers.find(p => p.id === id) }; }
function assertRequest(call, url, token, method = 'GET', body) {
  assert.equal(call.url, url);
  assert.equal(call.method, method);
  assert.equal(call.headers.Authorization, `Bearer ${token}`);
  assert.equal(call.body === undefined, body === undefined);
  if (body !== undefined) { assert.deepEqual(call.body, body); assert.equal(call.headers['Content-Type'], 'application/json'); }
  assert.equal(new URL(call.url).protocol, 'https:');
  assert.equal(call.headers.Accept, url.startsWith('https://api.github.com') ? 'application/vnd.github+json' : 'application/json');
  if (url.startsWith('https://api.github.com')) assert.equal(call.headers['User-Agent'], 'Tonic-CoreIntegrations/1.0');
}
const rejectsCode = (promise, code) => assert.rejects(promise, e => e.code === code && !e.cause);

test('factory advertises exactly four providers and all 13 strictly described operations without making requests', () => {
  const { providers, calls } = setup();
  assert.deepEqual(providers.map(({ id, name, env, configured }) => ({ id, name, env, configured })), [
    { id: 'github', name: 'GitHub', env: ['GITHUB_TOKEN'], configured: true },
    { id: 'slack', name: 'Slack', env: ['SLACK_BOT_TOKEN'], configured: true },
    { id: 'notion', name: 'Notion', env: ['NOTION_TOKEN'], configured: true },
    { id: 'airtable', name: 'Airtable', env: ['AIRTABLE_TOKEN'], configured: true },
  ]);
  const operations = providers.flatMap(p => p.operations);
  assert.equal(operations.length, 13);
  assert.equal(operations.filter(o => o.type === 'write').length, 4);
  for (const o of operations) {
    assert.ok(o.description);
    assert.equal(o.parameters.type, 'object');
    assert.equal(o.parameters.additionalProperties, false);
    assert.deepEqual(o.parameters.required, Object.keys(o.parameters.properties));
    assert.ok(['read', 'write'].includes(o.type));
  }
  assert.deepEqual(calls, []);
  for (const secret of Object.values(credentials)) assert.ok(!JSON.stringify(providers).includes(secret));
});

test('missing/malformed credentials or missing transport make providers unavailable; no HTTP', async () => {
  for (const creds of [{}, null, { GITHUB_TOKEN: 'a\nb', SLACK_BOT_TOKEN: '', NOTION_TOKEN: 123, AIRTABLE_TOKEN: ' ' }]) {
    let calls = 0;
    for (const provider of createCoreIntegrations({ credentials: creds, http: () => { calls++; } })) {
      assert.equal(provider.configured, false);
      await rejectsCode(provider.test(), 'UNAVAILABLE');
      await rejectsCode(provider.run(provider.operations[0].name, {}), 'UNAVAILABLE');
    }
    assert.equal(calls, 0);
  }
  for (const provider of createCoreIntegrations({ credentials })) assert.equal(provider.configured, false);
});

test('credentials are captured, not exposed or later mutable, and credential accessors are not invoked', async () => {
  const mutable = { ...credentials };
  let got = false;
  Object.defineProperty(mutable, 'SLACK_BOT_TOKEN', { get() { got = true; throw Error('no'); } });
  const calls = [];
  const providers = createCoreIntegrations({ credentials: mutable, http: async (url, options) => { calls.push({ url, ...options }); return { login: 'octocat' }; } });
  mutable.GITHUB_TOKEN = 'changed';
  await providers[0].test();
  assert.equal(calls[0].headers.Authorization, `Bearer ${credentials.GITHUB_TOKEN}`);
  assert.equal(providers[1].configured, false);
  assert.equal(got, false);
});

test('connection tests perform minimum real identity/base requests and return only accountLabel', async () => {
  const signal = new AbortController().signal;
  const { providers, calls } = setup([
    { login: 'octocat', email: 'private@example.com', raw: credentials.GITHUB_TOKEN },
    { ok: true, team: 'Workspace', user: 'bot', user_id: 'U1234', token: credentials.SLACK_BOT_TOKEN },
    { object: 'user', name: 'Integration', bot: { workspace_name: 'Notion space', owner: { user: { email: 'private@example.com' } } } },
    { bases: [{ id: baseId, name: 'Tasks', permissionLevel: 'create' }], offset: 'opaque' },
  ]);
  const expected = ['octocat', 'Workspace', 'Notion space', 'Airtable · Tasks'];
  for (let i = 0; i < providers.length; i++) assert.deepEqual(await providers[i].test(signal), { accountLabel: expected[i] });
  assertRequest(calls[0], 'https://api.github.com/user', credentials.GITHUB_TOKEN);
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2026-03-10');
  assertRequest(calls[1], 'https://slack.com/api/auth.test', credentials.SLACK_BOT_TOKEN, 'POST', {});
  assertRequest(calls[2], 'https://api.notion.com/v1/users/me', credentials.NOTION_TOKEN);
  assert.equal(calls[2].headers['Notion-Version'], '2026-03-11');
  assertRequest(calls[3], 'https://api.airtable.com/v0/meta/bases', credentials.AIRTABLE_TOKEN);
  for (const call of calls) assert.equal(call.signal, signal);
});

test('Airtable connection test accepts no accessible bases without pretending identity', async () => {
  const { adapter } = use('airtable', [{ bases: [] }]);
  assert.deepEqual(await adapter.test(), { accountLabel: 'Airtable (no accessible bases)' });
});

test('GitHub repositories use fixed endpoint, bounded selected fields, no raw owner or headers', async () => {
  const { adapter, calls } = use('github', [tooMany().map(i => ({ id: i, name: 'repo', full_name: 'org/repo', private: true, description: 'x'.repeat(2000), html_url: 'https://github.com/org/repo', owner: { email: 'hidden' }, headers: { Authorization: 'never' }, secret: 'never' }))]);
  const result = await adapter.run('github_repositories', {});
  assertRequest(calls[0], 'https://api.github.com/user/repos?per_page=20&sort=updated', credentials.GITHUB_TOKEN);
  assert.equal(result.repositories.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(Object.keys(result.repositories[0]), ['id', 'name', 'fullName', 'private', 'description', 'url']);
  assert.equal(result.repositories[0].description.length, 500);
  assert.ok(!JSON.stringify(result).includes('never'));
});

test('GitHub issues explicitly identify pull requests and project safe bounded content', async () => {
  const { adapter, calls } = use('github', [[{ number: 2, title: 'Bug', state: 'open', body: 'y'.repeat(3000), html_url: 'https://github.com/org/repo/issues/2', pull_request: { url: 'https://evil.test' }, user: { email: 'hidden' } }]]);
  const result = await adapter.run('github_issues', { owner: 'org', repo: 'repo' });
  assertRequest(calls[0], 'https://api.github.com/repos/org/repo/issues?state=open&per_page=20', credentials.GITHUB_TOKEN);
  assert.equal(result.issues[0].body.length, 2000);
  assert.equal(result.issues[0].isPullRequest, true);
  assert.equal(result.issues[0].number, 2);
  assert.equal(result.issues[0].user, undefined);
});

test('GitHub read_file encodes each segment, decodes UTF-8, and never follows download_url', async () => {
  const { adapter, calls } = use('github', [{ type: 'file', path: 'docs/a b[1].md', sha: 'abcd', size: 9, content: Buffer.from('Hello 🌍').toString('base64'), encoding: 'base64', download_url: 'https://evil.test/secret', _links: { self: 'hidden' } }]);
  const result = await adapter.run('github_read_file', { owner: 'octo-org', repo: 'hello.world', path: 'docs/a b[1].md' });
  assertRequest(calls[0], 'https://api.github.com/repos/octo-org/hello.world/contents/docs/a%20b%5B1%5D.md', credentials.GITHUB_TOKEN);
  assert.deepEqual(result.file, { path: 'docs/a b[1].md', sha: 'abcd', size: 9, text: 'Hello 🌍', truncated: false });
  assert.equal(calls.length, 1);
});

test('GitHub bounds file previews and does not reject UTF-8 split at a preview boundary', async () => {
  const { adapter } = use('github', [{ type: 'file', path: 'large.txt', sha: 'abc', size: 25000, encoding: 'base64', content: Buffer.from('a'.repeat(17999) + '🌍'.repeat(1000)).toString('base64') }]);
  const result = await adapter.run('github_read_file', { owner: 'org', repo: 'repo', path: 'large.txt' });
  assert.ok(result.file.text.length <= 12000);
  assert.equal(result.file.truncated, true);
});

test('GitHub directories, external symlinks, oversized unsupported content and binary fail safely', async () => {
  for (const response of [[], { type: 'dir' }, { type: 'symlink', target: 'https://evil.test' }, { type: 'file', encoding: 'none', content: '' }, { type: 'file', encoding: 'base64', content: '%%%bad' }, { type: 'file', encoding: 'base64', content: Buffer.from([0, 255, 7]).toString('base64') }]) {
    const { adapter, calls } = use('github', [response]);
    await assert.rejects(adapter.run('github_read_file', { owner: 'org', repo: 'repo', path: 'README' }), e => ['UPSTREAM_ERROR', 'UNSUPPORTED_FILE'].includes(e.code) && !e.message.includes('evil'));
    assert.equal(calls.length, 1);
  }
});

test('GitHub issue write is one actual POST with exactly approved fields; no implicit retries', async () => {
  const { adapter, calls } = use('github', [{ number: 7, title: 'Fix', state: 'open', body: 'line 1\nline 2', html_url: 'https://github.com/org/repo/issues/7' }]);
  const result = await adapter.run('github_create_issue', { owner: 'org', repo: 'repo', title: 'Fix', body: 'line 1\nline 2' });
  assertRequest(calls[0], 'https://api.github.com/repos/org/repo/issues', credentials.GITHUB_TOKEN, 'POST', { title: 'Fix', body: 'line 1\nline 2' });
  assert.equal(result.issue.number, 7);
  assert.equal(calls.length, 1);
});

test('Slack channels request public scope only and project first 20 channels', async () => {
  const { adapter, calls } = use('slack', [{ ok: true, channels: tooMany().map(() => ({ id: channel, name: 'general', is_member: true, topic: { value: 'Discussion' }, members: ['hidden'], purpose: { value: 'hidden' } })), response_metadata: { next_cursor: 'never-return-cursor' } }]);
  const result = await adapter.run('slack_channels', {});
  assertRequest(calls[0], 'https://slack.com/api/conversations.list?limit=20&exclude_archived=true&types=public_channel', credentials.SLACK_BOT_TOKEN);
  assert.equal(result.channels.length, 20);
  assert.deepEqual(result.channels[0], { id: channel, name: 'general', isMember: true, topic: 'Discussion' });
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('cursor'));
});

test('Slack history uses 15-message request, no cursor fetch, and selected message fields', async () => {
  const { adapter, calls } = use('slack', [{ ok: true, messages: [{ ts: '123.456', user: 'U1234', text: 'Hello', thread_ts: '122.456', attachments: [{ hidden: true }], bot_profile: { token: 'hidden' } }], has_more: true }]);
  const result = await adapter.run('slack_history', { channel });
  assertRequest(calls[0], `https://slack.com/api/conversations.history?channel=${channel}&limit=15`, credentials.SLACK_BOT_TOKEN);
  assert.deepEqual(result, { channel, messages: [{ ts: '123.456', user: 'U1234', text: 'Hello', threadTs: '122.456' }], truncated: true });
  assert.equal(calls.length, 1);
});

test('Slack message write uses JSON bearer POST, disables unfurling and strips extra response', async () => {
  const { adapter, calls } = use('slack', [{ ok: true, channel, ts: '123.456', message: { text: 'Approved\nmessage', token: 'hidden' }, response_metadata: { scopes: ['hidden'] } }]);
  const result = await adapter.run('slack_send_message', { channel, text: 'Approved\nmessage' });
  assertRequest(calls[0], 'https://slack.com/api/chat.postMessage', credentials.SLACK_BOT_TOKEN, 'POST', { channel, text: 'Approved\nmessage', unfurl_links: false, unfurl_media: false });
  assert.deepEqual(result, { channel, ts: '123.456', text: 'Approved\nmessage' });
});

test('Notion search is a read operation even though the API uses POST; pins current stable version', async () => {
  const { adapter, calls } = use('notion', [{ results: tooMany().map(() => identityPage), has_more: true, next_cursor: 'hidden' }]);
  const result = await adapter.run('notion_search', { query: 'Roadmap' });
  assertRequest(calls[0], 'https://api.notion.com/v1/search', credentials.NOTION_TOKEN, 'POST', { query: 'Roadmap', filter: { property: 'object', value: 'page' }, page_size: 20 });
  assert.equal(calls[0].headers['Notion-Version'], '2026-03-11');
  assert.equal(adapter.operations.find(o => o.name === 'notion_search').type, 'read');
  assert.equal(result.pages.length, 20);
  assert.equal(result.pages[0].title, 'Roadmap');
  assert.equal(result.truncated, true);
  assert.equal(result.next_cursor, undefined);
});

test('Notion page reads properties plus only first-level bounded children, with no recursion', async () => {
  const { adapter, calls } = use('notion', [{ ...identityPage, properties: { ...identityPage.properties, Status: { type: 'status', status: { name: 'Open', color: 'hidden' } }, Count: { type: 'number', number: 3 }, Flag: { type: 'checkbox', checkbox: true }, Relation: { type: 'relation', relation: [{ id: pageId }] }, Dangerous: { type: 'people', people: [{ email: 'hidden' }] } }, created_by: { email: 'hidden' } }, { results: tooMany().map(() => ({ object: 'block', id: pageId, type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Note' }] }, has_children: true, children: [{ secret: 'hidden' }], in_trash: true })), has_more: true }]);
  const result = await adapter.run('notion_page', { pageId });
  assertRequest(calls[0], `https://api.notion.com/v1/pages/${pageId}`, credentials.NOTION_TOKEN);
  assertRequest(calls[1], `https://api.notion.com/v1/blocks/${pageId}/children?page_size=20`, credentials.NOTION_TOKEN);
  assert.equal(calls[1].headers['Notion-Version'], '2026-03-11');
  assert.equal(calls.length, 2);
  assert.equal(result.children.length, 20);
  assert.deepEqual(result.children[0], { id: pageId, type: 'paragraph', text: 'Note', hasChildren: true, inTrash: true });
  assert.equal(result.page.properties.find(p => p.name === 'Status').value, 'Open');
  assert.equal(result.page.properties.find(p => p.name === 'Dangerous').value, null);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('hidden'));
});

test('Notion properties and nested multi_select/relation arrays are bounded to 20', async () => {
  const { adapter } = use('notion', [{ ...identityPage, properties: Object.fromEntries(tooMany().map(i => [`p${i}`, { type: 'multi_select', multi_select: tooMany().map(n => ({ name: `tag${n}` })) }])) }, { results: [], has_more: false }]);
  const result = await adapter.run('notion_page', { pageId });
  assert.equal(result.page.properties.length, 20);
  assert.equal(result.page.properties[0].value.length, 20);
  assert.equal(result.page.propertiesTruncated, true);
});

test('Notion create page uses page parent, title property and bounded UTF-8-safe paragraph blocks', async () => {
  const { adapter, calls } = use('notion', [identityPage]);
  const content = 'a'.repeat(1999) + '🌍' + 'b'.repeat(2000);
  const result = await adapter.run('notion_create_page', { parentPageId: pageId, title: 'Approved page', text: content });
  const expectedChunks = ['a'.repeat(1999), '🌍' + 'b'.repeat(1998), 'bb'];
  assertRequest(calls[0], 'https://api.notion.com/v1/pages', credentials.NOTION_TOKEN, 'POST', { parent: { page_id: pageId }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'Approved page' } }] } }, children: expectedChunks.map(content => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } })) });
  assert.equal(calls[0].headers['Notion-Version'], '2026-03-11');
  assert.equal(result.page.id, pageId);
  assert.equal(calls.length, 1);
});

test('Notion permits empty text and empty search query without inventing content', async () => {
  const { adapter, calls } = use('notion', [identityPage, { results: [], has_more: false }]);
  await adapter.run('notion_create_page', { parentPageId: pageId, title: 'Empty', text: '' });
  await adapter.run('notion_search', { query: '' });
  assert.deepEqual(calls[0].body.children, []);
  assert.equal(calls[1].body.query, '');
});

test('Airtable bases and records project bounded JSON data and never follow offsets', async () => {
  const { adapter, calls } = use('airtable', [{ bases: tooMany().map(() => ({ id: baseId, name: 'Tasks', permissionLevel: 'edit', secret: 'hidden' })), offset: 'https://evil.test' }, { records: tooMany().map(() => ({ id: 'rec123', createdTime: '2026-01-01', fields: { Title: 'Task', Count: 2, Tags: tooMany(), Metadata: { safe: true, token: 'hidden', headers: { Authorization: 'hidden' } } }, raw: 'hidden' })), offset: 'https://evil.test' }]);
  const bases = await adapter.run('airtable_bases', {});
  const records = await adapter.run('airtable_records', { baseId, tableId });
  assertRequest(calls[0], 'https://api.airtable.com/v0/meta/bases', credentials.AIRTABLE_TOKEN);
  assertRequest(calls[1], `https://api.airtable.com/v0/${baseId}/${tableId}?pageSize=20&maxRecords=20`, credentials.AIRTABLE_TOKEN);
  assert.equal(bases.bases.length, 20);
  assert.equal(bases.truncated, true);
  assert.equal(records.records.length, 20);
  assert.equal(records.records[0].fields.Tags.length, 20);
  assert.deepEqual(records.records[0].fields.Metadata, { safe: true });
  assert.equal(records.truncated, true);
  assert.ok(!JSON.stringify({ bases, records }).includes('hidden'));
  assert.ok(!JSON.stringify({ bases, records }).includes('evil'));
  assert.equal(calls.length, 2);
});

test('Airtable creates exactly one record with typecast false and snapshots fields', async () => {
  const fields = { Name: 'Approved', Score: 2, Active: true, Date: null, Tags: ['red'], Collaborator: { id: 'usr123' } };
  const { adapter, calls } = use('airtable', [{ id: 'rec123', createdTime: '2026-01-01', fields }]);
  const result = await adapter.run('airtable_create_record', { baseId, tableId, fields });
  assertRequest(calls[0], `https://api.airtable.com/v0/${baseId}/${tableId}`, credentials.AIRTABLE_TOKEN, 'POST', { fields, typecast: false });
  assert.notEqual(calls[0].body.fields, fields);
  assert.deepEqual(result.record, { id: 'rec123', createdTime: '2026-01-01', fields });
  assert.equal(calls.length, 1);
});

const validArgs = {
  github_repositories: {}, github_issues: { owner: 'org', repo: 'repo' }, github_read_file: { owner: 'org', repo: 'repo', path: 'README.md' }, github_create_issue: { owner: 'org', repo: 'repo', title: 'Title', body: '' },
  slack_channels: {}, slack_history: { channel }, slack_send_message: { channel, text: 'Approved' },
  notion_search: { query: 'Test' }, notion_page: { pageId }, notion_create_page: { parentPageId: pageId, title: 'Title', text: '' },
  airtable_bases: {}, airtable_records: { baseId, tableId }, airtable_create_record: { baseId, tableId, fields: { Title: 'Approved' } },
};
test('ALL operations reject extra keys, missing/wrong argument types, accessors and non-plain arguments before HTTP', async () => {
  const { providers, calls } = setup();
  for (const p of providers) {
    for (const o of p.operations) {
      const a = validArgs[o.name];
      for (const bad of [{ ...a, endpoint: 'https://evil.test' }, null, [], 'invalid', new Date(), Object.assign(Object.create({ inherited: true }), a)]) await rejectsCode(p.run(o.name, bad), 'INVALID_ARGUMENTS');
      const withGetter = { ...a }; Object.defineProperty(withGetter, 'bad', { enumerable: true, get() { throw Error('accessor should never run'); } });
      await rejectsCode(p.run(o.name, withGetter), 'INVALID_ARGUMENTS');
      const withSymbol = { ...a, [Symbol('extra')]: true };
      await rejectsCode(p.run(o.name, withSymbol), 'INVALID_ARGUMENTS');
      for (const key of Object.keys(a)) {
        const missing = { ...a }; delete missing[key];
        await rejectsCode(p.run(o.name, missing), 'INVALID_ARGUMENTS');
        await rejectsCode(p.run(o.name, { ...a, [key]: 123 }), 'INVALID_ARGUMENTS');
      }
    }
  }
  assert.equal(calls.length, 0);
});

test('runtime validation is independent from publicly mutable JSON schemas', async () => {
  const { adapter, calls } = use('github', []);
  const def = adapter.operations.find(o => o.name === 'github_issues');
  def.parameters.additionalProperties = true;
  def.parameters.properties.owner = { type: 'number' };
  def.parameters.required = [];
  await rejectsCode(adapter.run('github_issues', { owner: 123, repo: 'repo' }), 'INVALID_ARGUMENTS');
  await rejectsCode(adapter.run('github_issues', { owner: 'org', repo: 'repo', url: 'https://evil.test' }), 'INVALID_ARGUMENTS');
  await rejectsCode(adapter.run('slack_channels', {}), 'UNKNOWN_OPERATION');
  assert.equal(calls.length, 0);
});

test('GitHub owner/repo/path injection and dot traversal are rejected, including encoded and backslash variants', async () => {
  const { adapter, calls } = use('github', []);
  for (const owner of ['../other', 'https://evil.test', 'org?x=1', 'a\\b', '%2f', 'a#bad', 'org\r\nHeader: secret']) await rejectsCode(adapter.run('github_issues', { owner, repo: 'repo' }), 'INVALID_ARGUMENTS');
  for (const repo of ['.', '..', '../repo', 'repo?ref=main', '%2e%2e', 'x/y', 'x\\y']) await rejectsCode(adapter.run('github_issues', { owner: 'org', repo }), 'INVALID_ARGUMENTS');
  for (const path of ['../README', 'a/../README', 'a/./b', '%2e%2e/file', 'a/%252e%252e', '/file', 'a//b', 'a/', 'a\\b', 'https://evil.test', 'file?ref=evil', 'file#hash', 'a\u0000b', 'x'.repeat(501), Array.from({ length: 21 }, () => 'x').join('/')]) await rejectsCode(adapter.run('github_read_file', { owner: 'org', repo: 'repo', path }), 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 0);
});

test('Slack, Notion, and Airtable IDs cannot alter URLs or target arbitrary hosts', async () => {
  const { providers, calls } = setup();
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  for (const bad of ['https://evil.test', '../foo', 'id?x=1', 'id#hash', '%2f', 'id\\foo', 'id\nfoo', '']) {
    await rejectsCode(byId.slack.run('slack_history', { channel: bad }), 'INVALID_ARGUMENTS');
    await rejectsCode(byId.slack.run('slack_send_message', { channel: bad, text: 'hi' }), 'INVALID_ARGUMENTS');
    await rejectsCode(byId.notion.run('notion_page', { pageId: bad }), 'INVALID_ARGUMENTS');
    await rejectsCode(byId.notion.run('notion_create_page', { parentPageId: bad, title: 'Title', text: '' }), 'INVALID_ARGUMENTS');
    await rejectsCode(byId.airtable.run('airtable_records', { baseId: bad, tableId }), 'INVALID_ARGUMENTS');
    await rejectsCode(byId.airtable.run('airtable_records', { baseId, tableId: bad }), 'INVALID_ARGUMENTS');
  }
  assert.equal(calls.length, 0);
});

test('runtime text bounds/types reject oversized or control characters, while accepting normal multiline body', async () => {
  const { providers, calls } = setup();
  for (const provider of providers) for (const o of provider.operations) {
    for (const [key, schema] of Object.entries(o.parameters.properties)) {
      if (schema.type !== 'string') continue;
      for (const bad of ['x'.repeat(schema.maxLength + 1), 'a\u0000b', 'a\u007fb', '\ud800']) await rejectsCode(provider.run(o.name, { ...validArgs[o.name], [key]: bad }), 'INVALID_ARGUMENTS');
      if (schema.minLength > 0) await rejectsCode(provider.run(o.name, { ...validArgs[o.name], [key]: '' }), 'INVALID_ARGUMENTS');
    }
  }
  assert.equal(calls.length, 0);
});

test('Airtable fields reject dangerous keys, non-JSON values, getters, cycles and every collection/size bound', async () => {
  const { adapter, calls } = use('airtable', []);
  const cyclic = {}; cyclic.loop = cyclic;
  const arrayGetter = ['ok']; Object.defineProperty(arrayGetter, '0', { get() { throw Error('must not run'); } });
  const fieldGetter = {}; Object.defineProperty(fieldGetter, 'Name', { enumerable: true, get() { throw Error('must not run'); } });
  const extraArrayKey = ['ok']; extraArrayKey.extra = 'no';
  const badFields = [
    {}, [], null, { Name: undefined }, { Name: NaN }, { Name: Infinity }, { Name: 1n }, { Name: () => {} }, { Name: Symbol() }, { Name: new Date() },
    { Name: new Array(2) }, { Name: arrayGetter }, { Name: extraArrayKey }, fieldGetter, cyclic,
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 'x'])), { Name: tooMany() }, { Name: 'a'.repeat(2001) },
    { Name: { a: { b: { c: { d: 'too deep' } } } } }, { Name: Object.fromEntries(tooMany().map(i => [`k${i}`, i])) },
  ];
  badFields.push({ ['x'.repeat(101)]: 'bad' }, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'a'.repeat(2000)])));
  for (const k of ['__proto__', 'prototype', 'constructor', 'Authorization', 'headers', 'password', 'api_key', 'access_token']) badFields.push(JSON.parse(`{"${k}":"bad"}`), { Name: JSON.parse(`{"${k}":"bad"}`) });
  for (const fields of badFields) await rejectsCode(adapter.run('airtable_create_record', { baseId, tableId, fields }), 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 0);
});

test('all errors are sanitized fixed messages, no secret/raw body/header/error cause, and no retries', async () => {
  const transportError = Object.assign(new Error(`body ${credentials.GITHUB_TOKEN} PRIVATE_BLOB Authorization: SECRET`), { status: 401, headers: { secret: 'PRIVATE_BLOB' }, response: 'PRIVATE_BLOB' });
  const cases = [
    ['github', 'github_repositories', {}, transportError, /Authentication failed/],
    ['github', 'github_repositories', {}, { message: 'PRIVATE_BLOB', status: '403', documentation_url: 'https://evil.test' }, /Access denied/],
    ['slack', 'slack_channels', {}, { ok: false, error: 'missing_scope', needed: 'PRIVATE_BLOB', provided: credentials.SLACK_BOT_TOKEN }, /Access denied/],
    ['slack', 'slack_send_message', { channel, text: 'approved' }, { ok: false, error: `PRIVATE_BLOB ${credentials.SLACK_BOT_TOKEN}` }, /API request failed/],
    ['slack', 'slack_history', { channel }, { ok: false, error: 'not_in_channel' }, /must be a member/],
    ['slack', 'slack_history', { channel }, { ok: false, error: 'ratelimited' }, /Rate limited/],
    ['notion', 'notion_search', { query: '' }, { object: 'error', code: 'object_not_found', message: 'PRIVATE_BLOB' }, /Resource unavailable/],
    ['notion', 'notion_search', { query: '' }, { object: 'error', code: 'validation_error', message: credentials.NOTION_TOKEN }, /rejected this request/],
    ['airtable', 'airtable_bases', {}, { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'PRIVATE_BLOB' } }, /Access denied/],
    ['airtable', 'airtable_create_record', { baseId, tableId, fields: { Name: 'approved' } }, { error: { type: 'INVALID_VALUE_FOR_COLUMN', message: 'PRIVATE_BLOB' } }, /rejected this request/],
    ['airtable', 'airtable_bases', {}, { error: 'PRIVATE_BLOB' }, /API request failed/],
  ];
  for (const [id, operation, args, response, pattern] of cases) {
    const { adapter, calls } = use(id, [response]);
    await assert.rejects(adapter.run(operation, args), error => {
      assert.equal(error.code, 'UPSTREAM_ERROR'); assert.match(error.message, pattern);
      const serialized = JSON.stringify({ message: error.message, ...error });
      assert.ok(!serialized.includes('PRIVATE_BLOB')); assert.ok(!serialized.includes('Authorization')); assert.equal(error.cause, undefined);
      for (const secret of Object.values(credentials)) assert.ok(!serialized.includes(secret));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('malformed success responses fail instead of fabricating successful writes/tests', async () => {
  for (const [id, name, args, response] of [
    ['github', 'github_repositories', {}, {}], ['github', 'github_create_issue', validArgs.github_create_issue, {}],
    ['slack', 'slack_channels', {}, { ok: true }], ['slack', 'slack_send_message', validArgs.slack_send_message, { ok: true }],
    ['notion', 'notion_search', { query: '' }, { object: 'list' }], ['notion', 'notion_create_page', validArgs.notion_create_page, {}],
    ['airtable', 'airtable_records', { baseId, tableId }, {}], ['airtable', 'airtable_create_record', validArgs.airtable_create_record, {}],
  ]) {
    const { adapter } = use(id, [response]); await rejectsCode(adapter.run(name, args), 'UPSTREAM_ERROR');
  }
  for (const id of ['github', 'slack', 'notion', 'airtable']) {
    const { adapter } = use(id, [id === 'slack' ? { ok: true } : {}]); await rejectsCode(adapter.test(), 'UPSTREAM_ERROR');
  }
});

test('known server tokens are redacted in projected strings, field names, URLs and account labels', async () => {
  const secret = credentials.GITHUB_TOKEN;
  const { adapter } = use('airtable', [
    { bases: [{ name: secret }] },
    { records: [{ id: 'rec123', fields: { [secret]: `${secret} / ${encodeURIComponent(secret)} / ${Buffer.from(secret).toString('base64')}`, Authorization: 'must drop', Nested: { token: 'must drop', safe: credentials.NOTION_TOKEN } } }] },
  ]);
  const label = await adapter.test();
  const result = await adapter.run('airtable_records', { baseId, tableId });
  const json = JSON.stringify({ label, result });
  for (const token of Object.values(credentials)) assert.ok(!json.includes(token));
  assert.ok(!json.includes(Buffer.from(secret).toString('base64')));
  assert.ok(!json.includes('must drop'));
  assert.ok(json.includes('[redacted]'));
  assert.deepEqual(label, { accountLabel: 'Airtable · [redacted]' });
  const gh = use('github', [[{ name: secret, html_url: `https://github.com/org/repo?token=${secret}` }]]);
  assert.equal((await gh.adapter.run('github_repositories', {})).repositories[0].url, null);
});

test('Notion rich-text redacts credentials before a segment preview boundary can split them', async () => {
  const secret = credentials.NOTION_TOKEN;
  const title = 'x'.repeat(1980) + secret;
  const { adapter } = use('notion', [{ results: [{ ...identityPage, properties: { title: { type: 'title', title: [{ plain_text: title }] } } }], has_more: false }]);
  const result = await adapter.run('notion_search', { query: '' });
  assert.ok(result.pages[0].title.endsWith('[redacted]'));
  assert.ok(!JSON.stringify(result).includes(secret.slice(0, 20)));
});

test('projected URLs reject non-HTTPS/javascript/credential URLs without any follow-up request', async () => {
  for (const url of ['javascript:alert(1)', 'http://github.com/org/repo', 'https://user:password@github.com/org/repo', 'not a URL']) {
    const { adapter, calls } = use('github', [[{ html_url: url }]]);
    const result = await adapter.run('github_repositories', {});
    assert.equal(result.repositories[0].url, null); assert.equal(calls.length, 1);
  }
});

test('large nested JSON output is still useful bounded JSON <=64KiB and each array <=20', async () => {
  const nested = Object.fromEntries(tooMany().map(i => [`field${i}`, tooMany().map(() => ({ value: '🌍'.repeat(2000), deep: { value: 'x'.repeat(3000) } }))]));
  const { adapter } = use('airtable', [{ records: tooMany().map(() => ({ id: 'rec123', fields: nested })), offset: 'hidden' }]);
  const result = await adapter.run('airtable_records', { baseId, tableId });
  assert.ok(result.records.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 65536);
  const visit = v => { if (Array.isArray(v)) { assert.ok(v.length <= 20); v.forEach(visit); } else if (v && typeof v === 'object') { assert.ok(Object.keys(v).length <= 20); Object.values(v).forEach(visit); } };
  visit(result);
});

test('already aborted and invalid signals do not call HTTP; in-flight abort is safely propagated', async () => {
  const { adapter, calls } = use('github', []);
  const controller = new AbortController(); controller.abort();
  await rejectsCode(adapter.test(controller.signal), 'CANCELLED');
  await rejectsCode(adapter.run('github_repositories', {}, controller.signal), 'CANCELLED');
  await rejectsCode(adapter.test({ aborted: false }), 'INVALID_ARGUMENTS');
  await rejectsCode(adapter.run('github_repositories', {}, {}), 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 0);
  const during = new AbortController();
  const second = use('github', [() => { during.abort(); throw Error(`Do not expose ${credentials.GITHUB_TOKEN}`); }]);
  await rejectsCode(second.adapter.run('github_repositories', {}, during.signal), 'CANCELLED');
  assert.equal(second.calls.length, 1);
});
