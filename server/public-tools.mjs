/* Read-only public-data adapters. Documentation checked via Exa against official docs:
 * World Bank (keyless; v2, date ranges, JSON, paging):
 * https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation
 * https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures
 * NWS (required identifying User-Agent, optional contact; points -> grid forecast):
 * https://www.weather.gov/documentation/services-web-api
 * https://github.com/weather-gov/api/blob/master/general-faqs.md
 * OpenAlex (search, select, per_page; verified key and Bearer authentication):
 * https://developers.openalex.org/guides/authentication
 * https://help.openalex.org/api/searching/
 * https://docs.openalex.org/how-to-use-the-api/api-overview
 * NOTE: current OpenAlex docs allow anonymous casual queries (older February 2026
 * announcements said keys were required). This server adapter deliberately requires
 * a server-supplied key for production use; no anonymous fallback or fabricated data.
 * Caller should pass process.env.OPENALEX_API_KEY, never a client/model argument.
 */

const MAX_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ITEMS = 20;
const TIMEOUT_MS = 10_000;
const SERVICES = ['World Bank', 'Weather', 'OpenAlex'];
const TOOL_SERVICE = Object.freeze({ world_bank_indicator: 'World Bank', weather_forecast: 'Weather', openalex_search: 'OpenAlex' });
const HOSTS = new Set(['api.worldbank.org', 'api.weather.gov', 'api.openalex.org']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
class PublicToolError extends Error {
  constructor(code, message) { super(message); this.name = 'PublicToolError'; this.code = code; }
}
const fail = (code, message) => { throw new PublicToolError(code, message); };
const definition = (name, description, properties) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } } });

function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(new PublicToolError('ABORTED', 'Public-data request aborted.'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new PublicToolError('ABORTED', 'Public-data request aborted.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// Do not trust a linked URL merely because it came from an official upstream.
function forecastUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/-?\d{1,4},-?\d{1,4}\/forecast$/.test(value)) fail('UNSAFE_URL', 'NWS returned an unsupported forecast URL.');
  const url = new URL(value);
  if (url.origin !== 'https://api.weather.gov' || url.username || url.password || url.search || url.hash || url.href !== value) fail('UNSAFE_URL', 'NWS returned an unsupported forecast URL.');
  return url;
}

/**
 * No persistence or client credentials. Definitions include only enabled/configured
 * tools. Capabilities describe all services; configured means prerequisites exist,
 * not that a remote key has been verified. execute rejects with a safe Error/code;
 * errors are never returned as successful data. At most 2 GETs per execution (hard
 * ceiling 3), one 10-second deadline including body reads, no retries/redirects.
 * All returned text is untrusted upstream data, not instructions or sanitized HTML.
 */
export function createPublicTools({ enabled = [], fetchImpl = globalThis.fetch, openAlexApiKey, userAgent } = {}) {
  const permissions = new Set(Array.isArray(enabled) ? enabled.filter(name => SERVICES.includes(name)) : []);
  const transportReady = typeof fetchImpl === 'function';
  const hasKey = typeof openAlexApiKey === 'string' && /^[A-Za-z0-9._~+/-]{1,512}={0,2}$/.test(openAlexApiKey);
  const ua = userAgent === undefined ? 'Rivulet-PublicData/1.0' : userAgent;
  const validUa = typeof ua === 'string' && ua.trim().length > 0 && ua.length <= 200 && /^[\x20-\x7e]+$/.test(ua);
  const maxYear = Math.min(2100, new Date().getUTCFullYear() + 1);
  const catalog = [
    definition('world_bank_indicator', 'Read a single World Bank annual indicator for one 2/3-letter country code. At most 20 consecutive years/results; missing values remain null.', {
      country: { type: 'string', pattern: '^[A-Za-z]{2,3}$', minLength: 2, maxLength: 3 },
      indicator: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$', minLength: 1, maxLength: 80 },
      startYear: { type: 'integer', minimum: 1900, maximum: maxYear },
      endYear: { type: 'integer', minimum: 1900, maximum: maxYear },
    }),
    definition('weather_forecast', 'Read the NWS forecast for US/NWS-covered coordinates. Global coordinates are accepted but locations outside coverage return an upstream error. At most 20 forecast periods.', {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
    }),
    definition('openalex_search', 'Search scholarly works in OpenAlex; returns the first 20 works, selected metadata and up to 5 author names each. Requires a server-configured API key.', {
      query: { type: 'string', minLength: 1, maxLength: 300 },
    }),
  ];
  const capabilities = SERVICES.map(service => {
    const configured = transportReady && (service !== 'Weather' || validUa) && (service !== 'OpenAlex' || hasKey);
    let reason = !transportReady ? 'Fetch transport unavailable.' : service === 'Weather' && !validUa ? 'A nonempty ASCII application User-Agent of at most 200 characters is required.' : service === 'OpenAlex' && !hasKey ? 'Set a valid server OPENALEX_API_KEY; this adapter does not use anonymous OpenAlex access.' : service === 'Weather' ? 'Keyless NWS access with an identifying application User-Agent; US/NWS coverage only.' : service === 'World Bank' ? 'Keyless World Bank Indicators v2 access.' : 'Server API key supplied; activation, quota and validity are checked by OpenAlex on use.';
    if (!permissions.has(service)) reason = `Disabled. ${reason}`;
    return { service, enabled: permissions.has(service), configured, reason };
  });
  const available = catalog.filter(d => capabilities.some(c => c.service === TOOL_SERVICE[d.function.name] && c.enabled && c.configured));
  const definitions = structuredClone(available);

  // Never echo keys, even if an upstream reflects one in a projected text field.
  const secretForms = hasKey ? [...new Set([openAlexApiKey, encodeURIComponent(openAlexApiKey), new URLSearchParams({ key: openAlexApiKey }).toString().slice(4)])].sort((a, b) => b.length - a.length) : [];
  const text = (value, max = 200) => {
    if (typeof value !== 'string') return null;
    // Examine only a bounded prefix; replace secrets before truncating that prefix.
    let safe = value.slice(0, max + Math.max(0, ...secretForms.map(secret => secret.length)));
    for (const secret of secretForms) safe = safe.split(secret).join('[redacted]');
    return safe.slice(0, max);
  };
  const urlText = value => {
    const candidate = text(value, 1000);
    if (!candidate) return null;
    try { const url = new URL(candidate); return url.protocol === 'https:' && !url.username && !url.password ? candidate : null; } catch { return null; }
  };

  function validate(name, args) {
    const schema = available.find(d => d.function.name === name)?.function.parameters;
    if (!schema) fail('UNAVAILABLE', 'Public-data tool unavailable, disabled or unconfigured.');
    if (!plain(args) || Reflect.ownKeys(args).some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !Object.hasOwn(args, k))) fail('INVALID_ARGUMENTS', 'Invalid public-data tool arguments.');
    // Reject accessors as well as JSON-level extra properties; never invoke getters.
    if (Object.values(Object.getOwnPropertyDescriptors(args)).some(d => !Object.hasOwn(d, 'value'))) fail('INVALID_ARGUMENTS', 'Invalid public-data tool arguments.');
    for (const [key, spec] of Object.entries(schema.properties)) {
      const value = args[key];
      if (spec.type === 'string') {
        if (typeof value !== 'string' || value.length < spec.minLength || value.length > spec.maxLength || !value.trim() || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) || (spec.pattern && !new RegExp(spec.pattern).test(value))) fail('INVALID_ARGUMENTS', 'Invalid public-data string argument.');
      } else if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value)) || value < spec.minimum || value > spec.maximum) fail('INVALID_ARGUMENTS', 'Invalid public-data numeric argument or range.');
    }
    if (name === 'world_bank_indicator' && (args.endYear < args.startYear || args.endYear - args.startYear >= MAX_ITEMS)) fail('INVALID_ARGUMENTS', 'Year range must be ordered and contain at most 20 years.');
    if (name === 'world_bank_indicator' && args.country.toLowerCase() === 'all') fail('INVALID_ARGUMENTS', 'A single country code is required; all is not supported.');
  }

  async function execute(name, args, signal) {
    validate(name, args);
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_ARGUMENTS', 'Invalid cancellation signal.');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (signal?.aborted) fail('CANCELLED', 'Public-data request cancelled.');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let requests = 0;

    async function getJson(url, headers = {}) {
      if (++requests > 3) fail('REQUEST_LIMIT', 'Public-data request limit exceeded.');
      if (!(url instanceof URL) || url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) fail('UNSAFE_URL', 'Unsupported public-data endpoint.');
      if (controller.signal.aborted) fail('ABORTED', 'Public-data request aborted.');
      const response = await waitFor(Promise.resolve().then(() => fetchImpl(url.href, {
        method: 'GET', headers: { Accept: 'application/json', ...headers }, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      })), controller.signal);
      let reader;
      try {
        if (response?.redirected || (response?.status >= 300 && response.status < 400) || (response?.url && response.url !== url.href)) fail('REDIRECT_BLOCKED', 'Public-data redirects are not permitted.');
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail('INVALID_RESPONSE', 'Public-data service returned an invalid response.');
        if (response.status < 200 || response.status >= 300) fail('UPSTREAM_HTTP', `Public-data service returned HTTP ${response.status}.`);
        const length = response.headers?.get?.('content-length');
        if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) fail('RESPONSE_TOO_LARGE', 'Public-data response exceeds 1 MiB.');
        if (!response.body || typeof response.body.getReader !== 'function') fail('INVALID_RESPONSE', 'Public-data service returned an unreadable response.');
        reader = response.body.getReader();
        // Fixed storage also bounds memory if an upstream emits many tiny chunks.
        const joined = new Uint8Array(MAX_BYTES);
        let bytes = 0;
        for (;;) {
          const { value, done } = await waitFor(reader.read(), controller.signal);
          if (value) {
            if (!(value instanceof Uint8Array)) fail('INVALID_RESPONSE', 'Public-data service returned an unreadable response.');
            if (bytes + value.byteLength > MAX_BYTES) fail('RESPONSE_TOO_LARGE', 'Public-data response exceeds 1 MiB.');
            joined.set(value, bytes);
            bytes += value.byteLength;
          }
          if (done) break;
        }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined.subarray(0, bytes))); }
        catch { fail('INVALID_RESPONSE', 'Public-data service returned invalid JSON.'); }
      } finally {
        // Do not await cancellation: a hostile/stalled body must not extend deadline.
        if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ } }
        else { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* best effort */ } }
      }
    }
    function finish(service, sourceUrl, results, metadata, truncated = false) {
      const output = { status: 'ok', service, sourceUrl: text(sourceUrl, 4000), retrievedAt: new Date().toISOString(), ...metadata, results, truncated };
      while (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_RESULT_BYTES && output.results.length) { output.results.pop(); output.truncated = true; }
      return output;
    }
    try {
      if (name === 'world_bank_indicator') {
        const country = args.country.toUpperCase(), indicator = args.indicator.toUpperCase();
        const url = new URL(`https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}`);
        url.search = new URLSearchParams({ format: 'json', date: `${args.startYear}:${args.endYear}`, per_page: String(MAX_ITEMS), page: '1' }).toString();
        const data = await getJson(url);
        if (!Array.isArray(data) || !plain(data[0]) || Object.hasOwn(data[0], 'message') || (data[1] !== null && !Array.isArray(data[1])) || data.length !== 2) fail('INVALID_RESPONSE', 'World Bank returned an invalid indicator response.');
        const rows = data[1] || [];
        if (rows.slice(0, MAX_ITEMS).some(row => !plain(row) || typeof row.date !== 'string' || !/^\d{4}$/.test(row.date) || +row.date < args.startYear || +row.date > args.endYear || !plain(row.indicator) || typeof row.indicator.id !== 'string' || row.indicator.id.toUpperCase() !== indicator || !plain(row.country) || ![row.country.id, row.countryiso3code].some(code => typeof code === 'string' && code.toUpperCase() === country) || (row.value !== null && number(row.value) === null))) fail('INVALID_RESPONSE', 'World Bank returned invalid indicator observations.');
        const results = rows.slice(0, MAX_ITEMS).map(row => ({ countryCode: text(row.countryiso3code || row.country.id, 3), country: text(row.country.value, 160), indicatorCode: text(row.indicator.id, 80), indicator: text(row.indicator.value, 300), year: +row.date, value: number(row.value), unit: text(row.unit, 80), observationStatus: text(row.obs_status, 40) }));
        return finish('World Bank', url.href, results, { country, indicator, startYear: args.startYear, endYear: args.endYear, total: count(data[0].total), lastUpdated: text(data[0].lastupdated, 40) }, rows.length > MAX_ITEMS || data[0].pages > 1 || data[0].total > results.length);
      }
      if (name === 'weather_forecast') {
        const latitude = Number(args.latitude.toFixed(4)), longitude = Number(args.longitude.toFixed(4));
        const url = new URL(`https://api.weather.gov/points/${latitude},${longitude}`);
        const headers = { Accept: 'application/geo+json', 'User-Agent': ua };
        const point = await getJson(url, headers);
        if (!plain(point?.properties)) fail('INVALID_RESPONSE', 'NWS returned an invalid point response.');
        const forecast = forecastUrl(point.properties.forecast);
        const data = await getJson(forecast, headers);
        if (!plain(data?.properties) || !Array.isArray(data.properties.periods) || data.properties.periods.slice(0, MAX_ITEMS).some(period => !plain(period) || typeof period.name !== 'string' || typeof period.startTime !== 'string' || number(period.temperature) === null)) fail('INVALID_RESPONSE', 'NWS returned an invalid forecast response.');
        const results = data.properties.periods.slice(0, MAX_ITEMS).map(period => ({ number: count(period.number), name: text(period.name, 100), startTime: text(period.startTime, 40), endTime: text(period.endTime, 40), isDaytime: typeof period.isDaytime === 'boolean' ? period.isDaytime : null, temperature: number(period.temperature), temperatureUnit: text(period.temperatureUnit, 8), precipitationProbability: number(period.probabilityOfPrecipitation?.value), windSpeed: text(period.windSpeed, 80), windDirection: text(period.windDirection, 20), shortForecast: text(period.shortForecast, 200), detailedForecast: text(period.detailedForecast, 1200) }));
        const location = point.properties.relativeLocation?.properties;
        return finish('Weather', forecast.href, results, { latitude, longitude, location: { city: text(location?.city, 160), state: text(location?.state, 40) }, updatedAt: text(data.properties.updated || data.properties.updateTime, 40), units: text(data.properties.units, 20) }, data.properties.periods.length > MAX_ITEMS);
      }
      const url = new URL('https://api.openalex.org/works');
      url.search = new URLSearchParams({ search: args.query.trim(), per_page: String(MAX_ITEMS), page: '1', select: 'id,title,publication_year,publication_date,doi,cited_by_count,type,open_access,primary_location,authorships' }).toString();
      const data = await getJson(url, { Authorization: `Bearer ${openAlexApiKey}` });
      if (!plain(data) || Object.hasOwn(data, 'error') || !plain(data.meta) || !Array.isArray(data.results) || data.results.slice(0, MAX_ITEMS).some(work => !plain(work) || typeof work.id !== 'string' || !/^https:\/\/openalex\.org\/W\d+$/.test(work.id) || typeof work.title !== 'string')) fail('INVALID_RESPONSE', 'OpenAlex returned an invalid works response.');
      const results = data.results.slice(0, MAX_ITEMS).map(work => ({ id: text(work.id, 100), title: text(work.title, 500), publicationYear: count(work.publication_year), publicationDate: text(work.publication_date, 40), doi: urlText(work.doi), citedByCount: count(work.cited_by_count), type: text(work.type, 60), isOpenAccess: typeof work.open_access?.is_oa === 'boolean' ? work.open_access.is_oa : null, landingPageUrl: urlText(work.primary_location?.landing_page_url), authors: (Array.isArray(work.authorships) ? work.authorships : []).slice(0, 5).map(a => text(a?.author?.display_name, 160)).filter(Boolean) }));
      return finish('OpenAlex', url.href, results, { query: text(args.query.trim(), 300), total: count(data.meta.count) }, data.results.length > MAX_ITEMS || data.meta.count > results.length);
    } catch (error) {
      if (timedOut) fail('TIMEOUT', 'Public-data request timed out after 10 seconds.');
      if (signal?.aborted) fail('CANCELLED', 'Public-data request cancelled.');
      if (error instanceof PublicToolError) throw error;
      // Never expose fetch exceptions, URLs with credentials, upstream bodies or causes.
      fail('NETWORK_ERROR', 'Public-data request failed.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
  return { definitions, execute, capabilities };
}
