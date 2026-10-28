/* Server-only adapters. Official documentation researched with Exa:
 * Telegram: https://core.telegram.org/bots/api (getMe/getUpdates/sendMessage)
 * Linear: https://linear.app/developers/graphql
 *         https://linear.app/docs/api-and-webhooks
 * Stripe: https://docs.stripe.com/api/authentication
 *         https://docs.stripe.com/api/balance/balance_retrieve
 *         https://docs.stripe.com/api/customers/list
 *         https://docs.stripe.com/api/invoices/list
 * Asana: https://developers.asana.com/docs/personal-access-token
 *        https://developers.asana.com/docs/inputoutput-options
 *        https://developers.asana.com/reference/gettasksforproject
 *        https://developers.asana.com/reference/createTask
 *        https://developers.asana.com/reference/getuser
 *
 * Setup / least privilege:
 * - TELEGRAM_BOT_TOKEN: create a bot with BotFather. Recipients must first start
 *   the bot or add it to their chat; channel posts require appropriate rights.
 *   getUpdates cannot coexist with a webhook; this adapter never removes one,
 *   changes allowed_updates, or acknowledges updates with an offset.
 * - LINEAR_API_KEY: personal key from Security & Access, restricted to needed
 *   teams with Read and Create issues permissions. Authorization is the RAW key,
 *   NOT Bearer (Bearer is for OAuth). Supply team model UUIDs, not team labels.
 * - STRIPE_SECRET_KEY: prefer a restricted rk_test_/rk_live_ key with Read for
 *   Balance, Customers, Invoices. No write permissions are needed or used.
 * - ASANA_TOKEN: PAT from developer console, with access to the target project.
 *   OAuth equivalents: users:read, tasks:read, tasks:write. PATs act as their user;
 *   tokens are opaque, not validated against an assumed vendor-specific format.
 *
 * Credentials are supplied by the server, never operation/model arguments.
 * The injected http(url, {method, headers, body, signal}) returns parsed JSON;
 * it MUST enforce HTTPS/fixed hosts, no redirects, response byte/deadline limits,
 * and sanitized transport failures. JSON request bodies are serialized strings.
 * There is no default network implementation, retry, pagination, or persistence.
 * IMPORTANT: write operations perform real writes. The orchestrator must obtain
 * explicit confirmation BEFORE run(); schemas do not constitute authorization.
 * Returned strings remain untrusted content, not instructions or safe HTML.
 */

const MAX_ROWS = 20;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
// The final negative lookahead makes `$` an absolute end, not before a final LF.
const string = (minLength, maxLength, pattern) => ({ type: 'string', minLength, maxLength, ...(pattern ? { pattern: `${pattern}(?![\\s\\S])` } : {}) });
const textSpec = (max, multiline = false, empty = false) => string(empty ? 0 : 1, max,
  `${empty ? '^' : '^(?=[\\s\\S]*\\S)'}[^${multiline ? '\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f' : '\\u0000-\\u001f'}\\u007f-\\u009f\\ud800-\\udfff]*$`);
const uuid = string(36, 36, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
const gid = string(1, 32, '^[1-9][0-9]{0,31}$');
const chatId = { anyOf: [
  string(1, 33, '^(?:-?[1-9][0-9]{0,15}|@[A-Za-z][A-Za-z0-9_]{4,31})$'),
  { type: 'integer', minimum: -4503599627370495, maximum: 4503599627370495, not: { const: 0 } },
], description: 'Decimal chat ID (prefer a string to preserve precision), or @channel_username.' };
const op = (name, type, description, parameters = object()) => ({ name, type, description, parameters });

// All GraphQL documents are constants. User input is only ever sent as variables.
const ISSUE_FIELDS = 'id identifier title state { name }';
const PAGE_FIELDS = `nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }`;
const VIEWER = 'query IntegrationViewer { viewer { id name } }';
const ISSUES = `query IntegrationIssues { issues(first: 20) { ${PAGE_FIELDS} } }`;
const TEAM_ISSUES = `query IntegrationTeamIssues($teamId: String!) { team(id: $teamId) { issues(first: 20) { ${PAGE_FIELDS} } } }`;
const CREATE_ISSUE = `mutation IntegrationCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`;

class IntegrationError extends Error {
  constructor(code, message) { super(message); this.name = 'IntegrationError'; this.code = code; }
}
const fail = (code, message) => { throw new IntegrationError(code, message); };
const invalidResponse = () => fail('INVALID_RESPONSE', 'Integration returned an invalid response.');
const apiFailure = () => fail('UPSTREAM_ERROR', 'Integration API rejected the request.');
const safeInteger = value => Number.isSafeInteger(value) ? value : null;

// Validate precisely the JSON subset used by these schemas, including accessor,
// symbol, inherited, and non-enumerable argument defenses. Never invoke getters.
function matches(value, spec) {
  if (spec.anyOf) return spec.anyOf.some(item => matches(value, item));
  if (spec.type === 'integer') return Number.isSafeInteger(value) && value >= spec.minimum && value <= spec.maximum && (!spec.not || value !== spec.not.const);
  return typeof value === 'string' && Array.from(value).length >= spec.minLength && Array.from(value).length <= spec.maxLength && (!spec.pattern || new RegExp(spec.pattern, 'u').test(value));
}
function validate(args, schema) {
  if (!plain(args)) fail('INVALID_ARGUMENTS', 'Invalid integration arguments.');
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)
    || schema.required.some(key => !Object.hasOwn(descriptors, key))) fail('INVALID_ARGUMENTS', 'Invalid integration arguments.');
  for (const key of Object.keys(descriptors)) if (!matches(descriptors[key].value, schema.properties[key])) fail('INVALID_ARGUMENTS', 'Invalid integration arguments.');
  // Return a snapshot: caller mutation while a confirmation/transport awaits must
  // not alter the validated values of this execution.
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

/** Configured means usable local prerequisites, not verified remote credentials. */
export function createExtraIntegrations({ credentials = {}, http } = {}) {
  const entries = [
    ['telegram', 'Telegram', 'TELEGRAM_BOT_TOKEN', value => /^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,128}$/.test(value)],
    ['linear', 'Linear', 'LINEAR_API_KEY', () => true],
    ['stripe', 'Stripe', 'STRIPE_SECRET_KEY', value => /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,256}$/.test(value)],
    ['asana', 'Asana', 'ASANA_TOKEN', () => true],
  ];
  const keys = Object.fromEntries(entries.map(([id, , env]) => {
    const descriptor = plain(credentials) ? Object.getOwnPropertyDescriptor(credentials, env) : undefined;
    return [id, descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : ''];
  }));
  const usable = value => value.length > 0 && value.length <= 4096 && !/[^\x21-\x7e]/.test(value);
  // Redact even malformed/other-provider credentials if an upstream reflects them.
  // Invalid Unicode in an unused credential must not break the whole catalog.
  const secrets = [...new Set(Object.values(keys).filter(Boolean).flatMap(value => {
    let encoded;
    try { encoded = encodeURIComponent(value); } catch { encoded = value; }
    return [value, encoded, new URLSearchParams({ s: value }).toString().slice(2), Buffer.from(`${value}:`).toString('base64')];
  }))].sort((a, b) => b.length - a.length);
  const text = (value, max = 200) => {
    if (typeof value !== 'string') return null;
    let safe = value;
    for (const secret of secrets) safe = safe.split(secret).join('[redacted]');
    return safe.slice(0, max);
  };
  const issue = value => {
    if (!plain(value) || typeof value.id !== 'string' || typeof value.title !== 'string') invalidResponse();
    return { id: text(value.id, 100), identifier: text(value.identifier, 100), title: text(value.title, 500), state: text(value.state?.name, 100) };
  };
  const task = value => {
    if (!plain(value) || typeof value.gid !== 'string' || typeof value.name !== 'string') invalidResponse();
    return { id: text(value.gid, 100), name: text(value.name, 500), completed: typeof value.completed === 'boolean' ? value.completed : null, dueOn: text(value.due_on, 20) };
  };
  const list = (rows, project, more = false) => {
    if (!Array.isArray(rows)) invalidResponse();
    return { results: rows.slice(0, MAX_ROWS).map(project), truncated: rows.length > MAX_ROWS || more };
  };

  return entries.map(([id, name, env, validKey]) => {
    const key = keys[id];
    const configured = typeof http === 'function' && usable(key) && validKey(key);
    const operations = id === 'telegram' ? [
      op('telegram_updates', 'read', 'Read at most 20 pending Telegram updates without acknowledging them. Requires no active webhook.'),
      op('telegram_send_message', 'write', 'Send one plain-text Telegram message. Caller must obtain explicit confirmation first.', object({ chatId, text: textSpec(4096, true) })),
    ] : id === 'linear' ? [
      op('linear_issues', 'read', 'Read at most 20 Linear issues, optionally from a team model UUID.', object({ teamId: uuid }, [])),
      op('linear_create_issue', 'write', 'Create one Linear issue. Caller must obtain explicit confirmation first.', object({ teamId: uuid, title: textSpec(255), description: textSpec(10000, true, true) })),
    ] : id === 'stripe' ? [
      op('stripe_customers', 'read', 'Read at most 20 customer IDs and creation times; excludes names, contact and payment details.'),
      op('stripe_invoices', 'read', 'Read at most 20 invoice IDs, numbers, statuses and creation times; excludes payment details and amounts.'),
    ] : [
      op('asana_tasks', 'read', 'Read at most 20 tasks in one accessible Asana project.', object({ projectId: gid })),
      op('asana_create_task', 'write', 'Create one task in an Asana project. Caller must obtain explicit confirmation first.', object({ projectId: gid, name: textSpec(255), notes: textSpec(10000, true, true) })),
    ];
    // Public catalog is detached from internal validation, so downstream UI/model
    // consumers cannot weaken runtime validation by mutating a schema.
    const schemas = new Map(operations.map(operation => [operation.name, structuredClone(operation.parameters)]));

    async function guarded(signal, action) {
      if (!configured) fail('NOT_CONFIGURED', `${name} is not configured; set ${env} and provide the server HTTP transport.`);
      if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_ARGUMENTS', 'Invalid cancellation signal.');
      if (signal?.aborted) fail('CANCELLED', 'Integration request cancelled.');
      try {
        const result = await action();
        if (signal?.aborted) fail('CANCELLED', 'Integration request cancelled.');
        return result;
      } catch (error) {
        if (signal?.aborted) fail('CANCELLED', 'Integration request cancelled.');
        if (error instanceof IntegrationError) throw error;
        // Never expose upstream error messages, transport URLs, causes, GraphQL
        // errors, or Telegram descriptions (the URL contains its secret token).
        fail('REQUEST_FAILED', 'Integration request failed.');
      }
    }
    async function telegram(method, body, signal) {
      const result = await http(`https://api.telegram.org/bot${key}/${method}`, {
        method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}), signal,
      });
      if (!plain(result) || typeof result.ok !== 'boolean') invalidResponse();
      if (!result.ok) apiFailure();
      return result.result;
    }
    async function linear(query, variables, signal) {
      const result = await http('https://api.linear.app/graphql', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: key }, body: { query, variables }, signal });
      if (!plain(result)) invalidResponse();
      if (Object.hasOwn(result, 'errors') && (!Array.isArray(result.errors) || result.errors.length > 0)) apiFailure();
      if (!plain(result.data)) invalidResponse();
      return result.data;
    }
    async function stripe(path, signal) {
      const result = await http(`https://api.stripe.com/v1/${path}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` }, signal });
      if (!plain(result)) invalidResponse();
      if (Object.hasOwn(result, 'error')) apiFailure();
      return result;
    }
    async function asana(path, body, signal) {
      const result = await http(`https://app.asana.com/api/1.0/${path}`, { method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}), signal });
      if (!plain(result)) invalidResponse();
      if (Object.hasOwn(result, 'errors')) apiFailure();
      if (!Object.hasOwn(result, 'data')) invalidResponse();
      return result;
    }

    return {
      id, name, env: [env], configured, operations,
      test: async signal => guarded(signal, async () => {
        if (id === 'telegram') {
          const bot = await telegram('getMe', undefined, signal);
          if (!plain(bot) || bot.is_bot !== true || !Number.isSafeInteger(bot.id)) invalidResponse();
          return { accountLabel: text(bot.username ? `@${bot.username}` : bot.first_name, 200) || 'Telegram bot' };
        }
        if (id === 'linear') {
          const { viewer } = await linear(VIEWER, {}, signal);
          if (!plain(viewer) || typeof viewer.id !== 'string') invalidResponse();
          return { accountLabel: text(viewer.name, 200) || 'Linear account' };
        }
        if (id === 'stripe') {
          const result = await stripe('balance', signal);
          if (result.object !== 'balance' || typeof result.livemode !== 'boolean') invalidResponse();
          return { accountLabel: `Stripe (${result.livemode ? 'live' : 'test'} mode)` };
        }
        const { data } = await asana('users/me?opt_fields=name', undefined, signal);
        if (!plain(data) || typeof data.gid !== 'string') invalidResponse();
        return { accountLabel: text(data.name, 200) || 'Asana account' };
      }),
      run: async (operationName, args = {}, signal) => {
        const schema = schemas.get(operationName);
        if (!schema) fail('UNKNOWN_OPERATION', 'Unknown integration operation.');
        const input = validate(args, schema);
        return guarded(signal, async () => {
          if (operationName === 'telegram_updates') {
            // Do not pass offset or allowed_updates: both change server-side state.
            const rows = await telegram('getUpdates', { limit: MAX_ROWS, timeout: 0 }, signal);
            return list(rows, update => {
              if (!plain(update) || !Number.isSafeInteger(update.update_id)) invalidResponse();
              const message = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
              return { updateId: update.update_id, message: plain(message) ? {
                messageId: safeInteger(message.message_id), date: safeInteger(message.date),
                chatId: Number.isSafeInteger(message.chat?.id) ? String(message.chat.id) : null,
                chatType: text(message.chat?.type, 32), text: text(message.text, 1000),
              } : null };
            });
          }
          if (operationName === 'telegram_send_message') {
            const message = await telegram('sendMessage', { chat_id: input.chatId, text: input.text }, signal);
            if (!plain(message) || !Number.isSafeInteger(message.message_id) || !Number.isSafeInteger(message.chat?.id)) invalidResponse();
            return { messageId: message.message_id, chatId: String(message.chat.id), date: safeInteger(message.date) };
          }
          if (operationName === 'linear_issues') {
            const data = await linear(input.teamId ? TEAM_ISSUES : ISSUES, input.teamId ? { teamId: input.teamId } : {}, signal);
            const connection = input.teamId ? data.team?.issues : data.issues;
            if (!plain(connection)) invalidResponse();
            return list(connection.nodes, issue, connection.pageInfo?.hasNextPage === true);
          }
          if (operationName === 'linear_create_issue') {
            const { issueCreate } = await linear(CREATE_ISSUE, { input: { teamId: input.teamId, title: input.title, description: input.description } }, signal);
            if (!plain(issueCreate)) invalidResponse();
            if (issueCreate.success !== true) apiFailure();
            return issue(issueCreate.issue);
          }
          if (operationName === 'stripe_customers' || operationName === 'stripe_invoices') {
            const result = await stripe(`${operationName === 'stripe_customers' ? 'customers' : 'invoices'}?limit=20`, signal);
            if (result.object !== 'list') invalidResponse();
            return list(result.data, row => {
              if (!plain(row) || typeof row.id !== 'string') invalidResponse();
              return operationName === 'stripe_customers'
                ? { id: text(row.id, 100), created: safeInteger(row.created), livemode: typeof row.livemode === 'boolean' ? row.livemode : null }
                : { id: text(row.id, 100), number: text(row.number, 100), status: text(row.status, 40), created: safeInteger(row.created) };
            }, result.has_more === true);
          }
          if (operationName === 'asana_tasks') {
            const result = await asana(`projects/${input.projectId}/tasks?limit=20&opt_fields=name,completed,due_on`, undefined, signal);
            return list(result.data, task, result.next_page != null);
          }
          const { data } = await asana('tasks', { data: { projects: [input.projectId], name: input.name, notes: input.notes }, options: { fields: ['name', 'completed', 'due_on'] } }, signal);
          return task(data);
        });
      },
    };
  });
}
