import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaMapsAdapters, mediaMapsDefinitions } from './media-maps-adapters.mjs';
const ref = { kind: 'artifact', id: 'artifact-1', mimeType: 'image/png' };
const provider = { credentials: ['API_KEY'], invoke: async ({ kind }) => ({ ref: { ...ref, id: `${kind}-1` }, metadata: { providerOutput: true } }) };
const adapters = () => createMediaMapsAdapters({ providers: { acme: provider }, credentialResolver: async () => ({ API_KEY: 'secret' }) });
test('definitions are isolated, explicit-provider, and credential-free at schema level', () => {
  const defs = mediaMapsDefinitions({ providers: { acme: provider } });
  assert.equal(defs.length, 9);
  for (const d of defs) { assert.equal(d.type, 'function'); assert.deepEqual(d.function.parameters.properties.provider.enum, ['acme']); assert.equal(d.function.parameters.additionalProperties, false); }
});
test('all contracts require provider and return provider-owned references', async () => {
  const a = adapters();
  const calls = [['media_image', { provider: 'acme', prompt: 'x' }], ['media_video', { provider: 'acme', prompt: 'x' }], ['media_audio', { provider: 'acme', text: 'x' }], ['media_transcribe', { provider: 'acme', inputRef: ref }], ['media_avatar', { provider: 'acme', script: 'x' }], ['maps_geocode', { provider: 'acme', address: 'x' }], ['maps_places', { provider: 'acme', query: 'x' }], ['maps_directions', { provider: 'acme', origin: 'a', destination: 'b' }], ['maps_render', { provider: 'acme' }]];
  for (const [name, args] of calls) { const out = await a.execute(name, args); assert.equal(out.status, 'ok'); assert.equal(out.provider, 'acme'); assert.match(out.result.ref.id, /-1$/); }
});
test('credential gate rejects before provider invocation', async () => {
  let called = false; const a = createMediaMapsAdapters({ providers: { acme: { credentials: ['API_KEY'], invoke: async () => { called = true; return { ref }; } } }, credentialResolver: async () => ({}) });
  await assert.rejects(() => a.execute('media_image', { provider: 'acme', prompt: 'x' }), e => e.code === 'CREDENTIALS_REQUIRED'); assert.equal(called, false);
});
test('provider errors and missing refs are not converted into fake success', async () => {
  const a = createMediaMapsAdapters({ providers: { acme: { invoke: async () => ({}) } }, credentialResolver: async () => ({}) });
  await assert.rejects(() => a.execute('maps_geocode', { provider: 'acme', address: 'x' }), e => e.code === 'INVALID_PROVIDER_RESULT');
});
test('required input fields and nested refs are enforced', async () => {
  const a = adapters();
  await assert.rejects(() => a.execute('media_image', { provider: 'acme' }), e => e.code === 'INVALID_ARGUMENTS');
  await assert.rejects(() => a.execute('media_transcribe', { provider: 'acme', inputRef: { kind: 'artifact' } }), e => e.code === 'INVALID_ARGUMENTS');
});
