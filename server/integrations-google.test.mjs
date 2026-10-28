import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleIntegrations } from './integrations-google.mjs';

// Injected parsed-JSON mocks only. No process.env, real Google calls or sends.
const ACCESS = 'test-only-access-token_987654321';
const REFRESHED = 'test-only-refreshed-token_123456789';
const credentials = { GOOGLE_ACCESS_TOKEN: ACCESS };
const refreshCredentials = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret_123456789',
  GOOGLE_REFRESH_TOKEN: 'test-refresh-secret_123456789',
};
const hosts = new Set(['gmail.googleapis.com', 'www.googleapis.com', 'calendar.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'oauth2.googleapis.com']);
const draft = { to: 'ada.researcher+notes@example.com', subject: 'Résumé — river notes', body: 'Hello Ada,\nHere are the notes.\n河流 💧' };
const eventArgs = { calendarId: 'primary', summary: 'Research', start: '2026-11-01T09:00:00-05:00', end: '2026-11-01T10:00:00-05:00' };
const b64 = text => Buffer.from(text).toString('base64url');
const code = expected => error => error instanceof Error && error.name === 'GoogleIntegrationError' && error.code === expected;
const bounded = value => { assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024); return value; };
function queue(...responses) {
  const calls = [];
  const http = async (url, options = {}) => {
    const u = new URL(url);
    assert.equal(u.protocol, 'https:'); assert.ok(hosts.has(u.hostname));
    assert.equal(u.username, ''); assert.equal(u.password, ''); assert.equal(u.hash, ''); assert.equal(u.port, '');
    assert.equal(u.searchParams.has('access_token'), false);
    assert.equal(u.searchParams.has('refresh_token'), false);
    assert.equal(u.searchParams.has('client_secret'), false);
    assert.ok(options.method === 'GET' || options.method === 'POST');
    if (u.hostname !== 'oauth2.googleapis.com') assert.ok(options.headers.Authorization?.startsWith('Bearer '));
    assert.ok(!(options.form && options.body));
    calls.push({ url, u, options });
    assert.ok(responses.length, `unexpected request ${u.pathname}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, options) : structuredClone(next);
  };
  return { calls, http };
}
function runtime(transport, creds = credentials) {
  const providers = createGoogleIntegrations({ credentials: creds, http: transport.http });
  return Object.fromEntries(providers.map(provider => [provider.id.replace('google-', ''), provider]));
}
const upstreamError = status => Object.assign(new Error(`private upstream diagnostic ${ACCESS} ${refreshCredentials.GOOGLE_REFRESH_TOKEN}`), { status });

test('catalog has exactly the five server-token providers and correctly typed strict operation schemas', () => {
  const providers = createGoogleIntegrations({ credentials, http: async () => ({}) });
  assert.deepEqual(providers.map(p => [p.id, p.name]), [['google-gmail', 'Gmail'], ['google-calendar', 'Google Calendar'], ['google-drive', 'Google Drive'], ['google-docs', 'Google Docs'], ['google-sheets', 'Google Sheets']]);
  const writes = [];
  for (const provider of providers) {
    assert.equal(provider.configured, true);
    assert.deepEqual(provider.env, ['GOOGLE_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    assert.equal(typeof provider.test, 'function'); assert.equal(typeof provider.run, 'function');
    for (const op of provider.operations) {
      assert.ok(['read', 'write'].includes(op.type));
      assert.equal(op.parameters.type, 'object'); assert.equal(op.parameters.additionalProperties, false);
      assert.ok(Array.isArray(op.parameters.required));
      assert.ok(op.parameters.required.every(key => Object.hasOwn(op.parameters.properties, key)));
      if (op.type === 'write') { writes.push(op.name); assert.match(op.description, /confirmation/i); }
    }
  }
  assert.deepEqual(writes, ['gmail_create_draft', 'google_calendar_create_event', 'google_docs_append', 'google_sheets_append']);
  assert.doesNotMatch(JSON.stringify(providers), new RegExp(ACCESS));
  assert.ok(providers.every(p => p.operations.every(op => !/send_message|send_mail|fetch_url|request_url/.test(op.name))));
  assert.match(providers[0].operations.find(op => op.type === 'write').description, /does NOT send/i);
});

test('missing/partial/invalid server credentials fail test and run, never fake connection or fetch fallback', async () => {
  for (const creds of [{}, { GOOGLE_CLIENT_ID: 'test' }, { GOOGLE_CLIENT_ID: 'test', GOOGLE_REFRESH_TOKEN: 'test' }, { GOOGLE_ACCESS_TOKEN: 'bad\r\nheader' }, { GOOGLE_ACCESS_TOKEN: '\ud800' }, { GOOGLE_ACCESS_TOKEN: 'x'.repeat(9000) }, { GOOGLE_ACCESS_TOKEN: {} }, null]) {
    const transport = queue(); const providers = runtime(transport, creds);
    for (const provider of Object.values(providers)) {
      assert.equal(provider.configured, false);
      await assert.rejects(provider.test(), code('NOT_CONFIGURED'));
    }
    await assert.rejects(providers.gmail.run('gmail_list_messages', {}), code('NOT_CONFIGURED'));
    assert.equal(transport.calls.length, 0);
  }
  for (const transport of [undefined, null, {}]) {
    const providers = createGoogleIntegrations({ credentials, http: transport });
    assert.ok(providers.every(p => !p.configured));
    await assert.rejects(providers[0].test(), code('NOT_CONFIGURED'));
  }
  // A process.env-like credential bag may have a non-Object.prototype prototype.
  const envBag = Object.assign(Object.create({ ignored: true }), credentials);
  assert.equal(createGoogleIntegrations({ credentials: envBag, http: async () => ({}) })[0].configured, true);
  const getter = Object.defineProperty({}, 'GOOGLE_ACCESS_TOKEN', { get() { throw new Error('must not invoke'); } });
  assert.equal(createGoogleIntegrations({ credentials: getter, http: async () => ({}) })[0].configured, false);
});

test('static bearer is header-only, takes precedence, and test names exactly the permission actually checked', async () => {
  const transport = queue({ emailAddress: 'ada@example.com', access_token: 'discard-me' }, { user: { emailAddress: 'ada@example.com', displayName: 'Ada' } }, { summary: 'Ada calendar', timeZone: 'Etc/UTC' });
  const r = runtime(transport, { ...refreshCredentials, ...credentials });
  assert.match((await r.gmail.test()).accountLabel, /ada@example.com.*profile checked.*not verified/);
  assert.match((await r.drive.test()).accountLabel, /ada@example.com.*identity checked/);
  assert.match((await r.calendar.test()).accountLabel, /Ada calendar.*read checked.*writes not verified/);
  assert.deepEqual(transport.calls.map(c => c.u.pathname), ['/gmail/v1/users/me/profile', '/drive/v3/about', '/calendar/v3/calendars/primary/events']);
  assert.ok(transport.calls.every(c => c.options.method === 'GET' && c.options.headers.Authorization === `Bearer ${ACCESS}`));
  assert.equal(transport.calls[0].u.searchParams.get('fields'), 'emailAddress');
  assert.equal(transport.calls[2].u.origin, 'https://www.googleapis.com');
  assert.equal(transport.calls[2].u.searchParams.get('maxResults'), '1');
});

test('refresh uses URL-encoded form and shared single-flight cached bearer across all provider closures', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const transport = queue(() => pending, { emailAddress: 'ada@example.com' }, { user: { emailAddress: 'ada@example.com' } }, { messages: [] });
  const r = runtime(transport, refreshCredentials);
  const first = r.gmail.test(), second = r.drive.test();
  await Promise.resolve();
  assert.equal(transport.calls.length, 1);
  release({ access_token: REFRESHED, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rotated-private-token' });
  const results = await Promise.all([first, second]);
  await r.gmail.run('gmail_list_messages', {});
  const token = transport.calls[0];
  assert.equal(token.url, 'https://oauth2.googleapis.com/token'); assert.equal(token.options.method, 'POST');
  assert.deepEqual(token.options.form, { grant_type: 'refresh_token', client_id: refreshCredentials.GOOGLE_CLIENT_ID, client_secret: refreshCredentials.GOOGLE_CLIENT_SECRET, refresh_token: refreshCredentials.GOOGLE_REFRESH_TOKEN });
  assert.equal(token.options.body, undefined); assert.equal(token.options.headers.Authorization, undefined);
  assert.equal(transport.calls.filter(c => c.u.hostname === 'oauth2.googleapis.com').length, 1);
  assert.ok(transport.calls.slice(1).every(c => c.options.headers.Authorization === `Bearer ${REFRESHED}`));
  for (const secret of [...Object.values(refreshCredentials), REFRESHED, 'rotated-private-token']) assert.ok(!JSON.stringify(results).includes(secret));
});

test('refresh token expiry is respected, without real timers or write retries', async t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  const transport = queue({ access_token: REFRESHED, expires_in: 60 }, { messages: [] }, { messages: [] }, { access_token: 'second-refreshed-token', expires_in: 3600 }, { messages: [] });
  const r = runtime(transport, refreshCredentials);
  await r.gmail.run('gmail_list_messages', {});
  now += 20_000; await r.gmail.run('gmail_list_messages', {});
  now += 50_000; await r.gmail.run('gmail_list_messages', {});
  assert.equal(transport.calls.filter(c => c.u.hostname === 'oauth2.googleapis.com').length, 2);
  assert.equal(transport.calls.at(-1).options.headers.Authorization, 'Bearer second-refreshed-token');
});

test('token refresh failures/malformed responses are safe, never logged/returned as token data', async () => {
  for (const response of [upstreamError(401), { error: 'invalid_grant', error_description: refreshCredentials.GOOGLE_REFRESH_TOKEN }]) {
    const transport = queue(response); const r = runtime(transport, refreshCredentials);
    await assert.rejects(r.gmail.test(), error => { assert.equal(error.code, 'AUTH_FAILED'); assert.ok(!error.message.includes(refreshCredentials.GOOGLE_REFRESH_TOKEN)); return true; });
    assert.equal(transport.calls.length, 1);
  }
  for (const response of [{}, { access_token: '\r\nmalicious', expires_in: 3600 }, { access_token: ACCESS, expires_in: 0 }, { access_token: ACCESS, expires_in: '3600' }, { access_token: ACCESS, expires_in: 3600, token_type: {} }, { access_token: ACCESS, expires_in: 3600, token_type: 'Basic' }]) {
    const transport = queue(response); const r = runtime(transport, refreshCredentials);
    await assert.rejects(r.gmail.test(), code('INVALID_RESPONSE'));
    assert.equal(transport.calls.length, 1);
  }
});

test('Google auth/scope/resource/rate errors fail closed and never echo private upstream diagnostics', async () => {
  for (const [status, expected] of [[401, 'AUTH_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_ERROR']]) {
    for (const returned of [false, true]) {
      const transport = queue(returned ? { error: { code: status, message: ACCESS } } : upstreamError(status));
      const r = runtime(transport);
      await assert.rejects(r.gmail.run('gmail_create_draft', draft), error => { assert.equal(error.code, expected); assert.ok(!error.message.includes(ACCESS)); assert.ok(!error.message.includes(refreshCredentials.GOOGLE_REFRESH_TOKEN)); return true; });
      assert.equal(transport.calls.length, 1, 'no write retry');
    }
  }
  const r = runtime(queue(Object.assign(new Error(ACCESS), { name: 'TimeoutError' })));
  await assert.rejects(r.gmail.test(), code('UPSTREAM_TIMEOUT'));
  for (const data of [null, [], 'a string']) await assert.rejects(runtime(queue(data)).drive.test(), code('INVALID_RESPONSE'));
  for (const service of ['gmail', 'drive', 'calendar']) await assert.rejects(runtime(queue({}))[service].test(), code('INVALID_RESPONSE'));
});

test('Docs and Sheets test discover an existing file and verify the actual service read, never a write', async () => {
  const transport = queue({ files: [{ id: 'doc_123', name: 'Notes' }] }, { documentId: 'doc_123', title: 'Notes' }, { files: [{ id: 'sheet_123', name: 'Data' }] }, { spreadsheetId: 'sheet_123', properties: { title: 'Data' } });
  const r = runtime(transport);
  assert.match((await r.docs.test()).accountLabel, /Notes.*Docs read checked on one file; writes not verified/);
  assert.match((await r.sheets.test()).accountLabel, /Data.*Sheets read checked on one file; writes not verified/);
  assert.deepEqual(transport.calls.map(c => c.u.hostname), ['www.googleapis.com', 'docs.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']);
  assert.equal(transport.calls[0].u.searchParams.get('q'), "trashed = false and mimeType = 'application/vnd.google-apps.document'");
  assert.equal(transport.calls[0].u.searchParams.get('pageSize'), '1');
  assert.equal(transport.calls[1].u.searchParams.get('fields'), 'documentId,title');
  assert.equal(transport.calls[3].u.searchParams.get('fields'), 'spreadsheetId,properties(title)');
  assert.ok(transport.calls.every(c => c.options.method === 'GET' && c.options.body === undefined));
});

test('Docs/Sheets test never mistakes discovery/empty listings for checked service scopes', async () => {
  for (const service of ['docs', 'sheets']) {
    for (const data of [{ files: [] }, {}, { files: [{ id: 'https://evil.example/resource' }] }]) {
      const transport = queue(data); await assert.rejects(runtime(transport)[service].test(), code('MISSING_TEST_RESOURCE'));
      assert.equal(transport.calls.length, 1);
    }
    const transport = queue({ files: [{ id: 'file_123' }] }, upstreamError(403));
    await assert.rejects(runtime(transport)[service].test(), code('PERMISSION_DENIED'));
    assert.equal(transport.calls.length, 2);
    await assert.rejects(runtime(queue({ files: [{ id: 'file_123' }] }, { documentId: 'wrong', spreadsheetId: 'wrong' }))[service].test(), code('INVALID_RESPONSE'));
  }
});

test('strict argument boundaries reject extra keys, accessors, foreign operations and mutable public schema attacks', async () => {
  const transport = queue(); const r = runtime(transport);
  const schema = r.gmail.operations[0].parameters;
  schema.additionalProperties = true; schema.properties.url = { type: 'string' }; schema.properties.query.maxLength = 10000;
  const getter = Object.defineProperty({}, 'query', { enumerable: true, get() { throw new Error('must not execute getter'); } });
  const hidden = Object.defineProperty({}, 'query', { value: 'hidden', enumerable: false });
  for (const args of [undefined, null, [], 'text', { url: 'https://evil.example' }, { query: 'x', credentials: ACCESS }, { query: 'x'.repeat(501) }, { query: '' }, { query: '\n' }, { query: '\ud800' }, { query: 'a\u0000b' }, getter, hidden, { [Symbol('extra')]: 'x' }, Object.create({ query: 'inherited' })]) await assert.rejects(r.gmail.run('gmail_list_messages', args), code('INVALID_ARGUMENTS'));
  for (const op of ['gmail_send_message', 'fetch_url', 'google_docs_append', '__proto__']) await assert.rejects(r.gmail.run(op, {}), code('UNKNOWN_OPERATION'));
  for (const id of ['a/b', '..', 'https://evil.example', '//evil.example', 'abc?token=x', 'abc#fragment', 'a%2Fb', 'x'.repeat(201), '\r\n']) {
    await assert.rejects(r.gmail.run('gmail_read_message', { messageId: id }), code('INVALID_ARGUMENTS'));
    await assert.rejects(r.docs.run('google_docs_read', { documentId: id }), code('INVALID_ARGUMENTS'));
    await assert.rejects(r.sheets.run('google_sheets_read', { spreadsheetId: id, range: 'A1:B2' }), code('INVALID_ARGUMENTS'));
  }
  assert.equal(transport.calls.length, 0);
  const good = runtime(queue({ messages: [] }));
  assert.deepEqual((await good.gmail.run('gmail_list_messages', Object.create(null))).messages, []);
});

test('Gmail list uses maxResults=20 and bounded selected IDs, never claims snippets were listed', async () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: `message_${i}`, threadId: `thread_${i}`, raw: 'binary', access_token: ACCESS }));
  const transport = queue({ messages, resultSizeEstimate: 100, nextPageToken: 'unexposed-page-token', access_token: ACCESS });
  const result = bounded(await runtime(transport).gmail.run('gmail_list_messages', { query: 'is:unread from:ada@example.com' }));
  assert.equal(result.messages.length, 20); assert.equal(result.truncated, true); assert.equal(result.resultSizeEstimate, 100);
  assert.deepEqual(Object.keys(result.messages[0]), ['id', 'threadId']);
  assert.equal(transport.calls[0].u.searchParams.get('q'), 'is:unread from:ada@example.com');
  assert.equal(transport.calls[0].u.searchParams.get('maxResults'), '20');
  assert.ok(!JSON.stringify(result).includes('unexposed-page-token')); assert.ok(!JSON.stringify(result).includes(ACCESS));
});

test('Gmail message projects bounded UTF-8 text, excludes binary/attachments/raw data and redacts reflected credentials', async () => {
  const message = { id: 'message_123', threadId: 'thread_123', snippet: `Secret ${ACCESS}`, raw: 'discard-raw', payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'ada@example.com' }, { name: 'Subject', value: 'River notes' }, { name: 'Authorization', value: ACCESS }], parts: [
      { mimeType: 'text/plain', body: { data: b64('Hello, 河流 💧') } },
      { mimeType: 'text/html', body: { data: b64('<script>untrusted()</script><b>Notes</b>') } },
      { mimeType: 'image/png', body: { attachmentId: 'secret-attachment-id' } },
      { mimeType: 'text/plain', filename: 'private.txt', body: { data: b64('discard-attachment') } },
      { mimeType: 'text/plain', headers: [{ name: 'Content-Disposition', value: 'attachment; filename=private.txt' }], body: { data: b64('discard-attachment') } },
      { mimeType: 'text/plain', body: { data: Buffer.from([0xff, 0xfe]).toString('base64url') } },
      { mimeType: 'text/plain', body: { data: b64('binary\u0000data') } },
      { mimeType: 'text/plain', body: { data: '%%invalid' } },
    ],
  } };
  const transport = queue(message); const result = bounded(await runtime(transport).gmail.run('gmail_read_message', { messageId: 'message_123' }));
  assert.equal(result.textParts.length, 2); assert.equal(result.textParts[0].text, 'Hello, 河流 💧');
  assert.equal(result.textParts[1].mimeType, 'text/html'); assert.ok(result.textParts[1].text.startsWith('<script>'));
  assert.equal(result.omittedParts, 6); assert.equal(result.headers.subject, 'River notes');
  assert.match(result.snippet, /\[redacted\]/);
  for (const value of [ACCESS, 'discard-raw', 'secret-attachment-id', 'discard-attachment', 'Authorization', 'body.data']) assert.ok(!JSON.stringify(result).includes(value));
  assert.equal(transport.calls.length, 1, 'never fetch attachment IDs');
  assert.equal(transport.calls[0].u.searchParams.get('format'), 'full');
});

test('Gmail UTF-8 projection is bounded at byte/code-point boundaries and MIME nesting/part limits', async () => {
  const parts = Array.from({ length: 40 }, () => ({ mimeType: 'text/plain', body: { data: b64('💧'.repeat(5000)) } }));
  const r = runtime(queue({ id: 'message_123', payload: { mimeType: 'multipart/mixed', parts } }));
  const result = bounded(await r.gmail.run('gmail_read_message', { messageId: 'message_123' }));
  assert.equal(result.truncated, true);
  assert.ok(result.textParts.length <= 20);
  assert.ok(result.textParts.reduce((total, p) => total + Buffer.byteLength(p.text), 0) <= 24000);
  assert.ok(result.textParts.every(p => p.text.isWellFormed() && !p.text.includes('\ufffd')));
  let payload = { mimeType: 'text/plain', body: { data: b64('not reached') } };
  for (let i = 0; i < 30; i++) payload = { mimeType: 'multipart/mixed', parts: [payload] };
  const deep = await runtime(queue({ id: 'message_123', payload })).gmail.run('gmail_read_message', { messageId: 'message_123' });
  assert.equal(deep.truncated, true); assert.deepEqual(deep.textParts, []);
});

test('draft MIME is valid UTF-8 encoded RFC message, created via drafts endpoint only, and never sent', async () => {
  const transport = queue({ id: 'draft_123', message: { id: 'message_123', threadId: 'thread_123', raw: 'discard-me' }, access_token: ACCESS });
  const result = await runtime(transport).gmail.run('gmail_create_draft', draft);
  const { u, options } = transport.calls[0];
  assert.equal(u.pathname, '/gmail/v1/users/me/drafts'); assert.equal(options.method, 'POST');
  assert.deepEqual(Object.keys(options.body), ['message']); assert.deepEqual(Object.keys(options.body.message), ['raw']);
  assert.match(options.body.message.raw, /^[A-Za-z0-9_-]+$/);
  const raw = Buffer.from(options.body.message.raw, 'base64url').toString('utf8');
  const [headers, body] = raw.split('\r\n\r\n');
  assert.match(headers, /^To: ada.researcher\+notes@example.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(headers, /MIME-Version: 1.0/); assert.match(headers, /Content-Type: text\/plain; charset=UTF-8/); assert.match(headers, /Content-Transfer-Encoding: base64/);
  const subject = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(subject, draft.subject);
  assert.equal(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'), draft.body.replace(/\n/g, '\r\n'));
  assert.deepEqual(result, { id: 'draft_123', messageId: 'message_123', threadId: 'thread_123', status: 'draft', sent: false });
  assert.equal(transport.calls.length, 1); assert.ok(!u.pathname.includes('send'));
});

test('draft rejects header injection, multiple addresses, invalid mailboxes and unsafe payloads before HTTP', async () => {
  const transport = queue(); const r = runtime(transport);
  for (const to of ['ada@example.com\r\nBcc: exfil@example.com', 'ada@example.com,other@example.com', 'Ada <ada@example.com>', 'ada@example.com other@example.com', 'ada@@example.com', 'ada@localhost', '.ada@example.com', 'ada..a@example.com', 'ada@-example.com', `${'a'.repeat(65)}@example.com`]) await assert.rejects(r.gmail.run('gmail_create_draft', { ...draft, to }), code('INVALID_ARGUMENTS'));
  for (const subject of ['Subject\r\nBcc: other@example.com', 'Subject\nInjected', 'x'.repeat(201), '\ud800']) await assert.rejects(r.gmail.run('gmail_create_draft', { ...draft, subject }), code('INVALID_ARGUMENTS'));
  await assert.rejects(r.gmail.run('gmail_create_draft', { ...draft, send: true }), code('INVALID_ARGUMENTS'));
  await assert.rejects(r.gmail.run('gmail_create_draft', { ...draft, body: 'x'.repeat(16001) }), code('INVALID_ARGUMENTS'));
  assert.equal(transport.calls.length, 0);
});

test('calendar lists next 20 ordered events and safely encodes calendar email IDs', async () => {
  const transport = queue({ summary: 'Research', timeZone: 'America/New_York', items: Array.from({ length: 25 }, (_, i) => ({ id: `event_${i}`, summary: 'Notes', status: 'confirmed', start: { dateTime: eventArgs.start }, end: { dateTime: eventArgs.end }, attendees: [{ email: 'discard@example.com' }], htmlLink: 'https://evil.example' })), nextPageToken: 'not-returned' });
  const result = bounded(await runtime(transport).calendar.run('google_calendar_events', { calendarId: 'en.usa#holiday@group.v.calendar.google.com' }));
  const { u } = transport.calls[0];
  assert.match(u.pathname, /en.usa%23holiday%40group.v.calendar.google.com\/events$/);
  assert.equal(u.searchParams.get('singleEvents'), 'true'); assert.equal(u.searchParams.get('orderBy'), 'startTime'); assert.equal(u.searchParams.get('maxResults'), '20');
  assert.ok(Number.isFinite(Date.parse(u.searchParams.get('timeMin'))));
  assert.equal(result.events.length, 20); assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('evil.example')); assert.ok(!JSON.stringify(result).includes('discard@example.com'));
});

test('calendar event writes valid offset timestamps, no attendees, reminders or notification sends', async () => {
  const transport = queue({ id: 'event_123', ...eventArgs, start: { dateTime: eventArgs.start }, end: { dateTime: eventArgs.end } });
  const result = await runtime(transport).calendar.run('google_calendar_create_event', eventArgs);
  const { u, options } = transport.calls[0];
  assert.equal(u.origin, 'https://www.googleapis.com'); assert.equal(u.pathname, '/calendar/v3/calendars/primary/events'); assert.equal(options.method, 'POST');
  assert.equal(u.searchParams.get('sendUpdates'), 'none');
  assert.deepEqual(options.body, { summary: eventArgs.summary, start: { dateTime: eventArgs.start }, end: { dateTime: eventArgs.end }, reminders: { useDefault: false } });
  assert.equal(result.id, 'event_123'); assert.equal(result.start.dateTime, eventArgs.start);
  const noCalls = queue(); const r = runtime(noCalls);
  for (const start of ['2026-02-30T09:00:00Z', '2025-02-29T09:00:00Z', '2026-11-01T25:00:00Z', '2026-11-01T09:61:00Z', '2026-11-01T09:00:60Z', '2026-11-01T09:00:00+24:00', '2026-11-01T09:00:00', '2026-11-01', 'https://evil.example']) await assert.rejects(r.calendar.run('google_calendar_create_event', { ...eventArgs, start }), code('INVALID_ARGUMENTS'));
  for (const args of [{ ...eventArgs, end: eventArgs.start }, { ...eventArgs, end: '2026-10-01T09:00:00Z' }, { ...eventArgs, attendees: ['other@example.com'] }, { ...eventArgs, calendarId: 'https://evil.example' }, { ...eventArgs, calendarId: 'primary?sendUpdates=all' }]) await assert.rejects(r.calendar.run('google_calendar_create_event', args), code('INVALID_ARGUMENTS'));
  assert.equal(noCalls.calls.length, 0);
});

test('Drive queries stay fixed-origin, non-trashed, at 20 results with no unsafe links', async () => {
  const transport = queue({ files: Array.from({ length: 24 }, (_, i) => ({ id: `file_${i}`, name: 'Notes', mimeType: 'text/plain', modifiedTime: '2026-10-28T00:00:00Z', webViewLink: 'javascript:evil()', thumbnailLink: 'https://evil.example', permissions: [ACCESS] })), incompleteSearch: true });
  const query = "name contains 'https://evil.example/?x=1&access_token=bogus'";
  const result = bounded(await runtime(transport).drive.run('google_drive_files', { query }));
  const { u } = transport.calls[0];
  assert.equal(u.origin, 'https://www.googleapis.com'); assert.equal(u.pathname, '/drive/v3/files');
  assert.equal(u.searchParams.get('q'), `trashed = false and (${query})`); assert.equal(u.searchParams.get('pageSize'), '20');
  assert.equal(result.files.length, 20); assert.equal(result.truncated, true);
  assert.deepEqual(Object.keys(result.files[0]), ['id', 'name', 'mimeType', 'modifiedTime']);
  assert.ok(!JSON.stringify(result).includes('evil')); assert.ok(!JSON.stringify(result).includes(ACCESS));
});

test('Docs read projects FIRST-tab paragraph/table text only; bounded and secret-redacted', async () => {
  const content = [
    { paragraph: { elements: [{ textRun: { content: 'Hello\n' } }, { inlineObjectElement: { inlineObjectId: 'image-secret' } }] } },
    { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: `Table ${ACCESS}\n` } }] } }] }] }] } },
    { tableOfContents: { content: [{ paragraph: { elements: [{ textRun: { content: 'Contents\n' } }] } }] } },
  ];
  const transport = queue({ documentId: 'doc_123', title: 'Notes', body: { content }, tabs: [{ text: 'not-returned-tab' }], inlineObjects: { image: { url: 'https://evil.example' } }, revisionId: 'discard-revision' });
  const result = await runtime(transport).docs.run('google_docs_read', { documentId: 'doc_123' });
  assert.deepEqual(result, { documentId: 'doc_123', title: 'Notes', text: 'Hello\nTable [redacted]\nContents\n', tab: 'first', truncated: false });
  assert.equal(transport.calls[0].u.searchParams.get('includeTabsContent'), 'false');
  assert.equal(transport.calls[0].u.searchParams.get('fields'), 'documentId,title,body(content)');
  const large = bounded(await runtime(queue({ documentId: 'doc_123', body: { content: [{ paragraph: { elements: [{ textRun: { content: '河'.repeat(30000) } }] } }] } })).docs.run('google_docs_read', { documentId: 'doc_123' }));
  assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.text) <= 24000); assert.ok(large.text.isWellFormed());
});

test('Docs append only issues one end-of-body insertText batchUpdate, no arbitrary requests', async () => {
  const transport = queue({ documentId: 'doc_123', replies: [{ dangerous: 'discard-me' }], access_token: ACCESS });
  const result = await runtime(transport).docs.run('google_docs_append', { documentId: 'doc_123', text: '\nNotes 💧\n' });
  const { u, options } = transport.calls[0];
  assert.equal(u.origin, 'https://docs.googleapis.com'); assert.equal(u.pathname, '/v1/documents/doc_123:batchUpdate');
  assert.equal(options.method, 'POST'); assert.deepEqual(options.body, { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nNotes 💧\n' } }] });
  assert.deepEqual(result, { documentId: 'doc_123', appendedCharacters: 9, tab: 'first' });
  const noCalls = queue(); const r = runtime(noCalls);
  await assert.rejects(r.docs.run('google_docs_append', { documentId: 'doc_123', text: 'Notes', requests: [{ deleteContentRange: {} }] }), code('INVALID_ARGUMENTS'));
  assert.equal(noCalls.calls.length, 0);
});

test('Sheets read uses explicit A1 range and formatted strings, limits output, omits auth/grid metadata', async () => {
  const range = "'Bob''s Data'!A1:C20";
  const transport = queue({ range, values: [['Title', 42, true], [], [null, '=SUM(A1:A2)', ACCESS]], access_token: ACCESS, spreadsheetUrl: 'https://evil.example' });
  const result = await runtime(transport).sheets.run('google_sheets_read', { spreadsheetId: 'sheet_123', range });
  assert.deepEqual(result, { spreadsheetId: 'sheet_123', range, values: [['Title', '42', 'true'], [], ['', '=SUM(A1:A2)', '[redacted]']], truncated: false });
  const { u } = transport.calls[0];
  assert.equal(decodeURIComponent(u.pathname), `/v4/spreadsheets/sheet_123/values/${range}`);
  assert.equal(u.searchParams.get('majorDimension'), 'ROWS'); assert.equal(u.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
  const rows = Array.from({ length: 150 }, () => Array.from({ length: 30 }, () => '💧'.repeat(2000)));
  const large = bounded(await runtime(queue({ range: 'A1:Z20', values: rows })).sheets.run('google_sheets_read', { spreadsheetId: 'sheet_123', range: 'A1:Z20' }));
  assert.equal(large.truncated, true); assert.ok(large.values.length <= 100); assert.ok(large.values.every(row => row.length <= 26));
  assert.ok(large.values.flat().reduce((total, value) => total + Buffer.byteLength(value), 0) <= 24000);
});

test('Sheets append uses RAW, INSERT_ROWS and literal strings, including formula-like values, without response values', async () => {
  const args = { spreadsheetId: 'sheet_123', range: 'Data!A1:C20', rows: [['=IMPORTDATA("https://evil.example")', '+1+1', '@SUM(A1)'], ['-1', '000123', '']] };
  const transport = queue({ spreadsheetId: 'sheet_123', tableRange: 'Data!A1:C5', updates: { updatedRange: 'Data!A6:C7', updatedRows: 2, updatedColumns: 3, updatedCells: 6, updatedData: { values: [[ACCESS]] } } });
  const result = await runtime(transport).sheets.run('google_sheets_append', args);
  const { u, options } = transport.calls[0];
  assert.equal(decodeURIComponent(u.pathname), '/v4/spreadsheets/sheet_123/values/Data!A1:C20:append');
  assert.equal(u.searchParams.get('valueInputOption'), 'RAW'); assert.equal(u.searchParams.get('insertDataOption'), 'INSERT_ROWS'); assert.equal(u.searchParams.get('includeValuesInResponse'), 'false');
  assert.deepEqual(options.body, { range: args.range, majorDimension: 'ROWS', values: args.rows });
  assert.deepEqual(result, { spreadsheetId: 'sheet_123', tableRange: 'Data!A1:C5', updatedRange: 'Data!A6:C7', updatedRows: 2, updatedColumns: 3, updatedCells: 6 });
  assert.ok(!JSON.stringify(result).includes(ACCESS));
});

test('A1 ranges and row matrices are strictly finite/rectangular/bounded; extra write controls rejected', async () => {
  const transport = queue(); const r = runtime(transport);
  for (const range of ['A:A', '1:10', 'Sheet1', 'NamedRange', 'A0', 'A1:B101', 'A1:AA1', 'A1:Z100', 'B2:A1', 'A2:A1', 'ZZZ1:ZZZZ1', 'A1:B2?key=secret', 'https://evil.example', 'Sheet!A1/B2', 'Sheet\nName!A1', 'A1;DELETE']) await assert.rejects(r.sheets.run('google_sheets_read', { spreadsheetId: 'sheet_123', range }), code('INVALID_ARGUMENTS'));
  const args = { spreadsheetId: 'sheet_123', range: 'A1:C20', rows: [['one']] };
  const sparse = []; sparse.length = 2;
  const extra = ['one']; extra.extra = 'disallowed';
  for (const rows of [[], sparse, [['one'], ['two', 'three']], [[42]], [[true]], [['x'.repeat(2001)]], Array.from({ length: 101 }, () => ['x']), [Array.from({ length: 27 }, () => 'x')], [extra], Array.from({ length: 50 }, () => Array.from({ length: 26 }, () => 'x'))]) await assert.rejects(r.sheets.run('google_sheets_append', { ...args, rows }), code('INVALID_ARGUMENTS'));
  await assert.rejects(r.sheets.run('google_sheets_append', { ...args, valueInputOption: 'USER_ENTERED' }), code('INVALID_ARGUMENTS'));
  await assert.rejects(r.sheets.run('google_sheets_append', { ...args, range: 'A1:A3', rows: [['one', 'two']] }), code('INVALID_ARGUMENTS'));
  assert.equal(transport.calls.length, 0);
});

test('validated inputs are snapshotted before awaiting credentials/HTTP, especially confirmed sheet rows', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const transport = queue(() => pending, { spreadsheetId: 'sheet_123', updates: { updatedRows: 1, updatedCells: 2 } });
  const r = runtime(transport, refreshCredentials);
  const args = { spreadsheetId: 'sheet_123', range: 'A1:B20', rows: [['approved', 'literal']] };
  const attempt = r.sheets.run('google_sheets_append', args);
  args.spreadsheetId = 'changed_id'; args.range = 'changed!A1:B2'; args.rows[0][0] = 'unapproved'; args.rows[0].push('unapproved');
  release({ access_token: REFRESHED, expires_in: 3600 });
  await attempt;
  assert.equal(decodeURIComponent(transport.calls[1].u.pathname), '/v4/spreadsheets/sheet_123/values/A1:B20:append');
  assert.deepEqual(transport.calls[1].options.body.values, [['approved', 'literal']]);
  const hidden = Object.defineProperty(['value'], '0', { value: 'value', enumerable: false });
  await assert.rejects(r.sheets.run('google_sheets_append', { spreadsheetId: 'sheet_123', range: 'A1:B2', rows: [hidden] }), code('INVALID_ARGUMENTS'));
});

test('reflected refresh secrets and current bearer are redacted from projected text, not only token endpoint output', async () => {
  const transport = queue({ access_token: REFRESHED, expires_in: 3600, token_type: 'Bearer' }, { files: [{ id: 'file_123', name: `${refreshCredentials.GOOGLE_CLIENT_SECRET} ${refreshCredentials.GOOGLE_REFRESH_TOKEN} ${REFRESHED}`, mimeType: 'text/plain' }] });
  const result = await runtime(transport, refreshCredentials).drive.run('google_drive_files', {});
  for (const secret of [...Object.values(refreshCredentials), REFRESHED]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.match(result.files[0].name, /\[redacted\]/);
});

test('cancellation is forwarded, pre-aborted signals make no HTTP requests, and invalid signals fail', async () => {
  const transport = queue(); const r = runtime(transport);
  const controller = new AbortController(); controller.abort();
  for (const provider of Object.values(r)) await assert.rejects(provider.test(controller.signal), code('CANCELLED'));
  await assert.rejects(r.gmail.run('gmail_list_messages', {}, controller.signal), code('CANCELLED'));
  await assert.rejects(r.gmail.test({ aborted: false }), code('INVALID_ARGUMENTS'));
  assert.equal(transport.calls.length, 0);
  const active = new AbortController();
  const passed = queue((_url, options) => { assert.equal(options.signal, active.signal); active.abort(); return { messages: [] }; });
  await assert.rejects(runtime(passed).gmail.run('gmail_list_messages', {}, active.signal), code('CANCELLED'));
  const abort = Object.assign(new Error('private'), { name: 'AbortError' });
  await assert.rejects(runtime(queue(abort)).gmail.test(), code('CANCELLED'));
});

test('aborted refresh wait is rejected without exposing secrets or caching an aborted response', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const transport = queue(() => pending);
  const r = runtime(transport, refreshCredentials); const controller = new AbortController();
  const attempt = r.gmail.test(controller.signal); controller.abort();
  await assert.rejects(attempt, code('CANCELLED'));
  release({ access_token: REFRESHED, expires_in: 3600 });
  // Let the already-handled refresh promise settle; it must not become unhandled.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0].options.signal, controller.signal);
});

test('malformed write success results fail rather than fabricate successful resource IDs', async () => {
  for (const [service, name, args] of [['gmail', 'gmail_create_draft', draft], ['calendar', 'google_calendar_create_event', eventArgs], ['docs', 'google_docs_append', { documentId: 'doc_123', text: 'Notes' }], ['sheets', 'google_sheets_append', { spreadsheetId: 'sheet_123', range: 'A1:B20', rows: [['one', 'two']] }]]) {
    const transport = queue({}); await assert.rejects(runtime(transport)[service].run(name, args), code('INVALID_RESPONSE'));
    assert.equal(transport.calls.length, 1);
  }
});
