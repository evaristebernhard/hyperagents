/**
 * Isolated contracts for media and map built-ins. This module intentionally does
 * not register providers or perform network calls. A host supplies explicit
 * provider implementations and a credential resolver.
 *
 * Provider implementations must return { ref: { kind: 'file'|'artifact', id,
 * mimeType? }, metadata? }. The adapter never fabricates bytes, URLs, or data.
 */
const CAPABILITIES = Object.freeze({
  image: { name: 'media_image', description: 'Generate or edit an image with an explicitly selected provider.' },
  video: { name: 'media_video', description: 'Generate or edit a video with an explicitly selected provider.' },
  audio: { name: 'media_audio', description: 'Generate audio or dialogue with an explicitly selected provider.' },
  transcribe: { name: 'media_transcribe', description: 'Transcribe an audio file with an explicitly selected provider.' },
  avatar: { name: 'media_avatar', description: 'Generate presenter/avatar video with an explicitly selected provider.' },
  geocode: { name: 'maps_geocode', description: 'Geocode an address with an explicitly selected provider.' },
  places: { name: 'maps_places', description: 'Search places with an explicitly selected provider.' },
  directions: { name: 'maps_directions', description: 'Calculate directions with an explicitly selected provider.' },
  map: { name: 'maps_render', description: 'Render a map artifact with an explicitly selected provider.' },
});
const MEDIA_REF = { type: 'object', properties: { kind: { type: 'string', enum: ['file', 'artifact'] }, id: { type: 'string', minLength: 1, maxLength: 512 }, mimeType: { type: 'string', minLength: 1, maxLength: 127 } }, required: ['kind', 'id'], additionalProperties: false };
const common = { provider: { type: 'string', minLength: 1, maxLength: 80 }, inputRef: MEDIA_REF, prompt: { type: 'string', minLength: 1, maxLength: 20_000 }, source: { type: 'string', minLength: 1, maxLength: 20_000 }, options: { type: 'object', additionalProperties: true } };
const SCHEMAS = Object.freeze({
  image: { ...common, prompt: common.prompt, inputRef: MEDIA_REF },
  video: { ...common, prompt: common.prompt, firstFrameRef: MEDIA_REF, lastFrameRef: MEDIA_REF, referenceRefs: { type: 'array', maxItems: 3, items: MEDIA_REF } },
  audio: { ...common, text: { type: 'string', minLength: 1, maxLength: 100_000 }, script: { type: 'array', minItems: 1, maxItems: 80, items: { type: 'object', properties: { speaker: { type: 'string', minLength: 1, maxLength: 80 }, text: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['speaker', 'text'], additionalProperties: false } } },
  transcribe: { provider: common.provider, inputRef: MEDIA_REF, options: common.options },
  avatar: { provider: common.provider, script: { type: 'string', minLength: 1, maxLength: 100_000 }, options: common.options },
  geocode: { provider: common.provider, address: { type: 'string', minLength: 1, maxLength: 2_000 } },
  places: { provider: common.provider, query: { type: 'string', minLength: 1, maxLength: 2_000 }, location: { type: 'string', minLength: 1, maxLength: 2_000 }, radius: { type: 'number', minimum: 1, maximum: 50_000 } },
  directions: { provider: common.provider, origin: { type: 'string', minLength: 1, maxLength: 2_000 }, destination: { type: 'string', minLength: 1, maxLength: 2_000 }, mode: { type: 'string', enum: ['driving', 'walking', 'bicycling', 'transit'] } },
  map: { provider: common.provider, markers: { type: 'array', maxItems: 100, items: { type: 'object', properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 }, label: { type: 'string', maxLength: 200 } }, required: ['lat', 'lng'], additionalProperties: false } }, routes: { type: 'array', maxItems: 20, items: { type: 'object', properties: { encodedPolyline: { type: 'string', minLength: 1, maxLength: 200_000 }, color: { type: 'string', maxLength: 20 } }, required: ['encodedPolyline'], additionalProperties: false } } },
});
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
export function mediaMapsDefinitions({ providers = {} } = {}) {
  const ids = Object.keys(providers).filter(id => /^[a-z][a-z0-9._-]{0,79}$/.test(id));
  return Object.entries(CAPABILITIES).map(([kind, spec]) => ({ type: 'function', function: { name: spec.name, description: `${spec.description} Providers: ${ids.length ? ids.join(', ') : 'none configured'}.`, parameters: { type: 'object', properties: { ...SCHEMAS[kind], provider: { type: 'string', enum: ids } }, required: ['provider', ...requiredFor(kind)], additionalProperties: false } } }));
}
function requiredFor(kind) { return ({ image: ['prompt'], video: ['prompt'], audio: [], transcribe: ['inputRef'], avatar: ['script'], geocode: ['address'], places: ['query'], directions: ['origin', 'destination'], map: [] })[kind]; }
function validateShape(schema, value, path = 'arguments', required = []) {
  if (!plain(value)) fail('INVALID_ARGUMENTS', `${path} must be an object.`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('INVALID_ARGUMENTS', `Missing ${path}.${key}.`);
  for (const key of Object.keys(value)) if (!Object.hasOwn(schema, key)) fail('INVALID_ARGUMENTS', `Unexpected ${path}.${key}.`);
  for (const [key, spec] of Object.entries(schema)) {
    if (!Object.hasOwn(value, key)) continue;
    const x = value[key];
    if (spec.type === 'string' && (typeof x !== 'string' || x.length < (spec.minLength ?? 0) || x.length > (spec.maxLength ?? Infinity) || (spec.enum && !spec.enum.includes(x)))) fail('INVALID_ARGUMENTS', `Invalid ${path}.${key}.`);
    if (spec.type === 'number' && (typeof x !== 'number' || !Number.isFinite(x) || (spec.minimum !== undefined && x < spec.minimum) || (spec.maximum !== undefined && x > spec.maximum))) fail('INVALID_ARGUMENTS', `Invalid ${path}.${key}.`);
    if (spec.type === 'array' && (!Array.isArray(x) || x.length < (spec.minItems ?? 0) || x.length > (spec.maxItems ?? Infinity))) fail('INVALID_ARGUMENTS', `Invalid ${path}.${key}.`);
    if (spec.type === 'object' && !plain(x)) fail('INVALID_ARGUMENTS', `Invalid ${path}.${key}.`);
    if (spec.items && Array.isArray(x)) x.forEach((item, i) => validateShape(spec.items, item, `${path}.${key}[${i}]`, spec.items.required ?? []));
    if (spec.type === 'object' && spec.properties) validateShape(spec.properties, x, `${path}.${key}`, spec.required ?? []);
  }
}

function checkRef(ref) { if (!plain(ref) || !['file', 'artifact'].includes(ref.kind) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 512 || (ref.mimeType !== undefined && (typeof ref.mimeType !== 'string' || !ref.mimeType))) fail('INVALID_PROVIDER_RESULT', 'Provider must return a file/artifact reference.'); }

export function createMediaMapsAdapters({ providers = {}, credentialResolver } = {}) {
  const definitions = mediaMapsDefinitions({ providers });
  const byName = new Map(Object.entries(CAPABILITIES).map(([kind, spec]) => [spec.name, kind]));
  async function execute(name, args, signal) {
    const kind = byName.get(name); if (!kind) fail('UNKNOWN_TOOL', 'Unknown media/maps tool.');
    const providerId = args?.provider, provider = providers[providerId];
    if (!provider || typeof provider.invoke !== 'function' || typeof credentialResolver !== 'function') fail('UNAVAILABLE', 'Provider is unavailable or credentials are not configured.');
    validateShape(SCHEMAS[kind], args, 'arguments', ['provider', ...requiredFor(kind)]);
    if (signal?.aborted) fail('CANCELLED', 'Tool execution cancelled.');
    const credentials = await credentialResolver(providerId, provider.credentials ?? []);
    if (!credentials || provider.credentials?.some(key => typeof credentials[key] !== 'string' || !credentials[key])) fail('CREDENTIALS_REQUIRED', 'Provider credentials are not configured.');
    const result = await provider.invoke({ kind, args: structuredClone(args), credentials }, signal);
    if (!plain(result) || !plain(result.ref)) fail('INVALID_PROVIDER_RESULT', 'Provider returned no result reference.');
    checkRef(result.ref);
    return { status: 'ok', provider: providerId, result: structuredClone(result) };
  }
  return { definitions, execute, capabilities: Object.keys(CAPABILITIES).map(kind => ({ name: kind, providers: Object.keys(providers) })) };
}
export { CAPABILITIES, SCHEMAS };
