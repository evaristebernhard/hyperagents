import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicTools } from './public-tools.mjs';

// Every transport is an injected mock. No live requests or environment credentials.
const KEY = 'test-only-openalex-key_987654321';
const enabled = ['World Bank', 'Weather', 'OpenAlex'];
const wbArgs = { country: 'USA', indicator: 'SP.POP.TOTL', startYear: 2020, endYear: 2021 };
const coords = { latitude: 39.7456123, longitude: -97.0892456 };
const FORECAST = 'https://api.weather.gov/gridpoints/TOP/31,80/forecast';
const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const row = (year = 2021) => ({ indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: 'US', value: 'United States' }, countryiso3code: 'USA', date: String(year), value: year === 2021 ? 331893745 : null, unit: '', obs_status: '', secret: 'discard-me' });
const wb = () => [{ page: 1, pages: 1, per_page: 20, total: 2, lastupdated: '2026-10-07' }, [row(), row(2020)]];
const point = (forecast = FORECAST) => ({ properties: { forecast, forecastHourly: 'https://evil.example/hourly', forecastGridData: 'https://evil.example/grid', relativeLocation: { properties: { city: 'Topeka', state: 'KS' } }, arbitrary: 'discard-me' } });
const period = (i = 1) => ({ number: i, name: 'Tonight', startTime: '2026-10-27T18:00:00-05:00', endTime: '2026-10-28T06:00:00-05:00', isDaytime: false, temperature: 55, temperatureUnit: 'F', probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 20 }, windSpeed: '5 to 10 mph', windDirection: 'NE', shortForecast: 'Partly cloudy', detailedForecast: 'Partly cloudy, with a low around 55.', icon: 'https://evil.example/unused-icon', privateField: 'discard-me' });
const forecast = (periods = [period()]) => ({ properties: { updated: '2026-10-27T20:00:00+00:00', units: 'us', periods }, arbitrary: 'discard-me' });
const work = (i = 1) => ({ id: `https://openalex.org/W${i}`, title: 'A study of rivers', publication_year: 2024, publication_date: '2024-01-15', doi: 'https://doi.org/10.1234/example', cited_by_count: 42, type: 'article', open_access: { is_oa: true }, primary_location: { landing_page_url: 'https://example.org/paper' }, authorships: [{ author: { display_name: 'Ada Researcher', id: 'unused' } }], abstract_inverted_index: { 'discard-me': [1] }, privateField: 'discard-me' });
const works = (results = [work()]) => ({ meta: { count: results.length, page: 1, per_page: 20 }, results, privateField: 'discard-me' });
function runtime(fetchImpl, options = {}) { return createPublicTools({ enabled, fetchImpl, openAlexApiKey: KEY, ...options }); }
function queue(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'unexpected additional request');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, fetchImpl };
}
const errorCode = (code, pattern) => error => error instanceof Error && error.code === code && (!pattern || pattern.test(error.message));
const assertBounded = result => {
  assert.equal(result.status, 'ok');
  assert.ok(result.results.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.match(result.sourceUrl, /^https:\/\/api\.(worldbank\.org|weather\.gov|openalex\.org)\//);
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
};

test('definitions are real OpenAI functions, permission/configuration gated, with independent schemas', async () => {
  const transport = queue();
  const r = runtime(transport.fetchImpl);
  assert.deepEqual(r.definitions.map(d => d.function.name), ['world_bank_indicator', 'weather_forecast', 'openalex_search']);
  for (const d of r.definitions) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.parameters.type, 'object');
    assert.equal(d.function.parameters.additionalProperties, false);
    assert.deepEqual(d.function.parameters.required, Object.keys(d.function.parameters.properties));
  }
  assert.deepEqual(r.capabilities.map(c => c.service), enabled);
  assert.ok(r.capabilities.every(c => c.enabled && c.configured && typeof c.reason === 'string'));
  const none = runtime(transport.fetchImpl, { enabled: [] });
  assert.deepEqual(none.definitions, []);
  assert.ok(none.capabilities.every(c => !c.enabled));
  await assert.rejects(none.execute('weather_forecast', coords), errorCode('UNAVAILABLE'));
  await assert.rejects(r.execute('fetch_url', { url: 'https://evil.example' }), errorCode('UNAVAILABLE'));
  assert.equal(transport.calls.length, 0);
  const only = runtime(transport.fetchImpl, { enabled: ['Weather', 'Browser', 'World Bank', 'Weather'] });
  assert.deepEqual(only.definitions.map(d => d.function.name), ['world_bank_indicator', 'weather_forecast']);
  const noKey = createPublicTools({ enabled, fetchImpl: transport.fetchImpl });
  assert.deepEqual(noKey.definitions.map(d => d.function.name), ['world_bank_indicator', 'weather_forecast']);
  assert.equal(noKey.capabilities.find(c => c.service === 'OpenAlex').configured, false);
  assert.match(noKey.capabilities.find(c => c.service === 'OpenAlex').reason, /OPENALEX_API_KEY/);
  await assert.rejects(noKey.execute('openalex_search', { query: 'rivers' }), errorCode('UNAVAILABLE'));
  for (const key of ['', ' ', '\nsecret', '\ud800', 123, {}, 'a'.repeat(515)]) {
    const badKey = runtime(transport.fetchImpl, { openAlexApiKey: key });
    assert.equal(badKey.capabilities.find(c => c.service === 'OpenAlex').configured, false);
    await assert.rejects(badKey.execute('openalex_search', { query: 'rivers' }), errorCode('UNAVAILABLE'));
  }
  const noFetch = runtime(null);
  assert.deepEqual(noFetch.definitions, []);
  assert.ok(noFetch.capabilities.every(c => !c.configured));
  assert.equal(transport.calls.length, 0);
});

test('World Bank builds one fixed HTTPS request and projects real observations including missing values', async () => {
  const data = wb();
  const transport = queue(json(data));
  const r = runtime(transport.fetchImpl);
  // Publicly returned definitions cannot change private execution permissions/schema.
  r.definitions[0].function.parameters.additionalProperties = true;
  r.definitions[0].function.parameters.properties.country.maxLength = 999;
  const result = await r.execute('world_bank_indicator', { ...wbArgs, country: 'us', indicator: 'sp.pop.totl' });
  assertBounded(result);
  assert.equal(transport.calls.length, 1);
  const { url, options } = transport.calls[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://api.worldbank.org');
  assert.equal(parsed.pathname, '/v2/country/US/indicator/SP.POP.TOTL');
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { format: 'json', date: '2020:2021', per_page: '20', page: '1' });
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(result.results[0].value, 331893745);
  assert.equal(result.results[1].value, null);
  assert.equal(result.results[0].year, 2021);
  assert.equal(result.results[0].indicatorCode, 'SP.POP.TOTL');
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.lastUpdated, '2026-10-07');
  assert.ok(!JSON.stringify(result).includes('discard-me'));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('World Bank supports truthful empty responses and caps upstream arrays at 20 with truncation metadata', async () => {
  const transport = queue(json([{ total: 0, pages: 0 }, null]), json([{ total: 60, pages: 3 }, Array.from({ length: 40 }, () => row())]));
  const r = runtime(transport.fetchImpl);
  assert.deepEqual((await r.execute('world_bank_indicator', wbArgs)).results, []);
  const result = await r.execute('world_bank_indicator', wbArgs);
  assertBounded(result);
  assert.equal(result.results.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(transport.calls.length, 2); // no automatic paging or retries
});

test('NWS uses only points -> validated forecast, rounds coordinates to supported precision and projects periods', async () => {
  const transport = queue(json(point()), json(forecast()));
  const result = await runtime(transport.fetchImpl).execute('weather_forecast', coords);
  assertBounded(result);
  assert.deepEqual(transport.calls.map(c => c.url), ['https://api.weather.gov/points/39.7456,-97.0892', FORECAST]);
  for (const { options } of transport.calls) {
    assert.equal(options.headers['User-Agent'], 'Rivulet-PublicData/1.0');
    assert.ok(!options.headers['User-Agent'].includes('@'));
    assert.equal(options.headers.Accept, 'application/geo+json');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
  }
  assert.equal(transport.calls[0].options.signal, transport.calls[1].options.signal);
  assert.equal(result.sourceUrl, FORECAST);
  assert.deepEqual(result.location, { city: 'Topeka', state: 'KS' });
  assert.equal(result.results[0].temperature, 55);
  assert.equal(result.results[0].temperatureUnit, 'F');
  assert.equal(result.results[0].precipitationProbability, 20);
  assert.ok(!JSON.stringify(result).includes('evil.example'));
  assert.ok(!JSON.stringify(result).includes('discard-me'));
});

test('NWS accepts a caller identifying User-Agent but rejects header injection and invalid configuration', async () => {
  const transport = queue(json(point()), json(forecast()));
  await runtime(transport.fetchImpl, { userAgent: 'Acme-Rivulet/2.0 (https://example.org)' }).execute('weather_forecast', coords);
  assert.ok(transport.calls.every(c => c.options.headers['User-Agent'] === 'Acme-Rivulet/2.0 (https://example.org)'));
  for (const userAgent of ['', '   ', 'app\r\nAuthorization: secret', 123, null, 'x'.repeat(201), 'réplica']) {
    const r = runtime(transport.fetchImpl, { userAgent });
    assert.equal(r.capabilities.find(c => c.service === 'Weather').configured, false);
    await assert.rejects(r.execute('weather_forecast', coords), errorCode('UNAVAILABLE'));
  }
  assert.equal(transport.calls.length, 2);
});

test('OpenAlex uses documented search/select/page parameters and Bearer auth without credentials in URLs/results', async () => {
  const data = works();
  data.results[0].authorships = Array.from({ length: 10 }, (_, i) => ({ author: { display_name: `Author ${i}` }, institutions: ['unused'] }));
  const transport = queue(json(data));
  const result = await runtime(transport.fetchImpl).execute('openalex_search', { query: '  rivers & lakes / climate?  ' });
  assertBounded(result);
  const call = transport.calls[0], url = new URL(call.url);
  assert.equal(url.origin, 'https://api.openalex.org');
  assert.equal(url.pathname, '/works');
  assert.equal(url.searchParams.get('search'), 'rivers & lakes / climate?');
  assert.equal(url.searchParams.get('per_page'), '20');
  assert.equal(url.searchParams.get('page'), '1');
  assert.match(url.searchParams.get('select'), /title/);
  assert.equal(url.searchParams.has('api_key'), false);
  assert.equal(call.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.method, 'GET');
  assert.ok(!call.url.includes(KEY));
  assert.equal(result.query, 'rivers & lakes / climate?');
  assert.equal(result.results[0].title, 'A study of rivers');
  assert.equal(result.results[0].publicationYear, 2024);
  assert.equal(result.results[0].authors.length, 5);
  assert.equal(result.results[0].isOpenAccess, true);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes('discard-me'));
});

test('OpenAlex caps first-page results and removes non-HTTPS/credentialed output links, never follows them', async () => {
  const data = works(Array.from({ length: 25 }, (_, i) => work(i + 1)));
  data.results[0].doi = 'javascript:alert(1)';
  data.results[0].primary_location.landing_page_url = 'https://username:secret@evil.example/paper';
  data.meta.count = 100000;
  const transport = queue(json(data));
  const result = await runtime(transport.fetchImpl).execute('openalex_search', { query: 'https://evil.example/?api_key=not-a-key' });
  assertBounded(result);
  assert.equal(result.results.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(result.results[0].doi, null);
  assert.equal(result.results[0].landingPageUrl, null);
  assert.equal(transport.calls.length, 1);
  assert.equal(new URL(transport.calls[0].url).host, 'api.openalex.org');
});

test('strict runtime argument validation rejects wrong types, extras, paths and ranges before fetching', async () => {
  const transport = queue();
  const bad = [
    ['world_bank_indicator', null], ['world_bank_indicator', []], ['world_bank_indicator', '{}'],
    ['world_bank_indicator', { ...wbArgs, url: 'http://127.0.0.1' }],
    ['world_bank_indicator', { ...wbArgs, country: 'all' }],
    ...['USA;CHN', '../us', 'http://localhost', '%2fus', 'U', 'USA1', '123', 'USA\n', ' US'].map(country => ['world_bank_indicator', { ...wbArgs, country }]),
    ...['SP.POP.TOTL;OTHER', '../secret', '%2f', 'https://evil.example', 'SP?source=1', 'x'.repeat(81)].map(indicator => ['world_bank_indicator', { ...wbArgs, indicator }]),
    ...['2020', null, true, NaN, Infinity, 2020.5, 1899, 2101].map(startYear => ['world_bank_indicator', { ...wbArgs, startYear }]),
    ['world_bank_indicator', { ...wbArgs, startYear: 2022 }],
    ['world_bank_indicator', { ...wbArgs, startYear: 1990 }],
    ['world_bank_indicator', { country: 'US', indicator: 'SP.POP.TOTL', startYear: 2000 }],
    ['weather_forecast', { latitude: 0 }], ['weather_forecast', { ...coords, forecastUrl: FORECAST }],
    ...[NaN, Infinity, -Infinity, '39', null, 90.0001, -90.0001].map(latitude => ['weather_forecast', { ...coords, latitude }]),
    ...[NaN, '0', 180.01, -180.01].map(longitude => ['weather_forecast', { ...coords, longitude }]),
    ...['', '   ', 'x'.repeat(301), 'query\nheader', '\u0000', '\ud800', 123, {}, null].map(query => ['openalex_search', { query }]),
    ['openalex_search', { query: 'rivers', api_key: KEY }],
    ['openalex_search', { query: 'rivers', apiKey: KEY }],
    ['openalex_search', { query: 'rivers', signal: {} }],
  ];
  const r = runtime(transport.fetchImpl);
  for (const [name, args] of bad) await assert.rejects(r.execute(name, args), errorCode('INVALID_ARGUMENTS'), `${name}: ${JSON.stringify(args)}`);
  const symbolic = { query: 'rivers', [Symbol('url')]: 'http://localhost' };
  await assert.rejects(r.execute('openalex_search', symbolic), errorCode('INVALID_ARGUMENTS'));
  const accessor = Object.defineProperty({}, 'query', { get() { throw new Error('getter must not run'); }, enumerable: true });
  await assert.rejects(r.execute('openalex_search', accessor), errorCode('INVALID_ARGUMENTS'));
  const inherited = Object.create({ query: 'rivers' });
  await assert.rejects(r.execute('openalex_search', inherited), errorCode('INVALID_ARGUMENTS'));
  await assert.rejects(r.execute('weather_forecast', coords, {}), errorCode('INVALID_ARGUMENTS'));
  assert.equal(transport.calls.length, 0);
});

test('NWS geographic boundaries and negative zero generate safe canonical points URLs', async () => {
  for (const [latitude, longitude, expected] of [[90, 180, '90,180'], [-90, -180, '-90,-180'], [-0, -0, '0,0']]) {
    const transport = queue(json(point()), json(forecast()));
    await runtime(transport.fetchImpl).execute('weather_forecast', { latitude, longitude });
    assert.equal(transport.calls[0].url, `https://api.weather.gov/points/${expected}`);
  }
});

test('NWS blocks foreign, relative, non-HTTPS, credentialed, noncanonical and unexpected forecast URLs', async () => {
  const bad = [
    'https://evil.example/gridpoints/TOP/31,80/forecast', 'http://api.weather.gov/gridpoints/TOP/31,80/forecast',
    'https://api.weather.gov.evil.example/gridpoints/TOP/31,80/forecast', 'https://api.weather.gov@evil.example/gridpoints/TOP/31,80/forecast',
    'https://key:secret@api.weather.gov/gridpoints/TOP/31,80/forecast', 'https://api.weather.gov:443/gridpoints/TOP/31,80/forecast',
    'https://api.weather.gov:444/gridpoints/TOP/31,80/forecast', '//api.weather.gov/gridpoints/TOP/31,80/forecast',
    '/gridpoints/TOP/31,80/forecast', 'https://127.0.0.1/gridpoints/TOP/31,80/forecast',
    'https://api.weather.gov/gridpoints/TOP/31,80/forecast/hourly', 'https://api.weather.gov/points/0,0',
    'https://api.weather.gov/gridpoints/TOP/31,80/forecast?url=http://localhost', `${FORECAST}#fragment`,
    'https://api.weather.gov/other/../gridpoints/TOP/31,80/forecast', 'https://api.weather.gov/gridpoints/TOP/%33%31,80/forecast',
    'https://api.weather.gov\\gridpoints\\TOP\\31,80\\forecast', 'https://api.weather.gov./gridpoints/TOP/31,80/forecast',
    'https://API.WEATHER.GOV/gridpoints/TOP/31,80/forecast', `https://api.weather.gov/gridpoints/${KEY}/31,80/forecast`,
    'file:///etc/passwd', 'data:application/json,{}', '', null, {},
  ];
  for (const value of bad) {
    const transport = queue(json(point(value)));
    await assert.rejects(runtime(transport.fetchImpl).execute('weather_forecast', coords), errorCode('UNSAFE_URL'));
    assert.equal(transport.calls.length, 1);
  }
});

test('redirect statuses, redirected responses and mismatched delivered URLs fail without following links', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const transport = queue(new Response('private upstream body', { status, headers: { Location: 'http://127.0.0.1/secret' } }));
    await assert.rejects(runtime(transport.fetchImpl).execute('world_bank_indicator', wbArgs), errorCode('REDIRECT_BLOCKED'));
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].options.redirect, 'error');
  }
  for (const props of [{ redirected: true }, { url: 'https://evil.example/data' }, { url: 'https://api.worldbank.org/other' }]) {
    const response = json(wb());
    for (const [key, value] of Object.entries(props)) Object.defineProperty(response, key, { value });
    const transport = queue(response);
    await assert.rejects(runtime(transport.fetchImpl).execute('world_bank_indicator', wbArgs), errorCode('REDIRECT_BLOCKED'));
  }
  const nativeRedirect = queue(() => { throw new TypeError(`fetch failed: redirect mode is error ${KEY}`); });
  await assert.rejects(runtime(nativeRedirect.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('NETWORK_ERROR', /^Public-data request failed\.$/));
});

test('NWS second request redirects are blocked too', async () => {
  const transport = queue(json(point()), new Response(KEY, { status: 302, headers: { Location: 'http://localhost' } }));
  await assert.rejects(runtime(transport.fetchImpl).execute('weather_forecast', coords), errorCode('REDIRECT_BLOCKED'));
  assert.equal(transport.calls.length, 2);
});

test('HTTP failures never expose upstream bodies, URL credentials, exceptions, or causes', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const transport = queue(new Response(`Secret body ${KEY} api_key=${KEY}`, { status }));
    await assert.rejects(runtime(transport.fetchImpl).execute('openalex_search', { query: 'rivers' }), error => {
      assert.equal(error.code, 'UPSTREAM_HTTP');
      assert.equal(error.message, `Public-data service returned HTTP ${status}.`);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error).includes(KEY));
      assert.ok(!JSON.stringify(error).includes(KEY));
      return true;
    });
    assert.equal(transport.calls.length, 1);
  }
  const transport = queue(() => { throw new Error(`SECRET ${KEY} https://api.openalex.org/?api_key=${KEY}`); });
  await assert.rejects(runtime(transport.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('NETWORK_ERROR', /^Public-data request failed\.$/));
});

test('invalid JSON, API-level errors, and malformed service envelopes are errors, not successful data', async () => {
  const cases = [
    ['world_bank_indicator', wbArgs, { message: `bad ${KEY}` }],
    ['world_bank_indicator', wbArgs, [{ message: [{ id: '120', value: KEY }] }]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), value: 'fake' }]]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), indicator: { id: 123 } }]]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), date: 2021 }]]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), date: '9999' }]]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), countryiso3code: 'CHN', country: { id: 'CN' } }]]],
    ['world_bank_indicator', wbArgs, [{ total: 1 }, [{ ...row(), indicator: { id: 'WRONG' } }]]],
    ['weather_forecast', coords, { properties: null }],
    ['openalex_search', { query: 'rivers' }, { error: KEY, meta: {}, results: [] }],
    ['openalex_search', { query: 'rivers' }, { results: [] }],
    ['openalex_search', { query: 'rivers' }, works([{ ...work(), id: 'https://evil.example/W1' }])],
  ];
  for (const [name, args, body] of cases) {
    const transport = queue(json(body));
    await assert.rejects(runtime(transport.fetchImpl).execute(name, args), error => errorCode('INVALID_RESPONSE')(error) && !String(error).includes(KEY));
  }
  const malformedForecast = queue(json(point()), json({ properties: { periods: [{ ...period(), temperature: '55' }] } }));
  await assert.rejects(runtime(malformedForecast.fetchImpl).execute('weather_forecast', coords), errorCode('INVALID_RESPONSE'));
  const invalidJson = queue(new Response(`not JSON ${KEY}`));
  await assert.rejects(runtime(invalidJson.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('INVALID_RESPONSE'));
  const invalidUtf8 = queue(new Response(new Uint8Array([0xff, 0xfe, 0xff])));
  await assert.rejects(runtime(invalidUtf8.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('INVALID_RESPONSE'));
});

test('response byte ceilings enforce content-length before reading and actual streamed bytes without trusting headers', async () => {
  const tooLong = queue(new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }));
  await assert.rejects(runtime(tooLong.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('RESPONSE_TOO_LARGE'));
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); }, cancel() { cancelled = true; } });
  const overStream = queue(new Response(stream, { headers: { 'content-length': '2' } }));
  await assert.rejects(runtime(overStream.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  // Byte rather than JS-character count: this is <1 Mi characters, >1 MiB UTF-8.
  const unicode = queue(new Response(JSON.stringify({ value: '界'.repeat(350000) })));
  await assert.rejects(runtime(unicode.fetchImpl).execute('openalex_search', { query: 'rivers' }), errorCode('RESPONSE_TOO_LARGE'));
  // Exactly 1 MiB is accepted, not rejected for the size of its decoded body.
  const valid = JSON.stringify(works());
  const atLimit = queue(new Response(valid + ' '.repeat(1024 * 1024 - Buffer.byteLength(valid))));
  const result = await runtime(atLimit.fetchImpl).execute('openalex_search', { query: 'rivers' });
  assertBounded(result);
});

test('projection caps strings, nested author lists, period counts and total JSON bytes', async () => {
  const largePeriods = Array.from({ length: 30 }, (_, i) => ({ ...period(i + 1), name: 'n'.repeat(1000), detailedForecast: '\u0000'.repeat(3000), shortForecast: 'x'.repeat(500) }));
  const weather = queue(json(point()), json(forecast(largePeriods)));
  const result = await runtime(weather.fetchImpl).execute('weather_forecast', coords);
  assertBounded(result);
  assert.equal(result.truncated, true);
  assert.ok(result.results.length < 20); // final byte cap protects against JSON escape expansion
  assert.ok(result.results.every(p => p.name.length <= 100 && p.detailedForecast.length <= 1200 && p.shortForecast.length <= 200));
  const data = works(Array.from({ length: 30 }, (_, i) => ({ ...work(i + 1), title: '界'.repeat(2000), authorships: Array.from({ length: 10 }, () => ({ author: { display_name: 'n'.repeat(1000) } })) })));
  const openalex = queue(json(data));
  const projected = await runtime(openalex.fetchImpl).execute('openalex_search', { query: 'rivers' });
  assertBounded(projected);
  assert.ok(projected.results.every(w => w.title.length <= 500 && w.authors.length <= 5 && w.authors.every(a => a.length <= 160)));
  assert.equal(projected.truncated, true);
});

test('a reflected API key is redacted from projected fields, query, source URL and errors', async () => {
  const data = works();
  data.results[0].title = `Reflected ${KEY}`;
  data.results[0].doi = `https://doi.org/10.1234/${KEY}`;
  data.results[0].primary_location.landing_page_url = `https://example.org/paper?api_key=${KEY}`;
  data.results[0].authorships[0].author.display_name = KEY;
  const transport = queue(json(data));
  const result = await runtime(transport.fetchImpl).execute('openalex_search', { query: KEY });
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.match(result.results[0].title, /\[redacted\]/);
  assert.equal(result.results[0].authors[0], '[redacted]');
  // A secret crossing the string truncation boundary must not leak a partial key.
  const boundary = works([{ ...work(), title: 'x'.repeat(495) + KEY }]);
  const long = await runtime(queue(json(boundary)).fetchImpl).execute('openalex_search', { query: 'rivers' });
  assert.ok(!long.results[0].title.includes('test-'));
});

test('already-cancelled calls fail before network and cancellation reasons never leak', async () => {
  const controller = new AbortController();
  controller.abort(new Error(KEY));
  const transport = queue();
  await assert.rejects(runtime(transport.fetchImpl).execute('openalex_search', { query: 'rivers' }, controller.signal), errorCode('CANCELLED', /^Public-data request cancelled\.$/));
  assert.equal(transport.calls.length, 0);
});

test('active cancellation rejects even when transport ignores abort, and aborts its request signal', async () => {
  const controller = new AbortController();
  let requestSignal;
  const r = runtime((_url, options) => { requestSignal = options.signal; return new Promise(() => {}); });
  const pending = r.execute('openalex_search', { query: 'rivers' }, controller.signal);
  await Promise.resolve();
  controller.abort(KEY);
  await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(requestSignal.aborted, true);
});

test('10-second timeout includes stalled fetch, rejects ignoring transports, and sanitizes reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const pending = runtime((_url, options) => { requestSignal = options.signal; return new Promise(() => {}); }).execute('openalex_search', { query: 'rivers' });
  const assertion = assert.rejects(pending, errorCode('TIMEOUT', /^Public-data request timed out after 10 seconds\.$/));
  await Promise.resolve();
  t.mock.timers.tick(9999);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await assertion;
  assert.equal(requestSignal.aborted, true);
});

test('deadline includes response body reads and cancels a stalled body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started = false, cancelled = false;
  const stream = new ReadableStream({ pull() { started = true; return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const pending = runtime(async () => new Response(stream)).execute('openalex_search', { query: 'rivers' });
  const assertion = assert.rejects(pending, errorCode('TIMEOUT'));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(started, true);
  t.mock.timers.tick(10000);
  await assertion;
  assert.equal(cancelled, true);
});

test('one deadline covers both weather requests, not a fresh 10 seconds per hop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let resolvePoint;
  const r = runtime(async url => {
    calls.push(url);
    if (calls.length === 1) return new Promise(resolve => { resolvePoint = resolve; });
    return new Promise(() => {});
  });
  const pending = r.execute('weather_forecast', coords);
  const assertion = assert.rejects(pending, errorCode('TIMEOUT'));
  await Promise.resolve();
  t.mock.timers.tick(9000);
  resolvePoint(json(point()));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1000);
  await assertion;
});

test('caller cancellation during body consumption returns an error and releases body', async () => {
  const controller = new AbortController();
  let reading = false, cancelled = false;
  const stream = new ReadableStream({ pull() { reading = true; return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const pending = runtime(async () => new Response(stream)).execute('openalex_search', { query: 'rivers' }, controller.signal);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(reading, true);
  controller.abort(new Error(KEY));
  await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(cancelled, true);
});
