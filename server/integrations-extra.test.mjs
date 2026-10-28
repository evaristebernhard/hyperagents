import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtraIntegrations } from './integrations-extra.mjs';

// Synthetic credentials only. Every request is intercepted; no fetch/network.
const credentials = Object.freeze({
  TELEGRAM_BOT_TOKEN: `123456:${'aB_9-'.repeat(7)}`,
  LINEAR_API_KEY: 'lin_api_UNIT_TEST_NOT_A_REAL_KEY',
  STRIPE_SECRET_KEY: 'rk_test_UNITTESTNOTAREALKEY123',
  ASANA_TOKEN: 'opaque:asana/test+token~unit',
});
const teamId = '9cfb482a-81e3-4154-b5b9-2c805e70a02d';
const projectId = '1234567890123456';
const issue = { id: teamId, identifier: 'ENG-1', title: 'Fix it', state: { name: 'Backlog' }, description: 'NOT_RETURNED', assignee: { email: 'NOT_RETURNED' } };
const task = { gid: '987654321', name: 'Task', completed: false, due_on: '2026-01-01', notes: 'NOT_RETURNED', assignee: { email: 'NOT_RETURNED' } };
function fixture(id, response, options = {}) {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, ...init });
    return typeof response === 'function' ? response(url, init) : structuredClone(response);
  };
  const providers = createExtraIntegrations({ credentials, http, ...options });
  return { provider: providers.find(provider => provider.id === id), providers, calls };
}
const errorCode = code => error => {
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  for (const secret of Object.values(credentials)) {
    assert.ok(!String(error).includes(secret));
    assert.ok(!error.stack.includes(secret));
  }
  return true;
};
const projectedIssue = { id: teamId, identifier: 'ENG-1', title: 'Fix it', state: 'Backlog' };
const projectedTask = { id: '987654321', name: 'Task', completed: false, dueOn: '2026-01-01' };

test('factory exports exactly four providers; configured is local and creates no requests', () => {
  const { providers, calls } = fixture('telegram');
  assert.deepEqual(providers.map(({ id, name, env, configured }) => ({ id, name, env, configured })), [
    { id: 'telegram', name: 'Telegram', env: ['TELEGRAM_BOT_TOKEN'], configured: true },
    { id: 'linear', name: 'Linear', env: ['LINEAR_API_KEY'], configured: true },
    { id: 'stripe', name: 'Stripe', env: ['STRIPE_SECRET_KEY'], configured: true },
    { id: 'asana', name: 'Asana', env: ['ASANA_TOKEN'], configured: true },
  ]);
  assert.equal(calls.length, 0);
  assert.deepEqual(providers.flatMap(p => p.operations.map(o => [o.name, o.type])), [
    ['telegram_updates', 'read'], ['telegram_send_message', 'write'],
    ['linear_issues', 'read'], ['linear_create_issue', 'write'],
    ['stripe_customers', 'read'], ['stripe_invoices', 'read'],
    ['asana_tasks', 'read'], ['asana_create_task', 'write'],
  ]);
  assert.ok(!JSON.stringify(providers).includes(credentials.TELEGRAM_BOT_TOKEN));
});

test('missing credentials or missing injected HTTP cannot use a global network fallback', async () => {
  const missing = fixture('telegram', null, { credentials: {} });
  for (const provider of missing.providers) {
    assert.equal(provider.configured, false);
    await assert.rejects(provider.test(), errorCode('NOT_CONFIGURED'));
    const args = provider.id === 'asana' ? { projectId } : {};
    await assert.rejects(provider.run(provider.operations[0].name, args), errorCode('NOT_CONFIGURED'));
  }
  assert.equal(missing.calls.length, 0);
  for (const provider of createExtraIntegrations({ credentials })) {
    assert.equal(provider.configured, false);
    await assert.rejects(provider.test(), errorCode('NOT_CONFIGURED'));
  }
  assert.ok(createExtraIntegrations().every(p => p.configured === false));
  assert.ok(createExtraIntegrations({ credentials: null }).every(p => p.configured === false));
});

test('credential shape rejects token URL injection/header injection while opaque Asana tokens are supported', async () => {
  for (const token of ['', '123:short', `${credentials.TELEGRAM_BOT_TOKEN}/getMe`, `${credentials.TELEGRAM_BOT_TOKEN}?x=1`, `${credentials.TELEGRAM_BOT_TOKEN}#fragment`, `${credentials.TELEGRAM_BOT_TOKEN}\n`, `1:${'x'.repeat(129)}`]) {
    const { provider, calls } = fixture('telegram', null, { credentials: { ...credentials, TELEGRAM_BOT_TOKEN: token } });
    assert.equal(provider.configured, false);
    await assert.rejects(provider.test(), errorCode('NOT_CONFIGURED'));
    assert.equal(calls.length, 0);
  }
  for (const env of Object.keys(credentials)) {
    for (const value of [' ', 'a\r\nInjected: true', 'key\n', 'x'.repeat(4097), 7, '\ud800']) {
      const providers = createExtraIntegrations({ credentials: { ...credentials, [env]: value }, http: async () => assert.fail('network') });
      assert.equal(providers.find(p => p.env[0] === env).configured, false);
    }
  }
  assert.equal(fixture('stripe', null, { credentials: { ...credentials, STRIPE_SECRET_KEY: 'pk_test_NOTASECRET123' } }).provider.configured, false);
  assert.equal(fixture('stripe', null, { credentials: { ...credentials, STRIPE_SECRET_KEY: 'sk_live_UNITTESTNOTREAL' } }).provider.configured, true);
  const withGetter = Object.defineProperty({}, 'ASANA_TOKEN', { get() { assert.fail('credential accessor'); } });
  assert.equal(fixture('asana', null, { credentials: withGetter }).provider.configured, false);
});

test('all connection tests use documented endpoints/auth and return only a bounded account label', async () => {
  const signal = new AbortController().signal;
  const cases = [
    ['telegram', { ok: true, result: { id: 123456, is_bot: true, username: 'unit_bot', first_name: 'Test', email: 'DROP' } }, `https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN}/getMe`, '@unit_bot'],
    ['linear', { data: { viewer: { id: teamId, name: 'Engineer', email: 'DROP' } } }, 'https://api.linear.app/graphql', 'Engineer'],
    ['stripe', { object: 'balance', livemode: false, available: [{ amount: 99999, source_types: { card: 99999 } }] }, 'https://api.stripe.com/v1/balance', 'Stripe (test mode)'],
    ['asana', { data: { gid: '123', name: 'Engineer', email: 'DROP' } }, 'https://app.asana.com/api/1.0/users/me?opt_fields=name', 'Engineer'],
  ];
  for (const [id, response, url, label] of cases) {
    const { provider, calls } = fixture(id, response);
    assert.deepEqual(await provider.test(signal), { accountLabel: label });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].signal, signal);
    assert.equal(calls[0].headers.Accept, 'application/json');
    if (id === 'linear') {
      assert.equal(calls[0].headers.Authorization, credentials.LINEAR_API_KEY);
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual(calls[0].body, { query: 'query IntegrationViewer { viewer { id name } }', variables: {} });
    } else {
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].body, undefined);
    }
    if (id === 'stripe') assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from(`${credentials.STRIPE_SECRET_KEY}:`).toString('base64')}`);
    if (id === 'asana') assert.equal(calls[0].headers.Authorization, `Bearer ${credentials.ASANA_TOKEN}`);
    if (id === 'telegram') assert.equal(calls[0].headers.Authorization, undefined);
  }
});

test('Telegram pending reads are limited and do not acknowledge or change update subscriptions', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ update_id: index + 1, message: { message_id: 5, date: 123, text: 'hello', chat: { id: -100123, type: 'supergroup', title: 'DROP' }, from: { id: 42, first_name: 'DROP', phone: 'DROP' }, contact: { phone_number: 'DROP' }, photo: ['DROP'] } }));
  const { provider, calls } = fixture('telegram', { ok: true, result: rows });
  const result = await provider.run('telegram_updates');
  assert.equal(result.results.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results[0], { updateId: 1, message: { messageId: 5, date: 123, chatId: '-100123', chatType: 'supergroup', text: 'hello' } });
  assert.ok(!JSON.stringify(result).includes('DROP'));
  assert.equal(calls[0].url, `https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN}/getUpdates`);
  assert.deepEqual(calls[0].body, { limit: 20, timeout: 0 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  for (const body of [{ offset: 100 }, { allowed_updates: ['message'] }, { limit: 1 }, { timeout: 10 }]) await assert.rejects(provider.run('telegram_updates', body), errorCode('INVALID_ARGUMENTS'));
  assert.equal(calls.length, 1);
});

test('Telegram non-message updates project as null and channel messages are supported', async () => {
  const { provider } = fixture('telegram', { ok: true, result: [
    { update_id: 1, callback_query: { data: 'DROP', from: { first_name: 'DROP' } } },
    { update_id: 2, channel_post: { message_id: 1, date: 2, chat: { id: -1001, type: 'channel' }, text: 'post' } },
  ] });
  const result = await provider.run('telegram_updates', {});
  assert.equal(result.results[0].message, null);
  assert.equal(result.results[1].message.text, 'post');
  assert.equal(result.truncated, false);
});

test('Telegram write uses only chat_id/text and returns a compact receipt (mock only)', async () => {
  const { provider, calls } = fixture('telegram', { ok: true, result: { message_id: 6, date: 123, chat: { id: 99, first_name: 'DROP' }, text: 'DROP' } });
  for (const id of ['99', 99, '-100123', -100123, '@unit_channel']) {
    assert.deepEqual(await provider.run('telegram_send_message', { chatId: id, text: 'A <b>literal</b> message\n😀' }), { messageId: 6, chatId: '99', date: 123 });
    assert.deepEqual(calls.at(-1).body, { chat_id: id, text: 'A <b>literal</b> message\n😀' });
    assert.equal(calls.at(-1).url, `https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN}/sendMessage`);
  }
  assert.ok(calls.every(call => call.headers['Content-Type'] === 'application/json'));
});

test('Linear read is fixed GraphQL with optional team variables, raw personal-key auth, 20-row projection', async () => {
  const { provider, calls } = fixture('linear', (_url, init) => {
    const body = init.body;
    const connection = { nodes: Array(25).fill(issue), pageInfo: { hasNextPage: true } };
    return { data: body.variables.teamId ? { team: { issues: connection } } : { issues: connection } };
  });
  for (const args of [{}, { teamId }]) {
    const result = await provider.run('linear_issues', args);
    assert.equal(result.results.length, 20);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.results[0], projectedIssue);
    assert.ok(!JSON.stringify(result).includes('NOT_RETURNED'));
    const call = calls.at(-1), body = call.body;
    assert.equal(call.url, 'https://api.linear.app/graphql');
    assert.equal(call.headers.Authorization, credentials.LINEAR_API_KEY);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.match(body.query, /issues\(first: 20\)/);
    assert.match(body.query, /pageInfo \{ hasNextPage \}/);
    assert.deepEqual(body.variables, args);
    if (args.teamId) {
      assert.match(body.query, /team\(id: \$teamId\)/);
      assert.ok(!body.query.includes(teamId));
    }
  }
});

test('Linear create uses hardcoded mutation, typed input variables and compact output (mock only)', async () => {
  const { provider, calls } = fixture('linear', { data: { issueCreate: { success: true, issue } } });
  const input = { teamId, title: 'a\" } mutation { something } #', description: 'Details\n😀' };
  assert.deepEqual(await provider.run('linear_create_issue', input), projectedIssue);
  const body = calls[0].body;
  assert.deepEqual(body.variables, { input });
  assert.match(body.query, /^mutation IntegrationCreateIssue\(\$input: IssueCreateInput!\)/);
  assert.match(body.query, /issueCreate\(input: \$input\)/);
  assert.ok(!body.query.includes(input.title));
  assert.ok(!body.query.includes(input.description));
});

test('Stripe read-only endpoints/auth are fixed; sensitive payment/customer fields are never returned', async () => {
  const customer = { id: 'cus_unit', created: 123, livemode: false, name: 'DROP', email: 'DROP', phone: 'DROP', address: 'DROP', metadata: { token: 'DROP' }, invoice_settings: { default_payment_method: 'DROP' }, sources: { card: { number: 'DROP' } } };
  const invoice = { id: 'in_unit', number: 'INV-1', status: 'open', created: 123, amount_due: 'DROP', total: 'DROP', client_secret: 'DROP', customer_email: 'DROP', invoice_pdf: 'DROP', hosted_invoice_url: 'DROP', payment_settings: 'DROP', lines: 'DROP' };
  for (const [operation, row, projection, path] of [
    ['stripe_customers', customer, { id: 'cus_unit', created: 123, livemode: false }, 'customers'],
    ['stripe_invoices', invoice, { id: 'in_unit', number: 'INV-1', status: 'open', created: 123 }, 'invoices'],
  ]) {
    const { provider, calls } = fixture('stripe', { object: 'list', data: Array(25).fill(row), has_more: true });
    const result = await provider.run(operation, {});
    assert.equal(result.results.length, 20);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.results[0], projection);
    assert.ok(!JSON.stringify(result).includes('DROP'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.stripe.com/v1/${path}?limit=20`);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
    assert.equal(Buffer.from(calls[0].headers.Authorization.slice(6), 'base64').toString(), `${credentials.STRIPE_SECRET_KEY}:`);
  }
});

test('Asana project tasks requests minimal fields and never follows pagination URLs', async () => {
  const { provider, calls } = fixture('asana', { data: Array(25).fill(task), next_page: { uri: 'https://evil.invalid/steal', offset: 'IGNORE' } });
  const result = await provider.run('asana_tasks', { projectId });
  assert.equal(result.results.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results[0], projectedTask);
  assert.ok(!JSON.stringify(result).includes('NOT_RETURNED'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://app.asana.com/api/1.0/projects/${projectId}/tasks?limit=20&opt_fields=name,completed,due_on`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, `Bearer ${credentials.ASANA_TOKEN}`);
});

test('Asana create has a data envelope and output options; no assignee or workspace override (mock only)', async () => {
  const { provider, calls } = fixture('asana', { data: task });
  const args = { projectId, name: 'New task', notes: 'Details\n😀' };
  assert.deepEqual(await provider.run('asana_create_task', args), projectedTask);
  assert.equal(calls[0].url, 'https://app.asana.com/api/1.0/tasks');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { data: { projects: [projectId], name: args.name, notes: args.notes }, options: { fields: ['name', 'completed', 'due_on'] } });
});

test('strict advertised schemas require the exact arguments and contain bounds; runtime uses an isolated schema', async () => {
  const { providers } = fixture('linear', { data: { issues: { nodes: [] } } });
  for (const provider of providers) for (const operation of provider.operations) {
    assert.equal(operation.parameters.type, 'object');
    assert.equal(operation.parameters.additionalProperties, false);
    assert.ok(Array.isArray(operation.parameters.required));
    assert.ok(operation.description.length > 20);
    for (const spec of Object.values(operation.parameters.properties)) {
      for (const branch of spec.anyOf || [spec]) {
        if (branch.type === 'string') { assert.ok(Number.isInteger(branch.minLength)); assert.ok(branch.maxLength > 0); assert.ok(branch.pattern); }
      }
    }
    if (operation.type === 'write') assert.match(operation.description, /explicit confirmation/);
  }
  const linear = providers.find(p => p.id === 'linear');
  assert.deepEqual(linear.operations[0].parameters.required, []);
  assert.deepEqual(linear.operations[1].parameters.required, ['teamId', 'title', 'description']);
  linear.operations[0].parameters.additionalProperties = true;
  linear.operations[0].parameters.properties.query = { type: 'string' };
  await assert.rejects(linear.run('linear_issues', { query: '{ viewer { email } }' }), errorCode('INVALID_ARGUMENTS'));
  assert.equal(new RegExp(providers.find(p => p.id === 'asana').operations[0].parameters.properties.projectId.pattern, 'u').test('123\n'), false);
});

test('runtime validation rejects unknown/extra arguments, prototypes, symbols, accessors, empty and malformed IDs', async () => {
  const { providers, calls } = fixture('telegram', null);
  const valid = {
    telegram_updates: {}, telegram_send_message: { chatId: '123', text: 'Hello' },
    linear_issues: {}, linear_create_issue: { teamId, title: 'Title', description: 'Description' },
    stripe_customers: {}, stripe_invoices: {},
    asana_tasks: { projectId }, asana_create_task: { projectId, name: 'Title', notes: 'Notes' },
  };
  for (const provider of providers) {
    await assert.rejects(provider.run('not_a_tool', {}), errorCode('UNKNOWN_OPERATION'));
    for (const operation of provider.operations) {
      const args = valid[operation.name];
      for (const bad of [null, [], 'args', 1, new Date(), Object.assign(Object.create({ injected: true }), args), { ...args, endpoint: 'https://evil.invalid' }, { ...args, [Symbol('hidden')]: 'secret' }]) await assert.rejects(provider.run(operation.name, bad), errorCode('INVALID_ARGUMENTS'));
      for (const key of operation.parameters.required) {
        const missing = { ...args }; delete missing[key];
        await assert.rejects(provider.run(operation.name, missing), errorCode('INVALID_ARGUMENTS'));
      }
      for (const key of Object.keys(operation.parameters.properties)) {
        const accessor = Object.defineProperty({ ...args }, key, { get() { assert.fail('argument getter executed'); }, enumerable: true });
        await assert.rejects(provider.run(operation.name, accessor), errorCode('INVALID_ARGUMENTS'));
        const hidden = Object.defineProperty({ ...args }, key, { value: args[key], enumerable: false });
        await assert.rejects(provider.run(operation.name, hidden), errorCode('INVALID_ARGUMENTS'));
      }
    }
  }
  const get = id => providers.find(p => p.id === id);
  for (const bad of ['team', 'https://evil.invalid', `${teamId}\n`, `${teamId}/path`, null, 123]) await assert.rejects(get('linear').run('linear_issues', { teamId: bad }), errorCode('INVALID_ARGUMENTS'));
  for (const bad of ['0', '0123', '-123', '1/../../users', '123?limit=100', '123\n', '1'.repeat(33), 123, null]) await assert.rejects(get('asana').run('asana_tasks', { projectId: bad }), errorCode('INVALID_ARGUMENTS'));
  for (const bad of [0, 1.5, Number.MAX_SAFE_INTEGER, true, {}, '0', '123\n', '@x', '@bad/name', '123/../../getMe', 'https://evil.invalid']) await assert.rejects(get('telegram').run('telegram_send_message', { chatId: bad, text: 'Hello' }), errorCode('INVALID_ARGUMENTS'));
  for (const bad of ['', '  ', 'a'.repeat(4097), 'hello\u0000', '\ud800']) await assert.rejects(get('telegram').run('telegram_send_message', { chatId: '123', text: bad }), errorCode('INVALID_ARGUMENTS'));
  for (const [id, operation, args, key, max] of [
    ['linear', 'linear_create_issue', valid.linear_create_issue, 'title', 255],
    ['linear', 'linear_create_issue', valid.linear_create_issue, 'description', 10000],
    ['asana', 'asana_create_task', valid.asana_create_task, 'name', 255],
    ['asana', 'asana_create_task', valid.asana_create_task, 'notes', 10000],
  ]) {
    for (const bad of [null, false, 1, 'a'.repeat(max + 1), 'a\u0000', '\ud800']) await assert.rejects(get(id).run(operation, { ...args, [key]: bad }), errorCode('INVALID_ARGUMENTS'));
  }
  assert.equal(calls.length, 0);
});

test('valid string boundaries, multiline notes and empty descriptions are accepted', async () => {
  const telegram = fixture('telegram', { ok: true, result: { message_id: 1, chat: { id: 1 } } });
  await telegram.provider.run('telegram_send_message', { chatId: '1', text: '😀'.repeat(4096) });
  const linear = fixture('linear', { data: { issueCreate: { success: true, issue } } });
  await linear.provider.run('linear_create_issue', { teamId, title: 'x'.repeat(255), description: '' });
  await linear.provider.run('linear_create_issue', { teamId, title: 'x', description: 'x'.repeat(10000) });
  const asana = fixture('asana', { data: task });
  await asana.provider.run('asana_create_task', { projectId, name: 'x'.repeat(255), notes: '' });
  await asana.provider.run('asana_create_task', { projectId, name: 'x', notes: 'x'.repeat(10000) });
});

test('remote API failures and transport exceptions are sanitized without messages/URLs/causes', async () => {
  const cases = [
    ['telegram', { ok: false, description: `Bad token https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN}/getMe`, error_code: 401 }],
    ['linear', { data: { viewer: { id: teamId } }, errors: [{ message: credentials.LINEAR_API_KEY }] }],
    ['stripe', { error: { message: credentials.STRIPE_SECRET_KEY } }],
    ['asana', { errors: [{ message: credentials.ASANA_TOKEN }] }],
  ];
  for (const [id, response] of cases) {
    const { provider } = fixture(id, response);
    await assert.rejects(provider.test(), errorCode('UPSTREAM_ERROR'));
    const operation = provider.operations[0].name;
    await assert.rejects(provider.run(operation, id === 'asana' ? { projectId } : {}), errorCode('UPSTREAM_ERROR'));
  }
  for (const id of ['telegram', 'linear', 'stripe', 'asana']) {
    const { provider } = fixture(id, () => { throw new Error(`https://api.telegram.org/bot${credentials.TELEGRAM_BOT_TOKEN} ${Object.values(credentials).join(' ')}`, { cause: new Error('private') }); });
    await assert.rejects(provider.test(), errorCode('REQUEST_FAILED'));
    await assert.rejects(provider.run(provider.operations[0].name, id === 'asana' ? { projectId } : {}), errorCode('REQUEST_FAILED'));
  }
  const mutation = fixture('linear', { data: { issueCreate: { success: false, issue } } });
  await assert.rejects(mutation.provider.run('linear_create_issue', { teamId, title: 'Title', description: '' }), errorCode('UPSTREAM_ERROR'));
});

test('malformed service payloads fail closed rather than passing through unexpected data', async () => {
  const cases = [
    ['telegram', null, 'telegram_updates', {}],
    ['telegram', { ok: 'true', result: [] }, 'telegram_updates', {}],
    ['telegram', { ok: true, result: {} }, 'telegram_updates', {}],
    ['telegram', { ok: true, result: [{ update_id: '1' }] }, 'telegram_updates', {}],
    ['telegram', { ok: true, result: {} }, 'telegram_send_message', { chatId: '1', text: 'Hello' }],
    ['linear', { data: null }, 'linear_issues', {}],
    ['linear', { data: { issues: { nodes: [{}] } } }, 'linear_issues', {}],
    ['linear', { data: { team: null } }, 'linear_issues', { teamId }],
    ['stripe', { object: 'list', data: 'not-array' }, 'stripe_customers', {}],
    ['stripe', { object: 'list', data: [null] }, 'stripe_invoices', {}],
    ['stripe', { object: 'customer', data: [] }, 'stripe_customers', {}],
    ['asana', { data: [null] }, 'asana_tasks', { projectId }],
    ['asana', { data: 'task' }, 'asana_create_task', { projectId, name: 'Title', notes: '' }],
  ];
  for (const [id, payload, operation, args] of cases) await assert.rejects(fixture(id, payload).provider.run(operation, args), errorCode('INVALID_RESPONSE'));
  for (const [id, payload] of [['telegram', { ok: true, result: { id: 1, is_bot: false } }], ['linear', { data: { viewer: null } }], ['stripe', { object: 'balance' }], ['asana', { data: {} }]]) await assert.rejects(fixture(id, payload).provider.test(), errorCode('INVALID_RESPONSE'));
});

test('secret reflection is redacted in output fields, encoded URL forms, labels and Basic credentials', async () => {
  const secret = credentials.TELEGRAM_BOT_TOKEN;
  const forms = [secret, encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2), Buffer.from(`${credentials.STRIPE_SECRET_KEY}:`).toString('base64')];
  const value = forms.join(' ');
  const telegram = fixture('telegram', { ok: true, result: [{ update_id: 1, message: { text: `https://api.telegram.org/bot${secret}/getMe ${value}` } }] });
  const result = await telegram.provider.run('telegram_updates', {});
  assert.match(result.results[0].message.text, /\[redacted\]/);
  for (const form of forms) assert.ok(!JSON.stringify(result).includes(form));
  const linear = fixture('linear', { data: { issues: { nodes: [{ ...issue, title: value }] } } });
  for (const form of forms) assert.ok(!JSON.stringify(await linear.provider.run('linear_issues', {})).includes(form));
  const asana = fixture('asana', { data: { gid: '1', name: value } });
  for (const form of forms) assert.ok(!JSON.stringify(await asana.provider.test()).includes(form));
  const label = fixture('telegram', { ok: true, result: { id: 123, is_bot: true, username: secret } });
  assert.ok(!(await label.provider.test()).accountLabel.includes(secret));
});

test('output text and labels are bounded and no response returns more than 20 rows', async () => {
  const linear = fixture('linear', { data: { issues: { nodes: [{ ...issue, title: 'x'.repeat(10000), identifier: 'x'.repeat(500), state: { name: 'x'.repeat(500) } }] } } });
  const output = (await linear.provider.run('linear_issues', {})).results[0];
  assert.equal(output.title.length, 500);
  assert.equal(output.identifier.length, 100);
  assert.equal(output.state.length, 100);
  const asana = fixture('asana', { data: { gid: '1', name: 'x'.repeat(5000) } });
  assert.equal((await asana.provider.test()).accountLabel.length, 200);
  const telegram = fixture('telegram', { ok: true, result: [{ update_id: 1, message: { text: 'x'.repeat(5000) } }] });
  assert.equal((await telegram.provider.run('telegram_updates', {})).results[0].message.text.length, 1000);
});

test('signals are forwarded, already-aborted calls do no I/O, post-transport cancellation is safe', async () => {
  const controller = new AbortController(); controller.abort('SECRET');
  const initial = fixture('telegram', { ok: true, result: [] });
  await assert.rejects(initial.provider.test(controller.signal), errorCode('CANCELLED'));
  await assert.rejects(initial.provider.run('telegram_updates', {}, controller.signal), errorCode('CANCELLED'));
  await assert.rejects(initial.provider.test({ aborted: false }), errorCode('INVALID_ARGUMENTS'));
  assert.equal(initial.calls.length, 0);
  const later = new AbortController();
  const pending = fixture('telegram', (_url, init) => { assert.equal(init.signal, later.signal); later.abort('SECRET'); return { ok: true, result: [] }; });
  await assert.rejects(pending.provider.run('telegram_updates', {}, later.signal), errorCode('CANCELLED'));
});

test('no arbitrary GraphQL, endpoints, Stripe money writes, or alternate provider operation dispatch', async () => {
  const { providers, calls } = fixture('telegram', null);
  for (const provider of providers) for (const name of ['graphql', 'http_request', 'stripe_transfer', 'stripe_refund', 'stripe_charge', 'stripe_create_customer', 'exec']) await assert.rejects(provider.run(name, {}), errorCode('UNKNOWN_OPERATION'));
  const stripe = providers.find(p => p.id === 'stripe');
  assert.ok(stripe.operations.every(operation => operation.type === 'read'));
  await assert.rejects(stripe.run('asana_create_task', { projectId, name: 'Title', notes: '' }), errorCode('UNKNOWN_OPERATION'));
  await assert.rejects(providers.find(p => p.id === 'telegram').run('telegram_send_message', { chatId: '1', text: 'Hello', parse_mode: 'HTML' }), errorCode('INVALID_ARGUMENTS'));
  assert.equal(calls.length, 0);
});
