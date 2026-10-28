/* Google Workspace server-token adapters; official documentation checked via Exa:
 * https://developers.google.com/identity/protocols/oauth2/web-server#offline
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create
 * https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 * https://developers.google.com/calendar/api/v3/reference/events/insert
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
 * https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
 * https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#InsertTextRequest
 * https://developers.google.com/docs/api/how-tos/tabs
 * https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
 * https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append
 * https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption
 *
 * Server credentials ONLY. No browser OAuth, callback, arbitrary URL, send-mail,
 * or inferred scope grant. The caller must test-and-enable each provider and
 * confirm every operation whose type is 'write' BEFORE calling run(). This module
 * does not replace the caller's workspace authorization or confirmation gate.
 *
 * Practical minimum scopes (https://www.googleapis.com/auth/ prefix):
 * Gmail reads: gmail.readonly; drafts: gmail.compose (also permits sending at
 * Google, but this adapter NEVER exposes send). Calendar: calendar.events.readonly
 * for reads, calendar.events for writes. Drive: drive.metadata.readonly.
 * Docs: documents.readonly / documents. Sheets: spreadsheets.readonly /
 * spreadsheets. Docs/Sheets test() additionally discovers one existing file via
 * Drive files.list, requiring drive.metadata.readonly (or drive.file for files
 * already authorized to this app). Empty discovery FAILS rather than pretending
 * the Docs/Sheets API was checked. drive.file can replace Docs/Sheets scopes for
 * app-authorized files; access is then limited to those files.
 * Enable the relevant APIs in the Google Cloud project and obtain pre-consented
 * tokens separately; sensitive/restricted scopes may require Google verification.
 * Access tokens expire; refresh requires offline consent and the matching OAuth
 * client. Test success checks ONLY the named read, never all reads/write scopes.
 *
 * Injected http(url,{method,headers,body,form,signal}) must enforce HTTPS, exact
 * permitted origins, no redirects, bounded JSON, deadlines and safe HTTP errors.
 * body is an object (JSON); form is an object (application/x-www-form-urlencoded).
 * There is intentionally no global-fetch fallback and no automatic write retry.
 * All returned document/mail/sheet text is untrusted content, not sanitized HTML.
 */

const ENV = ['GOOGLE_ACCESS_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const HOSTS = new Set(['gmail.googleapis.com', 'www.googleapis.com', 'calendar.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'oauth2.googleapis.com']);
const ID_PATTERN = '^[A-Za-z0-9_-]{1,200}$';
const CALENDAR_PATTERN = '^(?:primary|[A-Za-z0-9][A-Za-z0-9._+#-]{0,199}@[A-Za-z0-9][A-Za-z0-9.-]{0,199})$';
const RANGE_PATTERN = "^(?:(?:[A-Za-z_][A-Za-z0-9_ ]{0,99}|'(?:[^'!\\r\\n]|''){1,100}')!)?[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$";
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$';
const MAX_RESULT = 64 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
class GoogleIntegrationError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'GoogleIntegrationError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new GoogleIntegrationError(code, message, status); };
const invalid = () => fail('INVALID_ARGUMENTS', 'Invalid Google operation arguments.', 422);
const str = (maxLength, extra = {}) => ({ type: 'string', minLength: 1, maxLength, ...extra });
const idSchema = () => str(200, { pattern: ID_PATTERN });
const calendarSchema = () => str(401, { pattern: CALENDAR_PATTERN, description: 'Calendar ID (primary or a calendar email identifier), not a URL.' });
const rangeSchema = () => str(220, { pattern: RANGE_PATTERN, description: 'Explicit finite A1 cell/rectangle, optionally sheet-qualified; at most 100 rows, 26 columns and 1000 cells. No named or whole-column ranges.' });
const textSchema = max => str(max, { description: 'Plain UTF-8 text; tabs and newlines allowed.' });
const op = (name, type, description, properties, required = Object.keys(properties)) => ({ name, type, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const definitions = {
  'google-gmail': [
    op('gmail_list_messages', 'read', 'List at most 20 Gmail message IDs/thread IDs using an optional Gmail search query. Does not fetch message bodies.', { query: str(500) }, []),
    op('gmail_read_message', 'read', 'Read bounded UTF-8 inline text parts and selected headers of one Gmail message. Never downloads attachments or binary content. HTML parts are untrusted text.', { messageId: idSchema() }),
    op('gmail_create_draft', 'write', 'After confirmation, create a plain-text Gmail DRAFT for one email address. Does NOT send email.', { to: str(254, { description: 'One bare ASCII email address; no display name, comma, CR or LF.' }), subject: str(200), body: textSchema(16000) }),
  ],
  'google-calendar': [
    op('google_calendar_events', 'read', 'Read the next 20 events (including ongoing events) on the specified calendar, default primary.', { calendarId: calendarSchema() }, []),
    op('google_calendar_create_event', 'write', 'After confirmation, create one timed calendar event, without guests or notifications. start/end require ISO timestamps with offsets; end must follow start.', { calendarId: calendarSchema(), summary: str(500), start: str(35, { pattern: DATE_PATTERN }), end: str(35, { pattern: DATE_PATTERN }) }),
  ],
  'google-drive': [
    op('google_drive_files', 'read', 'List at most 20 non-trashed Drive file metadata records. Optional query uses Drive q syntax; no file download or arbitrary URL.', { query: str(500) }, []),
  ],
  'google-docs': [
    op('google_docs_read', 'read', 'Read a bounded plain-text projection of the FIRST tab of a Google document, including paragraphs and tables, not images or formatting.', { documentId: idSchema() }),
    op('google_docs_append', 'write', 'After confirmation, append plain text to the end of the FIRST tab body of a Google document; no arbitrary batch updates.', { documentId: idSchema(), text: textSchema(16000) }),
  ],
  'google-sheets': [
    op('google_sheets_read', 'read', 'Read a bounded finite A1 rectangle as formatted cell strings (at most 100 rows/26 columns/1000 cells).', { spreadsheetId: idSchema(), range: rangeSchema() }),
    op('google_sheets_append', 'write', 'After confirmation, append up to 100 rectangular rows/26 columns/1000 cells after the logical table in an A1 range. Inserts rows, uses RAW strings, and NEVER evaluates formulas.', {
      spreadsheetId: idSchema(), range: rangeSchema(), rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 1, maxItems: 26, items: { type: 'string', maxLength: 2000 } } },
    }),
  ],
};

function validateString(value, schema, multiline = false) {
  if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > schema.maxLength || !value.isWellFormed() || (schema.minLength && !value.trim()) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value) || (schema.pattern && !new RegExp(schema.pattern).test(value))) invalid();
}
function denseArray(value, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
  }
}
function a1Bounds(range) {
  const cells = range.slice(range.lastIndexOf('!') + 1).toUpperCase().split(':');
  const position = cell => {
    const [, letters, row] = /^([A-Z]+)([1-9][0-9]*)$/.exec(cell);
    return { row: Number(row), col: [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) };
  };
  const first = position(cells[0]), last = position(cells[1] || cells[0]);
  const height = last.row - first.row + 1, width = last.col - first.col + 1;
  if (first.row > 10_000_000 || last.row > 10_000_000 || first.col > 18278 || last.col > 18278 || height < 1 || height > 100 || width < 1 || width > 26 || height * width > 1000) invalid();
  return { height, width };
}
function timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid();
  const [, year, month, day, hour, minute, second, offset, , oh, om] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || (offset !== 'Z' && (Number(oh) > 23 || Number(om) > 59)) || !Number.isFinite(Date.parse(value))) invalid();
  return Date.parse(value);
}
function validate(operation, args) {
  const schema = operation.parameters;
  if (!plain(args) || Reflect.ownKeys(args).some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key)) || Object.values(Object.getOwnPropertyDescriptors(args)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) invalid();
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key];
    if (spec.type === 'string') validateString(value, spec, ['body', 'text'].includes(key));
    else {
      denseArray(value, 1, 100);
      let total = 0;
      for (const row of value) {
        denseArray(row, 1, 26);
        if (row.length !== value[0].length) invalid();
        for (const cell of row) validateString(cell, { maxLength: 2000 }, true);
        total += row.length;
      }
      if (total > 1000 || Buffer.byteLength(JSON.stringify(value)) > 64000) invalid();
    }
  }
  if (Object.hasOwn(args, 'range')) a1Bounds(args.range);
  if (operation.name === 'google_sheets_append' && args.rows[0].length > a1Bounds(args.range).width) invalid();
  if (operation.name === 'gmail_create_draft') {
    const [local, domain, extra] = args.to.split('@');
    if (extra !== undefined || !local || local.length > 64 || !/^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*$/.test(local) || !domain || domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) invalid();
  }
  if (operation.name === 'google_calendar_create_event' && timestamp(args.end) <= timestamp(args.start)) invalid();
  if (Buffer.byteLength(JSON.stringify(args)) > 68000) invalid();
}
function endpoint(host, path, query = {}) {
  const url = new URL(`https://${host}${path}`);
  if (!HOSTS.has(host) || url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash) fail('UNSAFE_URL', 'Unsupported Google endpoint.');
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}
const encoded = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const validId = value => typeof value === 'string' && new RegExp(ID_PATTERN).test(value);
const tokenValue = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const objectResponse = value => { if (!plain(value)) fail('INVALID_RESPONSE', 'Google returned an invalid JSON response.', 502); return value; };
function utf8Prefix(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value).subarray(0, maxBytes), { stream: true });
}
function subjectHeader(subject) {
  // RFC 2047 encoded words, split on code-point boundaries and folded by us only.
  const chunks = []; let chunk = '';
  for (const char of subject) { if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = ''; } chunk += char; }
  if (chunk) chunks.push(chunk);
  return chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
}
function draftRaw(args) {
  const body = Buffer.from(args.body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return Buffer.from(`To: ${args.to}\r\nSubject: ${subjectHeader(args.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`, 'utf8').toString('base64url');
}

/** Presence/configuration is not proof of validity. Call test() before enabling. */
export function createGoogleIntegrations({ credentials = {}, http } = {}) {
  const credentialObject = credentials !== null && typeof credentials === 'object' && !Array.isArray(credentials);
  const values = Object.fromEntries(ENV.map(key => [key, credentialObject ? Object.getOwnPropertyDescriptor(credentials, key)?.value : undefined]));
  const access = tokenValue(values.GOOGLE_ACCESS_TOKEN) ? values.GOOGLE_ACCESS_TOKEN : null;
  const refreshReady = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].every(key => tokenValue(values[key]));
  const configured = typeof http === 'function' && Boolean(access || refreshReady);
  let cache = null, refreshing = null;
  const secrets = new Set();
  const remember = value => {
    if (tokenValue(value)) {
      secrets.add(value); secrets.add(encodeURIComponent(value));
      secrets.add(new URLSearchParams({ value }).toString().slice(6));
    }
  };
  Object.values(values).forEach(remember);
  const text = (value, max = 500) => {
    if (typeof value !== 'string') return null;
    // Redact before truncating so a secret crossing the boundary is not exposed.
    const maxSecret = Math.max(0, ...[...secrets].map(secret => secret.length));
    let result = value.slice(0, max + maxSecret).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]');
    return utf8Prefix(result, max);
  };
  const result = value => {
    // Projectors below whitelist every field; never return raw upstream objects.
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT) fail('OUTPUT_TOO_LARGE', 'Google result exceeds the bounded output limit; use a smaller resource/range.', 502);
    return value;
  };
  function ready(signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
    if (signal?.aborted) fail('CANCELLED', 'Google request cancelled.', 499);
    if (!configured) fail('NOT_CONFIGURED', 'Configure server GOOGLE_ACCESS_TOKEN or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN and an HTTP transport; then test and enable.', 503);
  }
  function safeError(error, signal) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'CANCELLED') fail('CANCELLED', 'Google request cancelled.', 499);
    const status = error?.status ?? error?.statusCode;
    if (status === 401) fail('AUTH_FAILED', 'Google rejected the server token. Replace the access token or reauthorize the refresh credentials.', 401);
    if (status === 403) fail('PERMISSION_DENIED', 'Google denied access. Check granted OAuth scopes, API enablement, and resource permissions; a successful connection test does not verify every operation.', 403);
    if (status === 404) fail('NOT_FOUND', 'Google resource not found or inaccessible to this account.', 404);
    if (status === 429) fail('RATE_LIMITED', 'Google rate limit exceeded; try again later.', 429);
    if (error?.name === 'TimeoutError' || ['TIMEOUT', 'ETIMEDOUT'].includes(error?.code)) fail('UPSTREAM_TIMEOUT', 'Google request timed out.', 504);
    fail('UPSTREAM_ERROR', 'Google request failed. Check server credentials, OAuth consent and API configuration.', 502);
  }
  async function request(url, options, signal) {
    try {
      const response = objectResponse(await http(url, { ...options, signal }));
      if (signal?.aborted) fail('CANCELLED', 'Google request cancelled.', 499);
      if (response.error) {
        if (typeof response.error === 'string') fail('AUTH_FAILED', 'Google token refresh failed. Reauthorize the server credentials.', 401);
        safeError({ status: response.error.code }, signal);
      }
      return response;
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      safeError(error, signal);
    }
  }
  function awaitSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new GoogleIntegrationError('CANCELLED', 'Google request cancelled.', 499));
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new GoogleIntegrationError('CANCELLED', 'Google request cancelled.', 499)); };
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function bearer(signal) {
    ready(signal);
    if (access) return access;
    if (cache && Date.now() < cache.expiresAt) return cache.token;
    if (!refreshing) {
      refreshing = (async () => {
        const response = await request(endpoint('oauth2.googleapis.com', '/token'), {
          method: 'POST', headers: { Accept: 'application/json' },
          form: { grant_type: 'refresh_token', client_id: values.GOOGLE_CLIENT_ID, client_secret: values.GOOGLE_CLIENT_SECRET, refresh_token: values.GOOGLE_REFRESH_TOKEN },
        }, signal);
        if (!tokenValue(response.access_token) || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400 || (response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer'))) fail('INVALID_RESPONSE', 'Google returned an invalid token response.', 502);
        remember(response.access_token); remember(response.refresh_token); remember(response.id_token);
        cache = { token: response.access_token, expiresAt: Date.now() + response.expires_in * 1000 - Math.min(30_000, response.expires_in * 100) };
        return cache.token;
      })();
      // Both handlers clear the in-flight slot without creating an unhandled rejection.
      refreshing.then(() => { refreshing = null; }, () => { refreshing = null; });
    }
    return awaitSignal(refreshing, signal);
  }
  async function api(host, path, query, signal, body) {
    const token = await bearer(signal);
    ready(signal);
    return request(endpoint(host, path, query), { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) }, signal);
  }
  const eventFields = 'id,status,summary,start,end';
  const event = value => ({ id: text(value?.id, 200), status: text(value?.status, 40), summary: text(value?.summary, 500), start: { dateTime: text(value?.start?.dateTime, 40), date: text(value?.start?.date, 10), timeZone: text(value?.start?.timeZone, 100) }, end: { dateTime: text(value?.end?.dateTime, 40), date: text(value?.end?.date, 10), timeZone: text(value?.end?.timeZone, 100) } });
  function mail(value) {
    const parts = []; let nodes = 0, budget = 24000, truncated = false, omittedParts = 0;
    function visit(part, depth = 0) {
      if (!plain(part)) return;
      if (++nodes > 200 || depth > 12 || parts.length >= 20 || budget <= 0) { truncated = true; return; }
      const headers = Array.isArray(part.headers) ? part.headers.slice(0, 100) : [];
      if (part.filename || headers.some(h => String(h?.name).toLowerCase() === 'content-disposition' && /^attachment(?:;|$)/i.test(h?.value))) { omittedParts++; return; }
      if (['text/plain', 'text/html'].includes(part.mimeType) && typeof part.body?.data === 'string') {
        const data = part.body.data;
        if (data.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 === 1) { omittedParts++; return; }
        const limit = Math.min(8000, budget), encodedLimit = Math.ceil((limit + 4) / 3) * 4;
        try {
          const prefix = data.slice(0, encodedLimit);
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(prefix, 'base64url'), { stream: prefix.length < data.length });
          if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(decoded)) { omittedParts++; return; }
          const projected = text(decoded, limit), cut = prefix.length < data.length || Buffer.byteLength(decoded) > limit;
          budget -= Buffer.byteLength(projected); truncated ||= cut;
          parts.push({ mimeType: part.mimeType, text: projected, truncated: cut });
        } catch { omittedParts++; }
      } else if (part.body?.attachmentId) omittedParts++;
      if (Array.isArray(part.parts)) {
        if (part.parts.length > 200) truncated = true;
        for (const child of part.parts.slice(0, 200)) visit(child, depth + 1);
      }
    }
    visit(value.payload);
    const headers = Array.isArray(value.payload?.headers) ? value.payload.headers.slice(0, 100) : [];
    const header = name => text(headers.find(h => String(h?.name).toLowerCase() === name)?.value, 500);
    return { id: text(value.id, 200), threadId: text(value.threadId, 200), snippet: text(value.snippet, 500), headers: { from: header('from'), to: header('to'), subject: header('subject'), date: header('date') }, textParts: parts, omittedParts, truncated };
  }
  function document(value) {
    let collected = '', nodes = 0, truncated = false;
    function visit(value, depth = 0) {
      if (++nodes > 3000 || depth > 24 || Buffer.byteLength(collected) >= 24000) { truncated = true; return; }
      if (Array.isArray(value)) { if (value.length > 3000) truncated = true; for (const child of value.slice(0, 3000)) visit(child, depth + 1); return; }
      if (!plain(value)) return;
      if (typeof value.textRun?.content === 'string') {
        const available = 24000 - Buffer.byteLength(collected), content = text(value.textRun.content, available);
        truncated ||= Buffer.byteLength(value.textRun.content) > available; collected += content;
      }
      for (const key of ['content', 'paragraph', 'elements', 'table', 'tableRows', 'tableCells', 'tableOfContents']) if (value[key] !== undefined) visit(value[key], depth + 1);
    }
    visit(value.body?.content || []);
    return { documentId: text(value.documentId, 200), title: text(value.title, 500), text: collected, tab: 'first', truncated };
  }
  function sheet(value, args) {
    const rows = Array.isArray(value.values) ? value.values : [], output = [];
    let budget = 24000, cells = 0, truncated = rows.length > 100;
    for (const row of rows.slice(0, 100)) {
      if (!Array.isArray(row)) fail('INVALID_RESPONSE', 'Google returned invalid sheet rows.', 502);
      if (row.length > 26) truncated = true;
      const projected = [];
      for (const cell of row.slice(0, 26)) {
        if (++cells > 1000 || budget <= 0) { truncated = true; break; }
        if (cell !== null && !['string', 'boolean', 'number'].includes(typeof cell)) fail('INVALID_RESPONSE', 'Google returned invalid sheet cells.', 502);
        if (typeof cell === 'number' && !Number.isFinite(cell)) fail('INVALID_RESPONSE', 'Google returned invalid sheet cells.', 502);
        const raw = cell === null ? '' : String(cell), limit = Math.min(2000, budget), value = text(raw, limit);
        truncated ||= Buffer.byteLength(raw) > limit;
        budget -= Buffer.byteLength(value); projected.push(value);
      }
      // Keep empty interior rows: dropping them would shift cell coordinates.
      if (cells <= 1000 || projected.length) output.push(projected);
      if (budget <= 0 || cells > 1000) break;
    }
    return { spreadsheetId: text(args.spreadsheetId, 200), range: text(value.range || args.range, 220), values: output, truncated };
  }
  async function testProvider(id, signal) {
    ready(signal);
    if (id === 'google-gmail') {
      const data = await api('gmail.googleapis.com', '/gmail/v1/users/me/profile', { fields: 'emailAddress' }, signal);
      if (!data.emailAddress || typeof data.emailAddress !== 'string') fail('INVALID_RESPONSE', 'Google returned no Gmail identity.', 502);
      return result({ accountLabel: `${text(data.emailAddress, 200)} (Gmail profile checked; message/draft scopes not verified)` });
    }
    if (id === 'google-calendar') {
      const data = await api('www.googleapis.com', '/calendar/v3/calendars/primary/events', { maxResults: 1, fields: 'summary,timeZone,items(id)' }, signal);
      if (typeof data.summary !== 'string' && typeof data.timeZone !== 'string') fail('INVALID_RESPONSE', 'Google returned no primary-calendar metadata.', 502);
      return result({ accountLabel: `${text(data.summary || 'Primary calendar', 200)} (Calendar events read checked; writes not verified)` });
    }
    if (id === 'google-drive') {
      const data = await api('www.googleapis.com', '/drive/v3/about', { fields: 'user(displayName,emailAddress)' }, signal);
      const label = data.user?.emailAddress || data.user?.displayName;
      if (typeof label !== 'string' || !label) fail('INVALID_RESPONSE', 'Google returned no Drive identity.', 502);
      return result({ accountLabel: `${text(label, 200)} (Drive identity checked; file access is resource-dependent)` });
    }
    const docs = id === 'google-docs';
    const discovery = await api('www.googleapis.com', '/drive/v3/files', { pageSize: 1, q: `trashed = false and mimeType = 'application/vnd.google-apps.${docs ? 'document' : 'spreadsheet'}'`, fields: 'files(id,name)' }, signal);
    const file = discovery.files?.[0];
    if (!file || !validId(file.id)) fail('MISSING_TEST_RESOURCE', `Cannot verify Google ${docs ? 'Docs' : 'Sheets'}: no accessible existing ${docs ? 'document' : 'spreadsheet'} found. Grant Drive discovery and the service read scope, and create or authorize one test file.`, 409);
    const data = docs
      ? await api('docs.googleapis.com', `/v1/documents/${encoded(file.id)}`, { fields: 'documentId,title' }, signal)
      : await api('sheets.googleapis.com', `/v4/spreadsheets/${encoded(file.id)}`, { fields: 'spreadsheetId,properties(title)' }, signal);
    if ((docs ? data.documentId : data.spreadsheetId) !== file.id) fail('INVALID_RESPONSE', 'Google returned an unexpected verification resource.', 502);
    const title = docs ? data.title : data.properties?.title;
    return result({ accountLabel: `${text(title || file.name || file.id, 200)} (Google ${docs ? 'Docs' : 'Sheets'} read checked on one file; writes not verified)` });
  }
  async function runProvider(id, name, args, signal) {
    const operation = definitions[id].find(operation => operation.name === name);
    if (!operation) fail('UNKNOWN_OPERATION', 'Unknown operation for this Google provider.', 404);
    validate(operation, args);
    // Snapshot before the first await: callers must not mutate a validated or
    // confirmed matrix while refresh/API I/O is pending.
    args = structuredClone(args);
    ready(signal);
    switch (name) {
      case 'gmail_list_messages': {
        const data = await api('gmail.googleapis.com', '/gmail/v1/users/me/messages', { maxResults: 20, q: args.query, fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate' }, signal);
        const messages = Array.isArray(data.messages) ? data.messages : [];
        return result({ messages: messages.slice(0, 20).map(message => ({ id: text(message?.id, 200), threadId: text(message?.threadId, 200) })), resultSizeEstimate: numeric(data.resultSizeEstimate), truncated: messages.length > 20 || Boolean(data.nextPageToken) });
      }
      case 'gmail_read_message': {
        const data = await api('gmail.googleapis.com', `/gmail/v1/users/me/messages/${encoded(args.messageId)}`, { format: 'full', fields: 'id,threadId,snippet,payload' }, signal);
        if (!validId(data.id)) fail('INVALID_RESPONSE', 'Google returned no message ID.', 502);
        return result(mail(data));
      }
      case 'gmail_create_draft': {
        const data = await api('gmail.googleapis.com', '/gmail/v1/users/me/drafts', { fields: 'id,message(id,threadId)' }, signal, { message: { raw: draftRaw(args) } });
        if (!validId(data.id)) fail('INVALID_RESPONSE', 'Google returned no draft ID. Check Gmail before retrying to avoid duplicates.', 502);
        return result({ id: text(data.id, 200), messageId: text(data.message?.id, 200), threadId: text(data.message?.threadId, 200), status: 'draft', sent: false });
      }
      case 'google_calendar_events': {
        const data = await api('www.googleapis.com', `/calendar/v3/calendars/${encoded(args.calendarId || 'primary')}/events`, { maxResults: 20, singleEvents: true, orderBy: 'startTime', timeMin: new Date().toISOString(), fields: `summary,timeZone,nextPageToken,items(${eventFields})` }, signal);
        const events = Array.isArray(data.items) ? data.items : [];
        return result({ calendar: text(data.summary, 500), timeZone: text(data.timeZone, 100), events: events.slice(0, 20).map(event), truncated: events.length > 20 || Boolean(data.nextPageToken) });
      }
      case 'google_calendar_create_event': {
        const data = await api('www.googleapis.com', `/calendar/v3/calendars/${encoded(args.calendarId)}/events`, { sendUpdates: 'none', fields: eventFields }, signal, { summary: args.summary, start: { dateTime: args.start }, end: { dateTime: args.end }, reminders: { useDefault: false } });
        if (!validId(data.id)) fail('INVALID_RESPONSE', 'Google returned no event ID. Check Calendar before retrying to avoid duplicates.', 502);
        return result(event(data));
      }
      case 'google_drive_files': {
        const data = await api('www.googleapis.com', '/drive/v3/files', { pageSize: 20, q: args.query ? `trashed = false and (${args.query})` : 'trashed = false', fields: 'files(id,name,mimeType,modifiedTime),nextPageToken,incompleteSearch' }, signal);
        const files = Array.isArray(data.files) ? data.files : [];
        return result({ files: files.slice(0, 20).map(file => ({ id: text(file?.id, 200), name: text(file?.name, 500), mimeType: text(file?.mimeType, 200), modifiedTime: text(file?.modifiedTime, 40) })), truncated: files.length > 20 || Boolean(data.nextPageToken) || data.incompleteSearch === true });
      }
      case 'google_docs_read': {
        const data = await api('docs.googleapis.com', `/v1/documents/${encoded(args.documentId)}`, { fields: 'documentId,title,body(content)', includeTabsContent: false }, signal);
        if (data.documentId !== args.documentId) fail('INVALID_RESPONSE', 'Google returned an unexpected document ID.', 502);
        return result(document(data));
      }
      case 'google_docs_append': {
        const data = await api('docs.googleapis.com', `/v1/documents/${encoded(args.documentId)}:batchUpdate`, { fields: 'documentId' }, signal, { requests: [{ insertText: { endOfSegmentLocation: {}, text: args.text } }] });
        if (data.documentId !== args.documentId) fail('INVALID_RESPONSE', 'Google returned an unexpected document ID. Check the document before retrying.', 502);
        return result({ documentId: text(args.documentId, 200), appendedCharacters: [...args.text].length, tab: 'first' });
      }
      case 'google_sheets_read': {
        const data = await api('sheets.googleapis.com', `/v4/spreadsheets/${encoded(args.spreadsheetId)}/values/${encoded(args.range)}`, { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE', fields: 'range,values' }, signal);
        return result(sheet(data, args));
      }
      case 'google_sheets_append': {
        const data = await api('sheets.googleapis.com', `/v4/spreadsheets/${encoded(args.spreadsheetId)}/values/${encoded(args.range)}:append`, { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', includeValuesInResponse: false, fields: 'spreadsheetId,tableRange,updates(updatedRange,updatedRows,updatedColumns,updatedCells)' }, signal, { range: args.range, majorDimension: 'ROWS', values: args.rows });
        if (data.spreadsheetId !== args.spreadsheetId) fail('INVALID_RESPONSE', 'Google returned an unexpected spreadsheet ID. Check the sheet before retrying.', 502);
        return result({ spreadsheetId: text(data.spreadsheetId, 200), tableRange: text(data.tableRange, 220), updatedRange: text(data.updates?.updatedRange, 220), updatedRows: numeric(data.updates?.updatedRows), updatedColumns: numeric(data.updates?.updatedColumns), updatedCells: numeric(data.updates?.updatedCells) });
      }
    }
  }
  return [['google-gmail', 'Gmail'], ['google-calendar', 'Google Calendar'], ['google-drive', 'Google Drive'], ['google-docs', 'Google Docs'], ['google-sheets', 'Google Sheets']].map(([id, name]) => ({
    id, name, env: [...ENV], configured,
    test: signal => testProvider(id, signal),
    operations: structuredClone(definitions[id]),
    run: (name, args, signal) => runProvider(id, name, args, signal),
  }));
}
